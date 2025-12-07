/**
 * Agent Orchestrator
 *
 * Central controller that manages agent execution:
 * - Loads agents from markdown definitions
 * - Manages the execution queue
 * - Runs agents via Claude Agent SDK
 * - Handles spawn requests with depth limiting
 * - Enforces permissions
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import fs from 'fs/promises';
import { loadAgent, buildSystemPrompt, hasPermission, loadAllAgents } from './agent-loader.js';
import { AgentQueue, Status, Priority } from './queue.js';
import { DocumentScanner, AgentStatus, parseTrigger, shouldTriggerFire } from './document-scanner.js';
import { SessionManager } from './session-manager.js';
import { loadAgentContext, formatContextForPrompt } from './context-loader.js';

// Agent types
export const AgentType = {
  DOC: 'doc',           // Runs ON a specific document
  STANDALONE: 'standalone', // Runs independently, gathers own context
  CHATBOT: 'chatbot'    // Persistent conversation
};

/**
 * Default orchestrator configuration
 */
const DEFAULT_CONFIG = {
  maxDepth: 3,           // Max agent spawn depth
  maxConcurrent: 1,      // Max concurrent agent executions
  defaultTimeout: 300,   // Default timeout in seconds
  persistQueue: true     // Persist queue to disk
};

/**
 * Agent Orchestrator class
 */
export class Orchestrator {
  constructor(vaultPath, config = {}) {
    this.vaultPath = vaultPath;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize queue
    this.queue = new AgentQueue({
      maxSize: 100,
      persistPath: this.config.persistQueue
        ? path.join(vaultPath, '.queue', 'queue.json')
        : null,
      keepCompleted: 50
    });

    // Track running executions
    this.running = new Map();

    // Processing state
    this.isProcessing = false;

    // Document scanner
    this.documentScanner = new DocumentScanner(vaultPath);

    // Session manager for chatbot agents
    this.sessionManager = new SessionManager(vaultPath);
  }

  /**
   * Initialize the orchestrator
   */
  async initialize() {
    // Load persisted queue
    await this.queue.load();

    // Initialize session manager
    await this.sessionManager.initialize();

    // Start processing loop
    this.startProcessingLoop();

    // Start document trigger loop
    this.startTriggerLoop();

    // Start session cleanup loop
    this.startSessionCleanupLoop();

    console.log('[Orchestrator] Initialized');
  }

  /**
   * Enqueue an agent for execution
   *
   * @param {string} agentPath - Path to agent markdown file
   * @param {object} context - Execution context
   * @param {object} options - Queue options
   * @returns {Promise<string>} Queue item ID
   */
  async enqueue(agentPath, context = {}, options = {}) {
    // Check depth limit
    const depth = options.depth || 0;
    if (depth >= this.config.maxDepth) {
      throw new Error(`Max spawn depth (${this.config.maxDepth}) reached`);
    }

    // Load agent definition
    const agent = await loadAgent(agentPath, this.vaultPath);

    // Add to queue
    const item = this.queue.enqueue({
      agentPath,
      agent,
      context,
      priority: options.priority || Priority.NORMAL,
      depth,
      spawnedBy: options.spawnedBy || null,
      scheduledFor: options.scheduledFor || null
    });

    console.log(`[Orchestrator] Enqueued: ${agent.name} (${item.id})`);

    // Trigger processing
    this.processQueue();

    return item.id;
  }

