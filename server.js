/**
 * Obsidian Agent Pilot Server
 *
 * Express server that provides:
 * - REST API for agent orchestration
 * - Web interface for vault interaction
 * - Queue management and monitoring
 */

import express from 'express';
import { marked } from 'marked';
import path from 'path';
import { fileURLToPath } from 'url';

import { Orchestrator } from './lib/orchestrator.js';
import { listVaultFiles, readDocument, searchVault } from './lib/vault-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
  port: process.env.PORT || 3333,
  host: process.env.HOST || '0.0.0.0',  // Bind to all interfaces for Tailscale access
  vaultPath: process.env.VAULT_PATH || path.join(__dirname, 'sample-vault'),
};

const app = express();
app.use(express.json());

// CORS - allow requests from Obsidian plugin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Initialize orchestrator
const orchestrator = new Orchestrator(CONFIG.vaultPath, {
  maxDepth: 3,
  maxConcurrent: 1,
  persistQueue: true
});

// ============================================================================
// VAULT OPERATIONS (using shared vault-utils)
// ============================================================================

// Helper wrappers that use CONFIG.vaultPath
async function getVaultFiles() {
  return listVaultFiles(CONFIG.vaultPath);
}

async function getDocument(relativePath) {
  return readDocument(CONFIG.vaultPath, relativePath);
}

async function findInVault(queryStr) {
  return searchVault(CONFIG.vaultPath, queryStr);
}

// ============================================================================
// API ROUTES
// ============================================================================

/**
 * POST /api/chat
 * Chat with vault agent or specific document agent
 * Sessions are maintained automatically for conversation continuity
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, agentPath, documentPath, sessionId } = req.body;

    console.log(`[API] Chat request: agent=${agentPath}, sessionId=${sessionId}`);

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Build context - use sessionId as context key for unique sessions
    const context = {};
    if (sessionId) {
      context.sessionId = sessionId;
    }
    if (documentPath) {
      context.documentPath = documentPath;
    }

    // Run agent
    const result = await orchestrator.runImmediate(
      agentPath || null,
      message,
      context
    );

    res.json({
      response: result.response,
      spawned: result.spawned,
      durationMs: result.durationMs,
      agentPath: agentPath || null,
      documentPath: documentPath || null,
      sessionId: result.sessionId || null,
      messageCount: result.messageCount || 0,
      toolCalls: result.toolCalls || undefined,
      permissionDenials: result.permissionDenials || undefined,
      sessionResume: result.sessionResume || undefined,
      debug: result.debug || undefined
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat/sessions
 * List all chat sessions
 */
