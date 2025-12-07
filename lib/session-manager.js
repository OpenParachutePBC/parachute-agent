/**
 * Session Manager
 *
 * Manages conversation sessions for agents.
 * Sessions are stored as markdown files in the vault for:
 * - Syncing with Obsidian Sync
 * - Human readability
 * - Searchability within Obsidian
 * - Cross-machine session resumption
 */

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export class SessionManager {
  constructor(vaultPath) {
    this.vaultPath = vaultPath;
    this.chatsPath = path.join(vaultPath, 'agent-chats');
    this.logsPath = path.join(vaultPath, 'agent-logs');
    this.sessions = new Map(); // In-memory cache
    this.activeSessions = new Map(); // Active SDK session objects
  }

  /**
   * Initialize session manager
   */
  async initialize() {
    // Ensure directories exist
    await fs.mkdir(this.chatsPath, { recursive: true });
    await fs.mkdir(this.logsPath, { recursive: true });

    // Load existing sessions from markdown files
    await this.loadSessions();
  }

  /**
   * Load sessions from markdown files
   */
  async loadSessions() {
    try {
      // Load chat sessions from agent-chats/
      await this.loadSessionsFromDir(this.chatsPath);
      console.log(`[SessionManager] Loaded ${this.sessions.size} sessions from markdown`);
    } catch (e) {
      console.log('[SessionManager] No existing sessions found');
    }
  }

  /**
   * Recursively load sessions from a directory
   */
  async loadSessionsFromDir(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await this.loadSessionsFromDir(fullPath);
        } else if (entry.name.endsWith('.md')) {
          await this.loadSessionFromFile(fullPath);
        }
      }
    } catch (e) {
      // Directory doesn't exist yet
    }
  }

  /**
   * Load a session from a markdown file
   */
  async loadSessionFromFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const session = this.parseSessionMarkdown(content, filePath);

      if (session) {
        this.sessions.set(session.key, session);
        console.log(`[SessionManager] Loaded session: ${session.key} (${session.messages.length} messages) from ${path.basename(filePath)}`);
      } else {
        console.log(`[SessionManager] Skipped file (no session_id): ${path.basename(filePath)}`);
      }
    } catch (e) {
      console.error(`[SessionManager] Error loading session from ${filePath}:`, e.message);
    }
  }

  /**
   * Parse a session from markdown format
   */
  parseSessionMarkdown(content, filePath) {
    const matter = this.parseFrontmatter(content);
    if (!matter.data.session_id) return null;

    const messages = this.parseMessages(matter.body);

    // Validate sdkSessionId when loading from file
    const rawSdkId = matter.data.sdk_session_id;
    const validatedSdkId = this.validateSdkSessionId(rawSdkId);

    return {
      id: matter.data.session_id,
      key: matter.data.session_key,
      agentPath: matter.data.agent,
      context: matter.data.context || {},
      sdkSessionId: validatedSdkId,
      messages,
      filePath,
      createdAt: matter.data.created_at,
      lastAccessed: matter.data.last_accessed
    };
  }

  /**
   * Parse frontmatter from markdown
   */
  parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      return { data: {}, body: content };
    }

    const yamlStr = match[1];
    const body = match[2];

    // Simple YAML parser for our use case
    const data = {};
    for (const line of yamlStr.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();

        // Handle quoted strings
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        // Handle objects (simple case) - but NOT for sdk_session_id which should stay as string
        if (key !== 'sdk_session_id' && (value === '' || value === '{}')) {
          value = {};
        }
        // Keep empty strings as null for sdk_session_id
        if (key === 'sdk_session_id' && value === '') {
          value = null;
        }

        data[key] = value;
      }
    }

    return { data, body };
  }

  /**
   * Parse messages from markdown body
   */
  parseMessages(body) {
    const messages = [];
    // Match timestamps with or without milliseconds (e.g., 2025-12-07T04:39:47.485Z or 2025-12-07T04:39:47Z)
    const regex = /### (User|Assistant|System) \| (\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\n\n([\s\S]*?)(?=\n### |\n---|\n## |$)/g;

    let match;
    while ((match = regex.exec(body)) !== null) {
      messages.push({
        role: match[1].toLowerCase(),
        timestamp: match[2],
        content: match[3].trim()
      });
    }

    return messages;
  }

  /**
   * Generate session key from agent path and optional context
   */
  getSessionKey(agentPath, context = {}) {
    const contextKey = context.documentPath || 'default';
    return `${agentPath}:${contextKey}`;
  }

  /**
   * Get the file path for a session
   */
  getSessionFilePath(agentPath, context = {}) {
    const agentName = agentPath.replace('agents/', '').replace('.md', '');
    const today = new Date().toISOString().split('T')[0];

    if (context.documentPath) {
      // Doc-specific session
      const docName = context.documentPath.replace(/\//g, '-').replace('.md', '');
      return path.join(this.chatsPath, agentName, `${today}-${docName}.md`);
    } else {
      // General session
      return path.join(this.chatsPath, agentName, `${today}.md`);
    }
  }

  /**
   * Get or create a session for an agent
   */
  async getSession(agentPath, context = {}) {
    const key = this.getSessionKey(agentPath, context);
    console.log(`[SessionManager] getSession called for key: ${key}`);

    if (this.sessions.has(key)) {
      const session = this.sessions.get(key);
      session.lastAccessed = new Date().toISOString();
      await this.saveSession(session);
      console.log(`[SessionManager] Returning existing session: ${session.id} (${session.messages.length} messages)`);
      return session;
    }

    // Create new session
    const filePath = this.getSessionFilePath(agentPath, context);

    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const session = {
      id: randomUUID(),
      key,
      agentPath,
      context,
      sdkSessionId: null,
      messages: [],
      filePath,
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString()
    };

    this.sessions.set(key, session);
    await this.saveSession(session);

    console.log(`[SessionManager] Created new session: ${session.id} at ${filePath}`);
    return session;
  }

  /**
   * Save session to markdown file
   */
  async saveSession(session) {
    try {
      // Ensure directory exists before writing
      await fs.mkdir(path.dirname(session.filePath), { recursive: true });
      const markdown = this.sessionToMarkdown(session);
      await fs.writeFile(session.filePath, markdown, 'utf-8');
      console.log(`[SessionManager] Saved session to ${session.filePath}`);
    } catch (e) {
      console.error(`[SessionManager] Failed to save session to ${session.filePath}:`, e.message);
    }
  }

  /**
   * Validate that a value is a valid SDK session ID
   * Returns the value if valid, or null if invalid
   */
  validateSdkSessionId(value) {
    // Must be a non-empty string that doesn't look like a stringified object
    if (!value || typeof value !== 'string') {
      return null;
    }
    if (value.length === 0) {
      return null;
    }
    if (value === '[object Object]' || value.startsWith('[object')) {
      console.warn(`[SessionManager] Rejecting invalid sdkSessionId: ${value}`);
      return null;
    }
    return value;
  }

  /**
   * Convert session to markdown format
   */
  sessionToMarkdown(session) {
    const agentName = session.agentPath.replace('agents/', '').replace('.md', '');

    // Validate sdkSessionId before saving
    const validatedSdkId = this.validateSdkSessionId(session.sdkSessionId) || '';

    let md = `---
session_id: "${session.id}"
session_key: "${session.key}"
agent: "${session.agentPath}"
agent_name: "${agentName}"
type: chat
created_at: "${session.createdAt}"
last_accessed: "${session.lastAccessed}"
sdk_session_id: "${validatedSdkId}"
---

# Chat with ${agentName}

`;

    if (session.context?.documentPath) {
      md += `> Context: [[${session.context.documentPath}]]\n\n`;
    }

    md += `## Conversation\n\n`;

    for (const msg of session.messages) {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      const timestamp = msg.timestamp || new Date().toISOString();
      md += `### ${role} | ${timestamp}\n\n${msg.content}\n\n`;
    }

    return md;
  }

  /**
   * Update session with SDK session ID
   */
  async updateSdkSessionId(sessionKey, sdkSessionId) {
    const session = this.sessions.get(sessionKey);
    if (session) {
      // Validate before storing
      session.sdkSessionId = this.validateSdkSessionId(sdkSessionId);
      await this.saveSession(session);
    }
  }

  /**
   * Add a message to session history
   */
  async addMessage(sessionKey, role, content) {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.messages.push({
        role,
        content,
        timestamp: new Date().toISOString()
      });
      session.lastAccessed = new Date().toISOString();
      await this.saveSession(session);
      console.log(`[SessionManager] Added ${role} message to session ${sessionKey} (now ${session.messages.length} messages)`);
    } else {
      console.error(`[SessionManager] Cannot add message - session not found: ${sessionKey}`);
    }
  }

  /**
   * Get message history for a session
   */
  getMessages(sessionKey) {
    const session = this.sessions.get(sessionKey);
    return session?.messages || [];
  }

  /**
   * Clear a session (archive old, start fresh)
   */
  async clearSession(agentPath, context = {}) {
    const key = this.getSessionKey(agentPath, context);

    if (this.sessions.has(key)) {
      const session = this.sessions.get(key);

      // Close active SDK session if any
      if (this.activeSessions.has(key)) {
        const activeSession = this.activeSessions.get(key);
        try {
          activeSession.close();
        } catch (e) {
          // Ignore close errors
        }
        this.activeSessions.delete(key);
      }

      // Archive old file by renaming with timestamp
      if (session.messages.length > 0) {
        const archivePath = session.filePath.replace('.md', `-${Date.now()}.md`);
        try {
          await fs.rename(session.filePath, archivePath);
        } catch (e) {
          // Ignore if file doesn't exist
        }
      }

      // Reset session
      session.sdkSessionId = null;
      session.messages = [];
      session.lastAccessed = new Date().toISOString();
      session.filePath = this.getSessionFilePath(agentPath, context);

      await this.saveSession(session);
      console.log(`[SessionManager] Cleared session: ${key}`);
    }
  }

  /**
   * Delete a session entirely
   */
  async deleteSession(agentPath, context = {}) {
    const key = this.getSessionKey(agentPath, context);

    if (this.activeSessions.has(key)) {
      const activeSession = this.activeSessions.get(key);
      try {
        activeSession.close();
      } catch (e) {
        // Ignore
      }
      this.activeSessions.delete(key);
    }

    const session = this.sessions.get(key);
    if (session?.filePath) {
      try {
        await fs.unlink(session.filePath);
      } catch (e) {
        // Ignore if file doesn't exist
      }
    }

    this.sessions.delete(key);
    console.log(`[SessionManager] Deleted session: ${key}`);
  }

  /**
   * List all sessions
   */
  listSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      agentPath: s.agentPath,
      agentName: s.agentPath.replace('agents/', '').replace('.md', ''),
      messageCount: s.messages.length,
      createdAt: s.createdAt,
      lastAccessed: s.lastAccessed,
      filePath: s.filePath.replace(this.vaultPath + '/', ''),
      context: s.context
    }));
  }

  /**
   * Get session by ID
   */
  getSessionById(sessionId) {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId) {
        return session;
      }
    }
    return null;
  }

  /**
   * Store active SDK session object
   */
  setActiveSession(sessionKey, sdkSession) {
    this.activeSessions.set(sessionKey, sdkSession);
  }

  /**
   * Get active SDK session object
   */
  getActiveSession(sessionKey) {
    return this.activeSessions.get(sessionKey);
  }

  /**
   * Clean up old sessions (archive sessions older than N days)
   */
  async cleanupOldSessions(maxAgeDays = 30) {
    // For markdown storage, we keep files but could archive old ones
    // For now, just log
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    let oldCount = 0;

    for (const session of this.sessions.values()) {
      const lastAccessed = new Date(session.lastAccessed).getTime();
      if (lastAccessed < cutoff) {
        oldCount++;
      }
    }

    if (oldCount > 0) {
      console.log(`[SessionManager] ${oldCount} sessions older than ${maxAgeDays} days`);
    }

    return 0; // Don't actually delete - keep for history
  }
}

export default SessionManager;