  /**
   * Run an agent immediately (bypass queue)
   *
   * @param {string} agentPath - Path to agent or null for vault agent
   * @param {string} message - User message
   * @param {object} additionalContext - Extra context (documentPath for doc agents)
   * @returns {Promise<object>} Execution result
   */
  async runImmediate(agentPath, message, additionalContext = {}) {
    let agent;
    let systemPrompt;

    if (agentPath) {
      // Load specific agent
      agent = await loadAgent(agentPath, this.vaultPath);
      systemPrompt = buildSystemPrompt(agent, additionalContext);

      // Load context/knowledge if agent has context configuration
      if (agent.context && (agent.context.knowledge_file || agent.context.include)) {
        try {
          const contextResult = await loadAgentContext(agent.context, this.vaultPath, {
            max_tokens: agent.context.max_tokens
          });
          if (contextResult.content) {
            systemPrompt += formatContextForPrompt(contextResult);
            console.log(`[Orchestrator] Loaded ${contextResult.files.length} context files (~${contextResult.totalTokens} tokens)`);
          }
        } catch (e) {
          console.warn(`[Orchestrator] Failed to load context for ${agent.name}:`, e.message);
        }
      }
    } else {
      // Use default vault agent
      agent = this.createVaultAgent();
      systemPrompt = await this.buildVaultSystemPrompt(additionalContext);
    }

    // Determine agent type - default to chatbot for interactive use
    const agentType = agent.type || AgentType.CHATBOT;

    switch (agentType) {
      case AgentType.CHATBOT:
        // Use session-based execution for conversation continuity
        return this.executeChatbotAgent(agent, agentPath, message, systemPrompt, additionalContext);

      case AgentType.DOC:
        // Doc agents require a document - include document content in message
        if (additionalContext.documentPath) {
          const doc = await this.readDocument(additionalContext.documentPath);
          if (doc) {
            const docMessage = `Process this document: ${additionalContext.documentPath}\n\n---\n${doc.body}\n---\n\n${message || 'Process this document.'}`;
            return this.executeAgent(agent, docMessage, systemPrompt, 0);
          }
        }
        // Fall through if no document provided
        return this.executeAgent(agent, message, systemPrompt, 0);

      case AgentType.STANDALONE:
      default:
        // Standalone agents run independently
        return this.executeAgent(agent, message || 'Execute your primary function.', systemPrompt, 0);
    }
  }