app.get('/api/chat/sessions', async (req, res) => {
  try {
    const sessions = orchestrator.listChatSessions();
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat/history
 * Get chat history for an agent
 */
app.get('/api/chat/history', async (req, res) => {
  try {
    const { agentPath, documentPath } = req.query;
    const context = documentPath ? { documentPath } : {};
    const history = orchestrator.getChatHistory(agentPath || null, context);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat/session/:id
 * Get a specific session by ID (including messages)
 */
app.get('/api/chat/session/:id', async (req, res) => {
  try {
    const session = await orchestrator.getSessionByIdAsync(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({
      id: session.id,
      agentPath: session.agentPath,
      agentName: session.agentPath.replace('agents/', '').replace('.md', ''),
      messages: session.messages,
      createdAt: session.createdAt,
      lastAccessed: session.lastAccessed
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/chat/session
 * Clear a chat session (start fresh)
 */
app.delete('/api/chat/session', async (req, res) => {
  try {
    const { agentPath, documentPath } = req.query;
    const context = documentPath ? { documentPath } : {};
    await orchestrator.clearChatSession(agentPath || null, context);
    res.json({ cleared: true, agentPath: agentPath || 'vault-agent' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/chat/session/:id/archive
 * Archive a chat session
 */
app.post('/api/chat/session/:id/archive', async (req, res) => {
  try {
    const archived = await orchestrator.archiveSession(req.params.id);
    if (archived) {
      res.json({ archived: true, id: req.params.id });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/chat/session/:id/unarchive
 * Unarchive a chat session
 */
app.post('/api/chat/session/:id/unarchive', async (req, res) => {
  try {
    const unarchived = await orchestrator.unarchiveSession(req.params.id);
    if (unarchived) {
      res.json({ unarchived: true, id: req.params.id });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/chat/session/:id
 * Delete a chat session permanently
 */
app.delete('/api/chat/session/:id', async (req, res) => {
  try {
    const deleted = await orchestrator.deleteSessionById(req.params.id);
    if (deleted) {
      res.json({ deleted: true, id: req.params.id });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/agents/spawn
 * Spawn an agent (add to queue)
 */
app.post('/api/agents/spawn', async (req, res) => {
  try {
    const { agentPath, message, context, priority, scheduledFor } = req.body;

    if (!agentPath) {
      return res.status(400).json({ error: 'agentPath is required' });
    }

    const queueId = await orchestrator.enqueue(
      agentPath,
      { userMessage: message, ...context },
      { priority, scheduledFor }
    );

    res.json({
      queued: true,
      queueId,
      agentPath
    });

  } catch (error) {
    console.error('Spawn error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/agents
 * List all defined agents
 */
app.get('/api/agents', async (req, res) => {
  try {
    const agents = await orchestrator.getAgents();
    res.json(agents.map(a => ({
      name: a.name,
      path: a.path,
      description: a.description,
      type: a.type || 'chatbot',
      model: a.model,
      triggers: a.triggers
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/queue
 * Get queue state
 */
app.get('/api/queue', async (req, res) => {
  try {
    const state = orchestrator.getQueueState();
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/stats
 * Get system stats for debugging
 */
app.get('/api/stats', async (req, res) => {
  try {
    const sessionStats = orchestrator.getSessionStats();
    const queueState = orchestrator.getQueueState();

    res.json({
      sessions: sessionStats,
      queue: {
        pending: queueState.pending?.length || 0,
        running: queueState.running?.length || 0,
        completed: queueState.completed?.length || 0
      },
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/permissions
 * Get pending permission requests
 */
app.get('/api/permissions', async (req, res) => {
  try {
    const pending = orchestrator.getPendingPermissions();
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/permissions/:id/grant
 * Grant a permission request
 */
app.post('/api/permissions/:id/grant', async (req, res) => {
  try {
    const granted = orchestrator.grantPermission(req.params.id);
    if (granted) {
      res.json({ granted: true, id: req.params.id });
    } else {
      res.status(404).json({ error: 'Permission request not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/permissions/:id/deny
 * Deny a permission request
 */
app.post('/api/permissions/:id/deny', async (req, res) => {
  try {
    const denied = orchestrator.denyPermission(req.params.id);
    if (denied) {
      res.json({ denied: true, id: req.params.id });
    } else {
      res.status(404).json({ error: 'Permission request not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/permissions/stream
 * SSE endpoint for real-time permission request notifications
 */
app.get('/api/permissions/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial connection message
  res.write('data: {"type":"connected"}\n\n');

  // Listen for permission requests
  const onPermissionRequest = (request) => {
    res.write(`data: ${JSON.stringify({ type: 'permissionRequest', request })}\n\n`);
  };

  const onPermissionGranted = (request) => {
    res.write(`data: ${JSON.stringify({ type: 'permissionGranted', request })}\n\n`);
  };

  const onPermissionDenied = (request) => {
    res.write(`data: ${JSON.stringify({ type: 'permissionDenied', request })}\n\n`);
  };

  orchestrator.on('permissionRequest', onPermissionRequest);
  orchestrator.on('permissionGranted', onPermissionGranted);
  orchestrator.on('permissionDenied', onPermissionDenied);

  // Send any existing pending permissions
  const pending = orchestrator.getPendingPermissions();
  for (const request of pending) {
    res.write(`data: ${JSON.stringify({ type: 'permissionRequest', request })}\n\n`);
  }

  // Cleanup on close
  req.on('close', () => {
    orchestrator.off('permissionRequest', onPermissionRequest);
    orchestrator.off('permissionGranted', onPermissionGranted);
    orchestrator.off('permissionDenied', onPermissionDenied);
  });
});

/**
 * POST /api/queue/process
 * Trigger queue processing
 */
app.post('/api/queue/process', async (req, res) => {
  try {
    await orchestrator.processQueue();
    const state = orchestrator.getQueueState();
    res.json({
      message: 'Processing triggered',
      ...state
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/documents
 * List all documents
 */
app.get('/api/documents', async (req, res) => {
  try {
    const files = await getVaultFiles();
    const documents = [];

    for (const file of files) {
      const doc = await getDocument(file);
      if (!doc) continue;
      documents.push({
        path: file,
        title: doc.frontmatter.title || path.basename(file, '.md'),
        agents: doc.frontmatter.agents || [],
        tags: doc.frontmatter.tags || [],
        preview: doc.body.substring(0, 200)
      });
    }

    res.json(documents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/documents/agent-config
 * List all documents with agent configurations
 */
app.get('/api/documents/agent-config', async (req, res) => {
  try {
    const docs = await orchestrator.getAgentDocuments();
    res.json(docs.map(d => ({
      path: d.path,
      agent: d.agent,
      status: d.status,
      trigger: d.triggerRaw,
      lastRun: d.lastRun,
      context: d.context
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/documents/stats
 * Get document processing statistics
 */
app.get('/api/documents/stats', async (req, res) => {
  try {
    const stats = await orchestrator.getDocumentStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/documents/:path/agents
 * Get all agents configured for a document
 */
app.get('/api/documents/*/agents', async (req, res) => {
  try {
    const docPath = req.params[0];
    const agents = await orchestrator.getDocumentAgents(docPath);
    res.json(agents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/documents/:path/agents
 * Update agents configured for a document
 * Body: { agents: [{ path, trigger?, enabled? }] }
 */
app.put('/api/documents/*/agents', async (req, res) => {
  try {
    const docPath = req.params[0];
    const { agents } = req.body;

    if (!Array.isArray(agents)) {
      return res.status(400).json({ error: 'agents must be an array' });
    }

    await orchestrator.updateDocumentAgents(docPath, agents);
    const updated = await orchestrator.getDocumentAgents(docPath);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/documents/:path/agents/pending
 * Get pending agents for a document
 */
app.get('/api/documents/*/agents/pending', async (req, res) => {
  try {
    const docPath = req.params[0];
    const agents = await orchestrator.getPendingAgents(docPath);
    res.json(agents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/documents/:path/run-agents
 * Run agents on a document
 * Body: { agents?: string[] } - if omitted, runs all pending
 */
app.post('/api/documents/*/run-agents', async (req, res) => {
  try {
    const docPath = req.params[0];
    const { agents } = req.body;

    let results;
    if (agents && agents.length > 0) {
      results = await orchestrator.runAgentsOnDocument(docPath, agents);
    } else {
      results = await orchestrator.runAllAgentsOnDocument(docPath);
    }

    res.json({
      documentPath: docPath,
      results,
      ran: results.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/documents/:path/reset-agents
 * Reset agents to pending status
 * Body: { agents?: string[] } - if omitted, resets all
 */
app.post('/api/documents/*/reset-agents', async (req, res) => {
  try {
    const docPath = req.params[0];
    const { agents } = req.body;

    const reset = await orchestrator.resetDocumentAgents(docPath, agents);
    res.json({
      documentPath: docPath,
      reset,
      count: reset.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/documents/trigger/:path
 * Manually trigger all agents on a document for processing
 */
app.post('/api/documents/trigger/*', async (req, res) => {
  try {
    const docPath = req.params[0];
    const { agents } = req.body;

    let triggered;
    if (agents && agents.length > 0) {
      triggered = await orchestrator.triggerDocumentAgents(docPath, agents);
    } else {
      triggered = await orchestrator.triggerDocument(docPath);
    }

    res.json({ triggered: triggered, path: docPath, count: triggered.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/documents/process/:path
 * Process a document immediately (runs first/primary agent - legacy)
 */
app.post('/api/documents/process/*', async (req, res) => {
  try {
    const docPath = req.params[0];
    const result = await orchestrator.processDocument(docPath);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/documents/:path
 * Get a specific document (MUST be after specific routes)
 */
app.get('/api/documents/*', async (req, res) => {
  try {
    const docPath = req.params[0];
    const doc = await getDocument(docPath);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json({
      ...doc,
      html: marked(doc.body)
    });
  } catch (error) {
    res.status(404).json({ error: 'Document not found' });
  }
});

/**
 * GET /api/search
 * Search the vault
 */
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    const results = await findInVault(q || '');
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/vault
 * Get vault info
 */
app.get('/api/vault', async (req, res) => {
  try {
    const files = await getVaultFiles();
    const agents = await orchestrator.getAgents();

    res.json({
      path: CONFIG.vaultPath,
      totalDocuments: files.length,
      totalAgents: agents.length,
      documents: files
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/triggers/check
 * Manually check all triggers
 */
app.post('/api/triggers/check', async (req, res) => {
  try {
    await orchestrator.checkTriggers();
    const stats = await orchestrator.getDocumentStats();
    res.json({ checked: true, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

async function start() {
  // Initialize orchestrator
  await orchestrator.initialize();

  app.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           🧠 Obsidian Agent Pilot Server                      ║
║         (Claude Agent SDK + Orchestrator)                     ║
╠═══════════════════════════════════════════════════════════════╣
║  Server:  http://${CONFIG.host}:${CONFIG.port}                              ║
║  Vault:   ${CONFIG.vaultPath.substring(0, 45).padEnd(45)}   ║
╠═══════════════════════════════════════════════════════════════╣
║  Endpoints:                                                   ║
║    POST /api/chat            - Chat with agent                ║
║    POST /api/agents/spawn    - Spawn agent (queue)            ║
║    GET  /api/agents          - List defined agents            ║
║    GET  /api/queue           - View queue state               ║
║    POST /api/queue/process   - Trigger queue processing       ║
║    GET  /api/documents       - List documents                 ║
║    GET  /api/search?q=       - Search vault                   ║
║                                                               ║
║  Access via Tailscale from any device!                        ║
╚═══════════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);