  /**
   * Execute a chatbot agent with session continuity
   */
  async executeChatbotAgent(agent, agentPath, message, systemPrompt, context) {
    const effectivePath = agentPath || 'vault-agent';

    // For chatbot agents, don't include documentPath in session key
    // Chatbots have global sessions, not per-document sessions
    const chatbotContext = {}; // Intentionally empty - chatbots don't use document context for sessions

    // Get or create session
    const session = await this.sessionManager.getSession(effectivePath, chatbotContext);
    const sessionKey = this.sessionManager.getSessionKey(effectivePath, chatbotContext);

    console.log(`[Orchestrator] Chat session: ${session.id} for ${effectivePath}`);

    // Add user message to local history
    await this.sessionManager.addMessage(sessionKey, 'user', message);

    const startTime = Date.now();
    let result = '';
    let spawnRequests = [];
    let toolCalls = [];

    try {
      // Build query options
      const queryOptions = {
        systemPrompt,
        cwd: this.vaultPath,
        permissionMode: 'acceptEdits'
      };

      // Add allowedTools if specified
      const tools = agent.permissions?.tools || agent.tools;
      if (tools && Array.isArray(tools) && tools.length > 0) {
        queryOptions.allowedTools = tools;
      }

      // If we have a previous SDK session ID, resume it
      // Must be a valid UUID string (not null, undefined, empty, or "[object Object]")
      const sdkId = session.sdkSessionId;
      const isValidSessionId = sdkId &&
        typeof sdkId === 'string' &&
        sdkId.length > 0 &&
        sdkId !== '[object Object]' &&
        !sdkId.startsWith('[object');

      if (isValidSessionId) {
        queryOptions.resume = sdkId;
        console.log(`[Orchestrator] Resuming session: ${sdkId}`);
      }

      console.log(`[Orchestrator] Query options:`, JSON.stringify({
        ...queryOptions,
        systemPrompt: systemPrompt ? `[${systemPrompt.length} chars]` : null
      }, null, 2));

      // Execute via Claude Agent SDK
      const response = query({
        prompt: message,
        options: queryOptions
      });

      // Collect response and capture session ID
      let capturedSessionId = null;

      for await (const msg of response) {
        // Try to capture session ID from messages
        if (msg.session_id) {
          capturedSessionId = msg.session_id;
        }

        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              result = block.text;
            }
            // Capture tool calls
            if (block.type === 'tool_use') {
              toolCalls.push({
                name: block.name,
                input: block.input
              });
            }
          }
        } else if (msg.type === 'result') {
          if (msg.result) {
            result = msg.result;
          }
          // Session ID might be in the result
          if (msg.session_id) {
            capturedSessionId = msg.session_id;
          }
        }
      }

      // Update session with SDK session ID if we captured one
      if (capturedSessionId && capturedSessionId !== session.sdkSessionId) {
        await this.sessionManager.updateSdkSessionId(sessionKey, capturedSessionId);
        console.log(`[Orchestrator] Stored SDK session ID: ${capturedSessionId}`);
      }

      // Add assistant response to local history
      await this.sessionManager.addMessage(sessionKey, 'assistant', result);

      // Parse spawn requests from response
      spawnRequests = this.parseSpawnRequests(result, agent, 0);

      // Process spawn requests
      for (const spawn of spawnRequests) {
        if (this.config.maxDepth > 1) {
          await this.enqueue(spawn.agent, {
            userMessage: spawn.message,
            parentContext: { parentAgent: agent.name, parentResult: result }
          }, {
            depth: 1,
            priority: spawn.priority || Priority.NORMAL
          });
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[Orchestrator] Chat completed: ${effectivePath} in ${duration}ms (${toolCalls.length} tool calls)`);

      return {
        success: true,
        response: result,
        spawned: spawnRequests.map(s => s.agent),
        durationMs: duration,
        sessionId: session.id,
        messageCount: session.messages.length,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      };

    } catch (error) {
      console.error(`[Orchestrator] Chat error ${effectivePath}:`, error.message);
      console.error(`[Orchestrator] Error stack:`, error.stack);
      if (error.cause) {
        console.error(`[Orchestrator] Error cause:`, error.cause);
      }

      // Add error to history
      await this.sessionManager.addMessage(sessionKey, 'system', `Error: ${error.message}`);

      return {
        success: false,
        error: error.message,
        response: '',
        spawned: [],
        durationMs: Date.now() - startTime,
        sessionId: session.id
      };
    }
  }

  /**
   * Clear a chat session (start fresh)
   */
  async clearChatSession(agentPath, context = {}) {
    await this.sessionManager.clearSession(agentPath || 'vault-agent', context);
  }

  /**
   * Get chat history for an agent
   */
  getChatHistory(agentPath, context = {}) {
    const sessionKey = this.sessionManager.getSessionKey(agentPath || 'vault-agent', context);
    return this.sessionManager.getMessages(sessionKey);
  }

  /**
   * List all chat sessions
   */
  listChatSessions() {
    return this.sessionManager.listSessions();
  }

  /**
   * Get a specific session by ID
   */
  getSessionById(sessionId) {
    return this.sessionManager.getSessionById(sessionId);
  }

  /**
   * Create a default vault agent for general queries
   */
  createVaultAgent() {
    return {
      name: 'vault-agent',
      description: 'General vault assistant',
      model: 'sonnet',
      tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissions: {
        read: ['*'],
        write: ['*'],
        spawn: ['agents/*'],
        tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep']
      },
      constraints: {
        max_spawns: 3,
        timeout: 300
      },
      spawns: [],
      systemPrompt: ''
    };
  }

  /**
   * Build system prompt for vault agent
   */
  async buildVaultSystemPrompt(context = {}) {
    // Get vault overview
    const agents = await loadAllAgents(this.vaultPath);
    const files = await this.listVaultFiles();

    let prompt = `You are an intelligent agent managing an Obsidian knowledge vault.

VAULT LOCATION: ${this.vaultPath}

AVAILABLE AGENTS:
${agents.map(a => `- ${a.path}: ${a.description || a.name}`).join('\n') || '(none defined yet)'}

VAULT FILES (${files.length} total):
${files.slice(0, 30).join('\n')}
${files.length > 30 ? `\n... and ${files.length - 30} more` : ''}

You can:
- Read, search, and modify documents in the vault
- Spawn other agents for specialized tasks

Be helpful and concise. When the user asks questions, search the vault for relevant context.`;

    // Add spawn instructions
    if (agents.length > 0) {
      prompt += `\n\n## Spawning Agents
To delegate to a specialized agent, include:
\`\`\`spawn
{"agent": "agents/name.md", "message": "task description"}
\`\`\``;
    }

    // Add any additional context
    if (context.documentPath) {
      const doc = await this.readDocument(context.documentPath);
      if (doc) {
        prompt += `\n\n## Current Document Context: ${context.documentPath}
${doc.body}`;
      }
    }

    return prompt;
  }

  /**
   * Execute an agent
   *
   * @param {AgentDefinition} agent
   * @param {string} message
   * @param {string} systemPrompt
   * @param {number} depth
   * @returns {Promise<object>}
   */
  async executeAgent(agent, message, systemPrompt, depth) {
    console.log(`[Orchestrator] Executing: ${agent.name} (depth: ${depth})`);

    const startTime = Date.now();
    let result = '';
    let spawnRequests = [];

    try {
      // Build query options
      const queryOptions = {
        systemPrompt,
        cwd: this.vaultPath,
        allowedTools: agent.permissions?.tools || agent.tools,
        permissionMode: 'acceptEdits'
      };

      // Pass model if specified in agent definition
      if (agent.model) {
        queryOptions.model = agent.model;
      }

      // Execute via Claude Agent SDK
      const response = query({
        prompt: message,
        options: queryOptions
      });

      // Collect response
      for await (const msg of response) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              result = block.text;
            }
          }
        } else if (msg.type === 'result') {
          if (msg.result) {
            result = msg.result;
          }
        }
      }

      // Parse spawn requests from response
      spawnRequests = this.parseSpawnRequests(result, agent, depth);

      // Process spawn requests
      for (const spawn of spawnRequests) {
        if (depth + 1 < this.config.maxDepth) {
          await this.enqueue(spawn.agent, {
            userMessage: spawn.message,
            parentContext: { parentAgent: agent.name, parentResult: result }
          }, {
            depth: depth + 1,
            priority: spawn.priority || Priority.NORMAL
          });
        } else {
          console.warn(`[Orchestrator] Spawn blocked: max depth reached`);
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[Orchestrator] Completed: ${agent.name} in ${duration}ms`);

      return {
        success: true,
        response: result,
        spawned: spawnRequests.map(s => s.agent),
        durationMs: duration
      };

    } catch (error) {
      console.error(`[Orchestrator] Error executing ${agent.name}:`, error);

      return {
        success: false,
        error: error.message,
        response: '',
        spawned: [],
        durationMs: Date.now() - startTime
      };
    }
  }

  /**
   * Parse spawn requests from agent response
   *
   * @param {string} response
   * @param {AgentDefinition} agent
   * @param {number} depth
   * @returns {SpawnRequest[]}
   */
  parseSpawnRequests(response, agent, depth) {
    const requests = [];
    const spawnRegex = /```spawn\n([\s\S]*?)```/g;

    let match;
    while ((match = spawnRegex.exec(response)) !== null) {
      try {
        const spawnData = JSON.parse(match[1].trim());

        // Validate spawn permission
        if (!hasPermission(agent, 'spawn', spawnData.agent)) {
          console.warn(`[Orchestrator] Spawn denied: ${agent.name} cannot spawn ${spawnData.agent}`);
          continue;
        }

        requests.push({
          agent: spawnData.agent,
          message: spawnData.message || 'Execute your primary function',
          priority: spawnData.priority || Priority.NORMAL,
          context: spawnData.context || {}
        });

      } catch (e) {
        console.warn('[Orchestrator] Failed to parse spawn request:', e.message);
      }
    }

    return requests;
  }

  /**
   * Process the queue
   */
  async processQueue() {
    if (this.isProcessing) return;
    if (this.running.size >= this.config.maxConcurrent) return;
    if (!this.queue.hasPending()) return;

    this.isProcessing = true;

    try {
      while (
        this.running.size < this.config.maxConcurrent &&
        this.queue.hasPending()
      ) {
        const item = this.queue.getNext();
        if (!item) break;

        // Mark as running
        this.queue.markRunning(item.id);
        this.running.set(item.id, item);

        // Execute (don't await - allow concurrent processing)
        this.executeQueueItem(item).finally(() => {
          this.running.delete(item.id);
          // Trigger next processing
          setTimeout(() => this.processQueue(), 100);
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a queue item
   */
  async executeQueueItem(item) {
    const { agent, context, depth } = item;

    try {
      let systemPrompt = buildSystemPrompt(agent, context);

      // Load context/knowledge if agent has context configuration
      if (agent.context && (agent.context.knowledge_file || agent.context.include)) {
        try {
          const contextResult = await loadAgentContext(agent.context, this.vaultPath, {
            max_tokens: agent.context.max_tokens
          });
          if (contextResult.content) {
            systemPrompt += formatContextForPrompt(contextResult);
            console.log(`[Orchestrator] Loaded ${contextResult.files.length} context files for ${agent.name}`);
          }
        } catch (e) {
          console.warn(`[Orchestrator] Failed to load context for ${agent.name}:`, e.message);
        }
      }

      let message = context.userMessage || 'Execute your primary function.';

      // Handle doc agents - include document content in message
      const agentType = agent.type || AgentType.STANDALONE;
      if (agentType === AgentType.DOC && context.documentPath) {
        const doc = await this.readDocument(context.documentPath);
        if (doc) {
          message = `Process this document: ${context.documentPath}\n\n---\n${doc.body}\n---\n\n${message}`;
          console.log(`[Orchestrator] Doc agent processing: ${context.documentPath}`);
        }
      }

      const result = await this.executeAgent(agent, message, systemPrompt, depth);

      if (result.success) {
        this.queue.markCompleted(item.id, result);
        // Save as markdown log
        await this.saveAgentLog(item, result);
      } else {
        this.queue.markFailed(item.id, result.error);
      }

      return result;

    } catch (error) {
      this.queue.markFailed(item.id, error);
      throw error;
    }
  }

  /**
   * Save an agent run as a markdown log file
   */
  async saveAgentLog(item, result) {
    try {
      const logsPath = path.join(this.vaultPath, 'agent-logs');
      const today = new Date().toISOString().split('T')[0];
      const dayPath = path.join(logsPath, today);

      await fs.mkdir(dayPath, { recursive: true });

      const agentName = item.agentPath.replace('agents/', '').replace('.md', '');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

      let fileName = `${timestamp}-${agentName}`;
      if (item.context?.documentPath) {
        const docName = item.context.documentPath.replace(/\//g, '-').replace('.md', '');
        fileName += `-on-${docName}`;
      }
      fileName += '.md';

      const filePath = path.join(dayPath, fileName);

      const durationMs = result.durationMs || 0;
      const durationSec = (durationMs / 1000).toFixed(1);

      let markdown = `---
run_id: "${item.id}"
agent: "${item.agentPath}"
agent_name: "${agentName}"
type: "${item.agent?.type || 'standalone'}"
status: "${result.success ? 'completed' : 'failed'}"
timestamp: "${new Date().toISOString()}"
duration_ms: ${durationMs}
duration: "${durationSec}s"
`;

      if (item.context?.documentPath) {
        markdown += `target_document: "${item.context.documentPath}"\n`;
      }

      markdown += `---

# Agent Run: ${agentName}

`;

      if (item.context?.documentPath) {
        markdown += `> Target: [[${item.context.documentPath}]]\n\n`;
      }

      markdown += `## Result

${result.response || 'No response'}

---

*Completed in ${durationSec}s*
`;

      await fs.writeFile(filePath, markdown, 'utf-8');
      console.log(`[Orchestrator] Saved log: ${filePath}`);

    } catch (e) {
      console.error('[Orchestrator] Failed to save agent log:', e.message);
    }
  }

  /**
   * Start background processing loop
   */
  startProcessingLoop() {
    setInterval(() => {
      this.processQueue();
    }, 5000); // Check every 5 seconds
  }

  /**
   * List vault files
   */
  async listVaultFiles(dir = this.vaultPath, files = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await this.listVaultFiles(fullPath, files);
      } else if (entry.name.endsWith('.md')) {
        files.push(path.relative(this.vaultPath, fullPath));
      }
    }

    return files;
  }

  /**
   * Read a document
   */
  async readDocument(relativePath) {
    const fullPath = path.join(this.vaultPath, relativePath);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const matter = await import('gray-matter');
      const { data: frontmatter, content: body } = matter.default(content);
      return { path: relativePath, frontmatter, body, raw: content };
    } catch (e) {
      return null;
    }
  }

  /**
   * Get queue state
   */
  getQueueState() {
    return this.queue.getState();
  }

  /**
   * Get all loaded agents
   */
  async getAgents() {
    return loadAllAgents(this.vaultPath);
  }

  // ============================================================================
  // DOCUMENT PROCESSING
  // ============================================================================

  /**
   * Start the trigger check loop
   * Checks documents with waiting status for trigger conditions
   */
  startTriggerLoop() {
    setInterval(async () => {
      await this.checkTriggers();
    }, 60000); // Check every minute

    // Also check immediately on startup
    setTimeout(() => this.checkTriggers(), 5000);
  }

  /**
   * Start the session cleanup loop
   * Cleans up old/stale chat sessions periodically
   */
  startSessionCleanupLoop() {
    // Run cleanup once per hour
    setInterval(async () => {
      try {
        const cleaned = await this.sessionManager.cleanupOldSessions();
        if (cleaned > 0) {
          console.log(`[Orchestrator] Cleaned up ${cleaned} old sessions`);
        }
      } catch (error) {
        console.error('[Orchestrator] Error cleaning sessions:', error);
      }
    }, 60 * 60 * 1000); // Every hour

    // Also run cleanup on startup (after 30 seconds)
    setTimeout(async () => {
      try {
        const cleaned = await this.sessionManager.cleanupOldSessions();
        if (cleaned > 0) {
          console.log(`[Orchestrator] Initial cleanup: ${cleaned} old sessions`);
        }
      } catch (error) {
        console.error('[Orchestrator] Error in initial cleanup:', error);
      }
    }, 30000);
  }

  /**
   * Check all document triggers and update statuses
   */
  async checkTriggers() {
    try {
      // Find all agent-document pairs whose triggers should fire
      const triggered = await this.documentScanner.findTriggeredAgents();

      for (const pair of triggered) {
        console.log(`[Orchestrator] Trigger fired: ${pair.agentPath} on ${pair.documentPath}`);
        await this.documentScanner.updateAgentStatus(
          pair.documentPath,
          pair.agentPath,
          AgentStatus.NEEDS_RUN
        );
      }

      // Process any agents that need running
      await this.processTriggeredAgents();

    } catch (error) {
      console.error('[Orchestrator] Error checking triggers:', error);
    }
  }

  /**
   * Process all agent-document pairs with needs_run status
   */
  async processTriggeredAgents() {
    const pairs = await this.documentScanner.findNeedsRun();

    for (const pair of pairs) {
      console.log(`[Orchestrator] Queueing: ${pair.agentPath} for ${pair.documentPath}`);

      // Update status to running
      await this.documentScanner.updateAgentStatus(
        pair.documentPath,
        pair.agentPath,
        AgentStatus.RUNNING
      );

      // Queue the agent to run on this document
      await this.enqueue(pair.agentPath, {
        documentPath: pair.documentPath,
        documentContent: pair.document.body,
        documentFrontmatter: pair.document.frontmatter,
        userMessage: `Process the document at: ${pair.documentPath}`
      }, {
        priority: Priority.NORMAL,
        documentPath: pair.documentPath,  // Track for status updates
        agentPath: pair.agentPath
      });
    }
  }

  /**
   * Run all pending agents on a document
   */
  async runAllAgentsOnDocument(documentPath) {
    const pending = await this.documentScanner.getPendingAgents(documentPath);
    const results = [];

    for (const agentConfig of pending) {
      results.push(await this.runAgentOnDocument(documentPath, agentConfig.path));
    }

    return results;
  }

  /**
   * Run specific agents on a document
   */
  async runAgentsOnDocument(documentPath, agentPaths) {
    const results = [];

    for (const agentPath of agentPaths) {
      results.push(await this.runAgentOnDocument(documentPath, agentPath));
    }

    return results;
  }

  /**
   * Run a single agent on a document
   */
  async runAgentOnDocument(documentPath, agentPath) {
    const fullPath = path.join(this.vaultPath, documentPath);
    const doc = await this.documentScanner.parseDocument(fullPath);

    // Update status to running
    await this.documentScanner.updateAgentStatus(documentPath, agentPath, AgentStatus.RUNNING);

    try {
      // Load the agent
      const agent = await loadAgent(agentPath, this.vaultPath);

      // Build context with the document content
      const systemPrompt = buildSystemPrompt(agent, {
        documentPath,
        documentContent: doc.body,
        documentFrontmatter: doc.frontmatter
      });

      // Execute
      const result = await this.executeAgent(
        agent,
        `Process the document at: ${documentPath}\n\nDocument content:\n${doc.body}`,
        systemPrompt,
        0
      );

      // Update status to completed
      await this.documentScanner.updateAgentStatus(documentPath, agentPath, AgentStatus.COMPLETED, {
        last_result: result.success ? 'success' : 'error'
      });

      return { documentPath, agentPath, ...result };

    } catch (error) {
      await this.documentScanner.updateAgentStatus(documentPath, agentPath, AgentStatus.ERROR, {
        last_error: error.message
      });
      return { documentPath, agentPath, success: false, error: error.message };
    }
  }

  /**
   * Process a specific document with its first/primary agent (legacy support)
   */
  async processDocument(documentPath) {
    const doc = await this.documentScanner.parseDocument(
      path.join(this.vaultPath, documentPath)
    );

    if (!doc.agent) {
      throw new Error(`Document ${documentPath} has no agent assigned`);
    }

    return this.runAgentOnDocument(documentPath, doc.agent);
  }

  /**
   * Manually trigger all agents on a document
   */
  async triggerDocument(documentPath) {
    const triggered = await this.documentScanner.triggerAllAgents(documentPath);
    if (triggered.length > 0) {
      await this.processTriggeredAgents();
    }
    return triggered;
  }

  /**
   * Manually trigger specific agents on a document
   */
  async triggerDocumentAgents(documentPath, agentPaths) {
    const triggered = await this.documentScanner.triggerAgents(documentPath, agentPaths);
    if (triggered.length > 0) {
      await this.processTriggeredAgents();
    }
    return triggered;
  }

  /**
   * Reset agents on a document to pending
   */
  async resetDocumentAgents(documentPath, agentPaths = null) {
    return this.documentScanner.resetAgents(documentPath, agentPaths);
  }

  /**
   * Get pending agents for a document
   */
  async getPendingAgents(documentPath) {
    return this.documentScanner.getPendingAgents(documentPath);
  }

  /**
   * Get document statistics
   */
  async getDocumentStats() {
    return this.documentScanner.getStats();
  }

  /**
   * Get all documents with agent configurations
   */
  async getAgentDocuments() {
    return this.documentScanner.scanAll();
  }

  /**
   * Get agents configured for a specific document
   */
  async getDocumentAgents(documentPath) {
    const fullPath = path.join(this.vaultPath, documentPath);
    const doc = await this.documentScanner.parseDocument(fullPath);
    return doc.agents;
  }

  /**
   * Update agents configured for a document
   */
  async updateDocumentAgents(documentPath, agents) {
    return this.documentScanner.updateDocumentAgents(documentPath, agents);
  }
}

export default Orchestrator;
