import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Notice, TFile, Modal, MarkdownView, MarkdownRenderer, Component } from 'obsidian';

// ============================================================================
// SETTINGS
// ============================================================================

interface AgentPilotSettings {
  orchestratorUrl: string;
  showAgentBadges: boolean;
  autoRefreshQueue: boolean;
  refreshInterval: number;
}

const DEFAULT_SETTINGS: AgentPilotSettings = {
  orchestratorUrl: 'http://localhost:3333',
  showAgentBadges: true,
  autoRefreshQueue: true,
  refreshInterval: 3000,
};

// ============================================================================
// MAIN VIEW (Tabbed: Chat | Agents | Activity)
// ============================================================================

const PILOT_VIEW_TYPE = 'agent-pilot-view';

type ViewTab = 'chat' | 'agents' | 'activity';

interface ToolCall {
  name: string;
  input?: Record<string, any>;
  result?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  agentPath?: string;
  toolCalls?: ToolCall[];
}

interface ChatSession {
  id: string;
  name: string;
  agentPath: string | null;
  messages: ChatMessage[];
  createdAt: Date;
}

interface QueueItem {
  id: string;
  agentPath: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  context?: {
    documentPath?: string;
    userMessage?: string;
  };
  result?: {
    success: boolean;
    response: string;
    durationMs: number;
  };
  error?: string;
}

interface AgentInfo {
  name: string;
  path: string;
  description: string;
  type?: string;
  model: string;
}

class AgentPilotView extends ItemView {
  private plugin: AgentPilotPlugin;
  private currentTab: ViewTab = 'chat';
  private containerEl: HTMLElement;

  // Chat state - sessions
  private sessions: ChatSession[] = [];
  private currentSessionId: string | null = null;
  private isLoading: boolean = false;

  // Queue state
  private queueState: { running: QueueItem[]; completed: QueueItem[]; pending: QueueItem[] } = {
    running: [],
    completed: [],
    pending: []
  };

  // Agents state
  private agents: AgentInfo[] = [];

  // Refresh interval
  private refreshTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AgentPilotPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return PILOT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Agent Pilot';
  }

  getIcon(): string {
    return 'bot';
  }

  async onOpen(): Promise<void> {
    this.containerEl = this.contentEl;
    this.containerEl.empty();
    this.containerEl.addClass('agent-pilot-view');

    this.addStyles();
    this.render();

    // Start auto-refresh
    if (this.plugin.settings.autoRefreshQueue) {
      this.startAutoRefresh();
    }

    // Initial data load
    await this.loadAgents();
    await this.loadSessions();
    await this.refreshQueue();
  }

  async onClose(): Promise<void> {
    this.stopAutoRefresh();
  }

  private startAutoRefresh(): void {
    this.refreshTimer = window.setInterval(() => {
      this.refreshQueue();
    }, this.plugin.settings.refreshInterval);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private render(): void {
    this.containerEl.empty();

    // Header with tabs
    const header = this.containerEl.createDiv({ cls: 'pilot-header' });

    const tabs = header.createDiv({ cls: 'pilot-tabs' });
    this.createTab(tabs, 'chat', 'Chat');
    this.createTab(tabs, 'agents', 'Agents');
    this.createTab(tabs, 'activity', 'Activity');

    // Content area
    const content = this.containerEl.createDiv({ cls: 'pilot-content' });

    switch (this.currentTab) {
      case 'chat':
        this.renderChatTab(content);
        break;
      case 'agents':
        this.renderAgentsTab(content);
        break;
      case 'activity':
        this.renderActivityTab(content);
        break;
    }
  }

  private createTab(container: HTMLElement, tab: ViewTab, label: string): void {
    const tabEl = container.createEl('button', {
      cls: `pilot-tab ${this.currentTab === tab ? 'active' : ''}`,
      text: label
    });

    // Add badge for activity tab
    if (tab === 'activity' && this.queueState.running.length > 0) {
      tabEl.createEl('span', {
        cls: 'pilot-badge',
        text: String(this.queueState.running.length)
      });
    }

    tabEl.addEventListener('click', () => {
      this.currentTab = tab;
      this.render();
    });
  }

  // ============================================================================
  // CHAT TAB - Session Management
  // ============================================================================

  private getCurrentSession(): ChatSession | null {
    if (!this.currentSessionId) return null;
    return this.sessions.find(s => s.id === this.currentSessionId) || null;
  }

  private createSession(agentPath: string | null): ChatSession {
    const agent = this.agents.find(a => a.path === agentPath);
    const agentName = agent?.name || (agentPath ? agentPath.replace('agents/', '').replace('.md', '') : 'Vault Agent');

    const session: ChatSession = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      name: agentName,
      agentPath,
      messages: [],
      createdAt: new Date()
    };

    this.sessions.push(session);
    this.currentSessionId = session.id;
    return session;
  }

  private deleteSession(sessionId: string): void {
    const idx = this.sessions.findIndex(s => s.id === sessionId);
    if (idx >= 0) {
      this.sessions.splice(idx, 1);
      if (this.currentSessionId === sessionId) {
        this.currentSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
      }
    }
  }

  /**
   * Load existing sessions from the server
   */
  private async loadSessions(): Promise<void> {
    try {
      const response = await fetch(`${this.plugin.settings.orchestratorUrl}/api/chat/sessions`);
      const serverSessions = await response.json();

      // Convert server sessions to plugin format
      this.sessions = serverSessions.map((s: any) => ({
        id: s.id,
        name: s.agentName || 'Chat',
        agentPath: s.agentPath === 'vault-agent' ? null : s.agentPath,
        messages: [], // Messages are loaded on-demand when switching to the session
        createdAt: new Date(s.createdAt)
      }));

      // Sort by most recent first
      this.sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      console.log(`[Agent Pilot] Loaded ${this.sessions.length} sessions from server`);
      this.render();
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  }

  /**
   * Load message history for a session from the server by session ID
   */
  private async loadSessionHistory(session: ChatSession): Promise<void> {
    try {
      const response = await fetch(
        `${this.plugin.settings.orchestratorUrl}/api/chat/session/${encodeURIComponent(session.id)}`
      );

      if (!response.ok) {
        console.error('Failed to load session:', response.status);
        return;
      }

      const data = await response.json();

      // Convert server history to plugin format
      session.messages = (data.messages || []).map((msg: any) => ({
        role: msg.role,
        content: msg.content,
        timestamp: new Date(msg.timestamp || Date.now()),
        agentPath: msg.agentPath
      }));

      console.log(`[Agent Pilot] Loaded ${session.messages.length} messages for session ${session.id}`);
      this.render();
    } catch (e) {
      console.error('Failed to load session history:', e);
    }
  }

  private renderChatTab(container: HTMLElement): void {
    const chatbotAgents = this.agents.filter(a => a.type === 'chatbot' || !a.type);
    const session = this.getCurrentSession();

    // Session sidebar
    const chatLayout = container.createDiv({ cls: 'pilot-chat-layout' });

    // Left: Session list
    const sessionList = chatLayout.createDiv({ cls: 'pilot-session-list' });

    // New chat button
    const newChatBtn = sessionList.createEl('button', {
      text: '+ New Chat',
      cls: 'pilot-new-chat-btn'
    });
    newChatBtn.addEventListener('click', () => {
      this.createSession(null);
      this.render();
    });

    // List of sessions
    const sessionsContainer = sessionList.createDiv({ cls: 'pilot-sessions' });

    if (this.sessions.length === 0) {
      sessionsContainer.createDiv({ cls: 'pilot-sessions-empty', text: 'No chats yet' });
    } else {
      for (const s of this.sessions) {
        const sessionItem = sessionsContainer.createDiv({
          cls: `pilot-session-item ${s.id === this.currentSessionId ? 'active' : ''}`
        });

        const sessionInfo = sessionItem.createDiv({ cls: 'pilot-session-info' });
        sessionInfo.createEl('span', { text: s.name, cls: 'pilot-session-name' });

        const msgCount = s.messages.filter(m => m.role !== 'system').length;
        if (msgCount > 0) {
          sessionInfo.createEl('span', {
            text: `${msgCount} msg${msgCount > 1 ? 's' : ''}`,
            cls: 'pilot-session-count'
          });
        }

        sessionItem.addEventListener('click', async () => {
          this.currentSessionId = s.id;
          // Load history if not already loaded
          if (s.messages.length === 0) {
            await this.loadSessionHistory(s);
          } else {
            this.render();
          }
        });

        // Delete button
        const deleteBtn = sessionItem.createEl('button', { text: '×', cls: 'pilot-session-delete' });
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Clear server session
          try {
            await fetch(`${this.plugin.settings.orchestratorUrl}/api/chat/session?agentPath=${s.agentPath || ''}`, {
              method: 'DELETE'
            });
          } catch (e) { /* ignore */ }
          this.deleteSession(s.id);
          this.render();
        });
      }
    }

    // Right: Chat area
    const chatArea = chatLayout.createDiv({ cls: 'pilot-chat-area' });

    if (!session) {
      // No session selected - show welcome / agent picker
      const welcome = chatArea.createDiv({ cls: 'pilot-welcome' });
      welcome.createEl('h3', { text: 'Start a new chat' });
      welcome.createEl('p', { text: 'Select an agent to begin:', cls: 'pilot-welcome-hint' });

      const agentGrid = welcome.createDiv({ cls: 'pilot-agent-grid' });

      // Default vault agent
      const vaultCard = agentGrid.createDiv({ cls: 'pilot-agent-pick' });
      vaultCard.createEl('span', { text: 'Vault Agent', cls: 'pilot-pick-name' });
      vaultCard.createEl('span', { text: 'General assistant', cls: 'pilot-pick-desc' });
      vaultCard.addEventListener('click', () => {
        this.createSession(null);
        this.render();
      });

      // Chatbot agents
      for (const agent of chatbotAgents) {
        const card = agentGrid.createDiv({ cls: 'pilot-agent-pick' });
        card.createEl('span', { text: agent.name, cls: 'pilot-pick-name' });
        card.createEl('span', { text: agent.description?.substring(0, 60) || '', cls: 'pilot-pick-desc' });
        card.addEventListener('click', () => {
          this.createSession(agent.path);
          this.render();
        });
      }
      return;
    }

    // Current session header
    const sessionHeader = chatArea.createDiv({ cls: 'pilot-session-header' });
    sessionHeader.createEl('span', { text: session.name, cls: 'pilot-session-title' });

    // Show agent description
    if (session.agentPath) {
      const agent = this.agents.find(a => a.path === session.agentPath);
      if (agent?.description) {
        sessionHeader.createEl('span', { text: agent.description, cls: 'pilot-session-desc' });
      }
    }

    // Messages
    const messagesEl = chatArea.createDiv({ cls: 'pilot-messages' });

    if (session.messages.length === 0 && !this.isLoading) {
      messagesEl.createDiv({
        cls: 'pilot-empty',
        text: `Start chatting with ${session.name}`
      });
    } else {
      for (const msg of session.messages) {
        const msgEl = messagesEl.createDiv({
          cls: `pilot-message pilot-message-${msg.role}`
        });
        if (msg.agentPath && msg.role === 'assistant') {
          msgEl.createEl('div', {
            cls: 'pilot-message-agent',
            text: msg.agentPath.replace('agents/', '').replace('.md', '')
          });
        }

        // Render tool calls if present
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const toolsEl = msgEl.createDiv({ cls: 'pilot-tool-calls' });
          for (const tool of msg.toolCalls) {
            const toolEl = toolsEl.createDiv({ cls: 'pilot-tool-call' });
            const toolHeader = toolEl.createDiv({ cls: 'pilot-tool-header' });
            toolHeader.createEl('span', { cls: 'pilot-tool-icon', text: '⚡' });
            toolHeader.createEl('span', { cls: 'pilot-tool-name', text: tool.name });

            // Show input summary if present
            if (tool.input) {
              const inputSummary = this.summarizeToolInput(tool.name, tool.input);
              if (inputSummary) {
                toolHeader.createEl('span', { cls: 'pilot-tool-input', text: inputSummary });
              }
            }
          }
        }

        // Render content as markdown for assistant messages
        const contentEl = msgEl.createDiv({ cls: 'pilot-message-content' });
        if (msg.role === 'assistant' && msg.content) {
          // Get active file path for proper link resolution, fallback to plugin file
          const sourcePath = this.app.workspace.getActiveFile()?.path ?? 'agent-pilot-chat';

          // Create a container for rendered markdown
          const markdownContainer = contentEl.createDiv({ cls: 'pilot-markdown' });

          // Use async render with error handling
          MarkdownRenderer.render(this.app, msg.content, markdownContainer, sourcePath, this)
            .then(() => {
              console.log('[Agent Pilot] Markdown rendered successfully');
            })
            .catch((e: Error) => {
              console.error('[Agent Pilot] Markdown render failed:', e);
              markdownContainer.textContent = msg.content;
            });
        } else {
          contentEl.textContent = msg.content;
        }

        msgEl.createEl('div', {
          cls: 'pilot-message-time',
          text: msg.timestamp.toLocaleTimeString()
        });
      }

      // Show loading indicator
      if (this.isLoading) {
        const loadingEl = messagesEl.createDiv({ cls: 'pilot-message pilot-message-loading' });
        loadingEl.createDiv({ cls: 'pilot-typing-indicator' });
      }
    }

    // Scroll to bottom
    setTimeout(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }, 10);

    // Input
    const inputArea = chatArea.createDiv({ cls: 'pilot-input-area' });
    const textarea = inputArea.createEl('textarea', {
      cls: `pilot-input ${this.isLoading ? 'pilot-input-disabled' : ''}`,
      attr: {
        placeholder: this.isLoading ? 'Waiting for response...' : 'Ask your agents anything...'
      }
    });
    textarea.disabled = this.isLoading;

    textarea.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !this.isLoading) {
        e.preventDefault();
        await this.sendMessage(textarea.value);
        textarea.value = '';
      }
    });

    const sendBtn = inputArea.createEl('button', {
      text: this.isLoading ? 'Sending...' : 'Send',
      cls: `pilot-send ${this.isLoading ? 'pilot-send-disabled' : ''}`
    });
    sendBtn.disabled = this.isLoading;

    sendBtn.addEventListener('click', async () => {
      if (!this.isLoading) {
        await this.sendMessage(textarea.value);
        textarea.value = '';
      }
    });
  }

  private addSystemMessage(content: string): void {
    const session = this.getCurrentSession();
    if (session) {
      session.messages.push({ role: 'system', content, timestamp: new Date() });
    }
    this.render();
  }

  private async sendMessage(content: string): Promise<void> {
    if (!content.trim() || this.isLoading) return;

    const session = this.getCurrentSession();
    if (!session) return;

    session.messages.push({ role: 'user', content, timestamp: new Date() });
    this.isLoading = true;
    this.render();

    const activeFile = this.app.workspace.getActiveFile();

    try {
      const response = await fetch(`${this.plugin.settings.orchestratorUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          agentPath: session.agentPath,
          documentPath: activeFile?.path
        })
      });

      const data = await response.json();

      session.messages.push({
        role: 'assistant',
        content: data.response || data.error || 'No response',
        timestamp: new Date(),
        agentPath: data.agentPath,
        toolCalls: data.toolCalls || undefined
      });

      if (data.spawned?.length > 0) {
        session.messages.push({
          role: 'system',
          content: `Spawned ${data.spawned.length} sub-agent(s)`,
          timestamp: new Date()
        });
      }

    } catch (e) {
      session.messages.push({
        role: 'system',
        content: `Error: ${e.message}`,
        timestamp: new Date()
      });
    } finally {
      this.isLoading = false;
    }

    this.render();
  }

  private async clearSession(): Promise<void> {
    const session = this.getCurrentSession();
    if (!session) return;

    try {
      await fetch(`${this.plugin.settings.orchestratorUrl}/api/chat/session?agentPath=${session.agentPath || ''}`, {
        method: 'DELETE'
      });
      session.messages = [];
      this.addSystemMessage('Session cleared');
    } catch (e) {
      new Notice(`Error: ${e.message}`);
    }
  }

  /**
   * Generate a human-readable summary of tool input based on tool type
   */
  private summarizeToolInput(toolName: string, input: Record<string, any>): string {
    const name = toolName.toLowerCase();

    // File operations
    if (name === 'read' || name.includes('read')) {
      return input.file_path || input.path || '';
    }

    if (name === 'write' || name.includes('write')) {
      return input.file_path || input.path || '';
    }

    if (name === 'edit' || name.includes('edit')) {
      return input.file_path || input.path || '';
    }

    // Search operations
    if (name === 'glob' || name.includes('glob')) {
      return input.pattern || '';
    }

    if (name === 'grep' || name.includes('grep')) {
      return input.pattern || '';
    }

    // Bash commands
    if (name === 'bash' || name.includes('bash')) {
      const cmd = input.command || '';
      // Truncate long commands
      return cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd;
    }

    // Web operations
    if (name.includes('web') || name.includes('fetch')) {
      return input.url || '';
    }

    // Default: try common field names
    return input.file_path || input.path || input.pattern || input.query || '';
  }

  // ============================================================================
  // AGENTS TAB
  // ============================================================================

  private renderAgentsTab(container: HTMLElement): void {
    const header = container.createDiv({ cls: 'pilot-section-header' });
    header.createEl('h3', { text: 'Available Agents' });

    const refreshBtn = header.createEl('button', { text: 'Refresh', cls: 'pilot-btn-small' });
    refreshBtn.addEventListener('click', () => this.loadAgents());

    if (this.agents.length === 0) {
      container.createDiv({ cls: 'pilot-empty', text: 'No agents found in vault' });
      return;
    }

    // Group agents by type
    const docAgents = this.agents.filter(a => a.type === 'doc');
    const standaloneAgents = this.agents.filter(a => a.type === 'standalone');
    const chatbotAgents = this.agents.filter(a => a.type === 'chatbot' || !a.type);

    // Doc agents section
    if (docAgents.length > 0) {
      const section = container.createDiv({ cls: 'pilot-agent-section' });
      section.createEl('h4', { text: 'Document Agents', cls: 'pilot-section-title' });
      section.createEl('p', { text: 'Run on the current document', cls: 'pilot-section-hint' });

      for (const agent of docAgents) {
        this.renderAgentCard(section, agent, 'doc');
      }
    }

    // Standalone agents section
    if (standaloneAgents.length > 0) {
      const section = container.createDiv({ cls: 'pilot-agent-section' });
      section.createEl('h4', { text: 'Standalone Agents', cls: 'pilot-section-title' });
      section.createEl('p', { text: 'Run independently', cls: 'pilot-section-hint' });

      for (const agent of standaloneAgents) {
        this.renderAgentCard(section, agent, 'standalone');
      }
    }

    // Chatbot agents section
    if (chatbotAgents.length > 0) {
      const section = container.createDiv({ cls: 'pilot-agent-section' });
      section.createEl('h4', { text: 'Chatbot Agents', cls: 'pilot-section-title' });
      section.createEl('p', { text: 'Interactive conversation', cls: 'pilot-section-hint' });

      for (const agent of chatbotAgents) {
        this.renderAgentCard(section, agent, 'chatbot');
      }
    }
  }

  private renderAgentCard(container: HTMLElement, agent: AgentInfo, type: string): void {
    const card = container.createDiv({ cls: 'pilot-agent-card' });

    const cardHeader = card.createDiv({ cls: 'pilot-agent-header' });
    cardHeader.createEl('span', { text: agent.name, cls: 'pilot-agent-name' });

    const typeBadge = cardHeader.createEl('span', {
      cls: `pilot-type-badge pilot-type-${type}`,
      text: type
    });

    card.createEl('div', {
      cls: 'pilot-agent-desc',
      text: agent.description?.substring(0, 100) || 'No description'
    });

    const actions = card.createDiv({ cls: 'pilot-agent-actions' });

    switch (type) {
      case 'doc':
        const runDocBtn = actions.createEl('button', { text: 'Run on Current Doc', cls: 'pilot-btn-primary' });
        runDocBtn.addEventListener('click', () => this.runDocAgent(agent.path));
        break;

      case 'standalone':
        const runBtn = actions.createEl('button', { text: 'Run', cls: 'pilot-btn-primary' });
        runBtn.addEventListener('click', () => this.spawnAgent(agent.path));
        break;

      case 'chatbot':
      default:
        const chatBtn = actions.createEl('button', { text: 'Chat', cls: 'pilot-btn-primary' });
        chatBtn.addEventListener('click', () => {
          this.createSession(agent.path);
          this.currentTab = 'chat';
          this.render();
        });
        break;
    }
  }

  /**
   * Start a follow-up conversation from a completed agent run
   */
  private startFollowUp(item: QueueItem): void {
    // Create a new session for this follow-up
    const session = this.createSession(item.agentPath);

    // Build context message about what was processed
    let contextMsg = `Following up on ${item.agentPath.replace('agents/', '').replace('.md', '')}`;
    if (item.context?.documentPath) {
      contextMsg += ` for document: ${item.context.documentPath}`;
    }

    // Add system message about context
    session.messages.push({
      role: 'system',
      content: contextMsg,
      timestamp: new Date()
    });

    // Add the original result as assistant message
    if (item.result?.response) {
      session.messages.push({
        role: 'assistant',
        content: item.result.response,
        timestamp: new Date(item.completedAt || Date.now()),
        agentPath: item.agentPath
      });
    }

    // Switch to chat tab
    this.currentTab = 'chat';
    this.render();

    new Notice('Ready to follow up - type your message below');
  }

  private async runDocAgent(agentPath: string): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !activeFile.path.endsWith('.md')) {
      new Notice('Please open a markdown file first');
      return;
    }

    try {
      // Use spawn endpoint so doc agents appear in activity queue
      const response = await fetch(`${this.plugin.settings.orchestratorUrl}/api/agents/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentPath: agentPath,
          message: 'Process this document.',
          context: {
            documentPath: activeFile.path
          }
        })
      });

      const data = await response.json();

      if (data.error) {
        new Notice(`Error: ${data.error}`);
      } else {
        new Notice(`Running ${agentPath.replace('agents/', '').replace('.md', '')} on ${activeFile.name}`);
        // Switch to activity tab to show progress
        this.currentTab = 'activity';
        await this.refreshQueue();
      }
    } catch (e) {
      new Notice(`Error: ${e.message}`);
    }
  }

  private async loadAgents(): Promise<void> {
    try {
      const response = await fetch(`${this.plugin.settings.orchestratorUrl}/api/agents`);
      this.agents = await response.json();
      // Always re-render to update agent dropdowns
      this.render();
    } catch (e) {
      console.error('Failed to load agents:', e);
    }
  }

  private async spawnAgent(agentPath: string): Promise<void> {
    try {
      const response = await fetch(`${this.plugin.settings.orchestratorUrl}/api/agents/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentPath })
      });

      const data = await response.json();
      new Notice(`Agent queued: ${data.queueId?.substring(0, 8)}...`);

      // Switch to activity tab
      this.currentTab = 'activity';
      await this.refreshQueue();

    } catch (e) {
      new Notice(`Error: ${e.message}`);
    }
  }

  // ============================================================================
  // ACTIVITY TAB
  // ============================================================================

  private renderActivityTab(container: HTMLElement): void {
    const header = container.createDiv({ cls: 'pilot-section-header' });
    header.createEl('h3', { text: 'Agent Activity' });

    const refreshBtn = header.createEl('button', { text: 'Refresh', cls: 'pilot-btn-small' });
    refreshBtn.addEventListener('click', () => this.refreshQueue());

    // Running agents
    if (this.queueState.running.length > 0) {
      const runningSection = container.createDiv({ cls: 'pilot-section' });
      runningSection.createEl('h4', { text: `Running (${this.queueState.running.length})`, cls: 'pilot-section-title running' });

      for (const item of this.queueState.running) {
        this.renderQueueItem(runningSection, item, 'running');
      }
    }

    // Pending agents
    if (this.queueState.pending.length > 0) {
      const pendingSection = container.createDiv({ cls: 'pilot-section' });
      pendingSection.createEl('h4', { text: `Pending (${this.queueState.pending.length})`, cls: 'pilot-section-title pending' });

      for (const item of this.queueState.pending) {
        this.renderQueueItem(pendingSection, item, 'pending');
      }
    }

    // Completed agents
    const completedSection = container.createDiv({ cls: 'pilot-section' });
    completedSection.createEl('h4', { text: `Completed (${this.queueState.completed.length})`, cls: 'pilot-section-title completed' });

    if (this.queueState.completed.length === 0) {
      completedSection.createDiv({ cls: 'pilot-empty', text: 'No completed agents yet' });
    } else {
      // Show most recent first, limit to 10
      const recent = [...this.queueState.completed].reverse().slice(0, 10);
      for (const item of recent) {
        this.renderQueueItem(completedSection, item, 'completed');
      }
    }
  }

  private renderQueueItem(container: HTMLElement, item: QueueItem, status: string): void {
    const card = container.createDiv({ cls: `pilot-queue-item pilot-queue-${status}` });

    const cardHeader = card.createDiv({ cls: 'pilot-queue-header' });

    const agentName = item.agentPath.replace('agents/', '').replace('.md', '');
    cardHeader.createEl('span', { text: agentName, cls: 'pilot-queue-name' });

    const statusBadge = cardHeader.createEl('span', {
      cls: `pilot-status-badge pilot-status-${status}`,
      text: status
    });

    // Show spinner for running
    if (status === 'running') {
      statusBadge.addClass('pilot-spinning');
    }

    // Show target document for doc agents
    if (item.context?.documentPath) {
      card.createEl('div', {
        cls: 'pilot-queue-target',
        text: `→ ${item.context.documentPath}`
      });
    }

    // Timing info
    const timing = card.createDiv({ cls: 'pilot-queue-timing' });
    if (item.result?.durationMs) {
      timing.createEl('span', { text: `${(item.result.durationMs / 1000).toFixed(1)}s` });
    } else if (item.startedAt) {
      const elapsed = Math.floor((Date.now() - new Date(item.startedAt).getTime()) / 1000);
      timing.createEl('span', { text: `${elapsed}s elapsed...`, cls: 'pilot-elapsed' });
    }

    // Result preview for completed
    if (status === 'completed' && item.result?.response) {
      const preview = card.createDiv({ cls: 'pilot-queue-preview' });
      preview.createEl('div', {
        text: item.result.response.substring(0, 200) + (item.result.response.length > 200 ? '...' : ''),
        cls: 'pilot-preview-text'
      });

      // Action buttons
      const btnRow = card.createDiv({ cls: 'pilot-queue-actions' });

      // Expand button
      const expandBtn = btnRow.createEl('button', { text: 'View Full', cls: 'pilot-btn-small' });
      expandBtn.addEventListener('click', () => {
        new ResultModal(this.app, agentName, item.result!.response).open();
      });

      // Follow up button - continue the conversation
      const followUpBtn = btnRow.createEl('button', { text: 'Follow Up', cls: 'pilot-btn-small pilot-btn-followup' });
      followUpBtn.addEventListener('click', () => {
        this.startFollowUp(item);
      });
    }

    // Error for failed
    if (item.error) {
      card.createDiv({ cls: 'pilot-queue-error', text: `Error: ${item.error}` });
    }
  }

  private async refreshQueue(): Promise<void> {
    try {
      const response = await fetch(`${this.plugin.settings.orchestratorUrl}/api/queue`);
      const data = await response.json();

      this.queueState = {
        running: data.running || [],
        completed: data.completed || [],
        pending: data.pending || []
      };

      if (this.currentTab === 'activity') {
        // Preserve scroll position before re-render
        const content = this.containerEl.querySelector('.pilot-content');
        const scrollTop = content?.scrollTop || 0;

        this.render();

        // Restore scroll position after re-render
        const newContent = this.containerEl.querySelector('.pilot-content');
        if (newContent) {
          newContent.scrollTop = scrollTop;
        }
      } else {
        // Just update the badge
        const tabs = this.containerEl.querySelector('.pilot-tabs');
        if (tabs) {
          const activityTab = tabs.querySelectorAll('.pilot-tab')[2];
          const badge = activityTab?.querySelector('.pilot-badge');
          if (badge) {
            badge.textContent = String(this.queueState.running.length);
            badge.toggleClass('hidden', this.queueState.running.length === 0);
          }
        }
      }

    } catch (e) {
      console.error('Failed to refresh queue:', e);
    }
  }

  // ============================================================================
  // STYLES
  // ============================================================================

  private addStyles(): void {
    const styleId = 'agent-pilot-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .agent-pilot-view {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .pilot-header {
        padding: 8px;
        border-bottom: 1px solid var(--background-modifier-border);
      }

      .pilot-tabs {
        display: flex;
        gap: 4px;
      }

      .pilot-tab {
        flex: 1;
        padding: 8px 12px;
        background: var(--background-secondary);
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        position: relative;
      }

      .pilot-tab.active {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
      }

      .pilot-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        background: var(--text-error);
        color: white;
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 10px;
        min-width: 16px;
        text-align: center;
      }

      .pilot-badge.hidden {
        display: none;
      }

      .pilot-content {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
      }

      /* Chat layout with sessions */
      .pilot-chat-layout {
        display: flex;
        flex-direction: column;
        height: 100%;
        gap: 8px;
      }

      .pilot-session-list {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--background-modifier-border);
      }

      .pilot-new-chat-btn {
        padding: 6px 12px;
        background: var(--interactive-accent);
        color: var(--text-on-accent);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
      }

      .pilot-sessions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        flex: 1;
      }

      .pilot-sessions-empty {
        color: var(--text-muted);
        font-size: 11px;
        padding: 4px 8px;
      }

      .pilot-session-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: var(--background-secondary);
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        border: 2px solid transparent;
      }

      .pilot-session-item:hover {
        background: var(--background-modifier-hover);
      }

      .pilot-session-item.active {
        border-color: var(--interactive-accent);
        background: var(--background-secondary-alt);
      }

      .pilot-session-info {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .pilot-session-name {
        font-weight: 500;
        white-space: nowrap;
      }

      .pilot-session-count {
        font-size: 10px;
        opacity: 0.6;
      }

      .pilot-session-delete {
        background: none;
        border: none;
        color: inherit;
        opacity: 0.4;
        cursor: pointer;
        padding: 0;
        font-size: 14px;
        line-height: 1;
      }

      .pilot-session-delete:hover {
        opacity: 1;
      }

      .pilot-chat-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      .pilot-welcome {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        flex: 1;
        text-align: center;
        padding: 20px;
      }

      .pilot-welcome h3 {
        margin: 0 0 8px 0;
      }

      .pilot-welcome-hint {
        color: var(--text-muted);
        margin-bottom: 16px;
      }

      .pilot-agent-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: center;
      }

      .pilot-agent-pick {
        display: flex;
        flex-direction: column;
        padding: 12px 16px;
        background: var(--background-secondary);
        border-radius: 8px;
        cursor: pointer;
        min-width: 100px;
        max-width: 160px;
        border: 2px solid transparent;
      }

      .pilot-agent-pick:hover {
        border-color: var(--interactive-accent);
      }

      .pilot-pick-name {
        font-weight: 600;
        margin-bottom: 4px;
        font-size: 13px;
      }

      .pilot-pick-desc {
        font-size: 10px;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .pilot-session-header {
        padding: 8px 0;
        margin-bottom: 8px;
        border-bottom: 1px solid var(--background-modifier-border);
      }

      .pilot-session-title {
        font-weight: 600;
        font-size: 14px;
      }

      .pilot-session-desc {
        font-size: 11px;
        color: var(--text-muted);
        margin-top: 2px;
      }

      /* Chat styles */
      .pilot-selector-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }

      .pilot-label {
        font-size: 12px;
        color: var(--text-muted);
      }

      .pilot-select {
        flex: 1;
        padding: 4px 8px;
        border-radius: 4px;
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
      }

      .pilot-messages {
        flex: 1;
        min-height: 100px;
        overflow-y: auto;
        margin-bottom: 12px;
        padding-right: 4px;
      }

      .pilot-message {
        margin-bottom: 12px;
        padding: 10px 12px;
        border-radius: 8px;
        max-width: 90%;
      }

      .pilot-message-user {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
        margin-left: auto;
      }

      .pilot-message-assistant {
        background: var(--background-secondary);
      }

      .pilot-message-system {
        background: var(--background-modifier-border);
        font-size: 12px;
        opacity: 0.8;
        text-align: center;
        margin: 8px auto;
        max-width: 100%;
      }

      .pilot-message-agent {
        font-size: 11px;
        opacity: 0.7;
        margin-bottom: 4px;
      }

      .pilot-message-content {
        word-break: break-word;
      }

      /* User messages use pre-wrap for plain text */
      .pilot-message-user .pilot-message-content {
        white-space: pre-wrap;
      }

      /* Rendered markdown container */
      .pilot-markdown {
        line-height: 1.5;
      }

      .pilot-markdown > *:first-child {
        margin-top: 0;
      }

      .pilot-markdown > *:last-child {
        margin-bottom: 0;
      }

      .pilot-message-content p {
        margin: 0 0 8px 0;
      }

      .pilot-message-content p:last-child {
        margin-bottom: 0;
      }

      .pilot-message-content code {
        background: var(--background-primary);
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 12px;
      }

      .pilot-message-content pre {
        background: var(--background-primary);
        padding: 12px;
        border-radius: 6px;
        overflow-x: auto;
        margin: 8px 0;
      }

      .pilot-message-content pre code {
        background: none;
        padding: 0;
      }

      /* Tool calls display */
      .pilot-tool-calls {
        margin-bottom: 8px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .pilot-tool-call {
        display: flex;
        align-items: center;
        padding: 6px 10px;
        background: var(--background-primary);
        border-radius: 6px;
        border-left: 3px solid var(--interactive-accent);
        font-size: 12px;
      }

      .pilot-tool-header {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      .pilot-tool-icon {
        font-size: 12px;
        opacity: 0.8;
      }

      .pilot-tool-name {
        font-weight: 600;
        color: var(--interactive-accent);
      }

      .pilot-tool-input {
        color: var(--text-muted);
        font-family: monospace;
        font-size: 11px;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pilot-message-time {
        font-size: 10px;
        opacity: 0.5;
        margin-top: 4px;
      }

      .pilot-message-loading {
        background: var(--background-secondary);
        padding: 16px;
      }

      .pilot-typing-indicator {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        padding: 4px 0;
      }

      .pilot-typing-indicator::before {
        content: '●  ●  ●';
        font-size: 14px;
        color: var(--text-muted);
        animation: typing-pulse 1.4s infinite ease-in-out;
        letter-spacing: 2px;
      }

      @keyframes typing-pulse {
        0%, 100% {
          opacity: 0.3;
        }
        50% {
          opacity: 1;
        }
      }

      .pilot-agent-info {
        padding: 8px 12px;
        background: var(--background-secondary);
        border-radius: 6px;
        margin-bottom: 12px;
        font-size: 12px;
      }

      .pilot-agent-description {
        color: var(--text-muted);
        font-style: italic;
      }

      .pilot-input-disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .pilot-send-disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .pilot-input-area {
        display: flex;
        gap: 8px;
        align-items: flex-end;
      }

      .pilot-input {
        flex: 1;
        min-height: 44px;
        max-height: 120px;
        padding: 10px 12px;
        border-radius: 8px;
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        resize: none;
        font-size: 14px;
        line-height: 1.4;
      }

      .pilot-input:focus {
        outline: none;
        border-color: var(--interactive-accent);
      }

      .pilot-send {
        padding: 10px 20px;
        background: var(--interactive-accent);
        color: var(--text-on-accent);
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
      }

      .pilot-send:hover {
        opacity: 0.9;
      }

      /* Agent cards */
      .pilot-section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }

      .pilot-section-header h3 {
        margin: 0;
        font-size: 14px;
      }

      .pilot-agent-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .pilot-agent-card {
        padding: 12px;
        background: var(--background-secondary);
        border-radius: 8px;
        border: 1px solid var(--background-modifier-border);
      }

      .pilot-agent-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }

      .pilot-agent-name {
        font-weight: 600;
      }

      .pilot-type-badge {
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 10px;
        text-transform: uppercase;
      }

      .pilot-type-chatbot {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
      }

      .pilot-type-doc {
        background: #22c55e;
        color: white;
      }

      .pilot-type-standalone {
        background: #f59e0b;
        color: white;
      }

      .pilot-agent-section {
        margin-bottom: 20px;
      }

      .pilot-section-hint {
        font-size: 11px;
        color: var(--text-muted);
        margin-bottom: 8px;
      }

      .pilot-agent-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .pilot-agent-desc {
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: 8px;
      }

      .pilot-agent-path {
        font-size: 11px;
        font-family: monospace;
        opacity: 0.6;
        margin-bottom: 8px;
      }

      .pilot-agent-actions {
        display: flex;
        gap: 8px;
      }

      /* Activity/Queue styles */
      .pilot-section {
        margin-bottom: 16px;
      }

      .pilot-section-title {
        font-size: 12px;
        text-transform: uppercase;
        margin-bottom: 8px;
        padding-bottom: 4px;
        border-bottom: 2px solid var(--background-modifier-border);
      }

      .pilot-section-title.running {
        border-color: var(--text-accent);
        color: var(--text-accent);
      }

      .pilot-section-title.completed {
        border-color: var(--text-success);
        color: var(--text-success);
      }

      .pilot-section-title.pending {
        border-color: var(--text-muted);
      }

      .pilot-queue-item {
        padding: 10px;
        background: var(--background-secondary);
        border-radius: 6px;
        margin-bottom: 8px;
        border-left: 3px solid var(--background-modifier-border);
      }

      .pilot-queue-running {
        border-left-color: var(--text-accent);
      }

      .pilot-queue-completed {
        border-left-color: var(--text-success);
      }

      .pilot-queue-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      }

      .pilot-queue-name {
        font-weight: 500;
      }

      .pilot-status-badge {
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 10px;
      }

      .pilot-status-running {
        background: var(--text-accent);
        color: white;
      }

      .pilot-status-completed {
        background: var(--text-success);
        color: white;
      }

      .pilot-status-pending {
        background: var(--text-muted);
        color: white;
      }

      .pilot-spinning::before {
        content: '';
        display: inline-block;
        width: 8px;
        height: 8px;
        border: 2px solid white;
        border-top-color: transparent;
        border-radius: 50%;
        margin-right: 4px;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .pilot-queue-timing {
        font-size: 11px;
        color: var(--text-muted);
      }

      .pilot-elapsed {
        color: var(--text-accent);
      }

      .pilot-queue-preview {
        margin-top: 8px;
        padding: 8px;
        background: var(--background-primary);
        border-radius: 4px;
        font-size: 12px;
      }

      .pilot-preview-text {
        color: var(--text-muted);
        white-space: pre-wrap;
      }

      .pilot-queue-error {
        margin-top: 8px;
        padding: 8px;
        background: rgba(255, 0, 0, 0.1);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-error);
      }

      .pilot-queue-target {
        font-size: 11px;
        color: var(--text-muted);
        font-family: monospace;
        margin-top: 4px;
      }

      .pilot-queue-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }

      .pilot-btn-followup {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
      }

      /* Buttons */
      .pilot-btn-small {
        padding: 4px 12px;
        font-size: 11px;
        background: var(--background-modifier-border);
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }

      .pilot-btn-primary {
        padding: 6px 16px;
        background: var(--interactive-accent);
        color: var(--text-on-accent);
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }

      .pilot-empty {
        text-align: center;
        color: var(--text-muted);
        padding: 20px;
        font-size: 13px;
      }
    `;
    document.head.appendChild(style);
  }
}

// ============================================================================
// RESULT MODAL
// ============================================================================

class ResultModal extends Modal {
  private agentName: string;
  private response: string;

  constructor(app: App, agentName: string, response: string) {
    super(app);
    this.agentName = agentName;
    this.response = response;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: `${this.agentName} Result` });

    const responseEl = contentEl.createDiv({ cls: 'result-response' });
    responseEl.style.cssText = `
      white-space: pre-wrap;
      background: var(--background-secondary);
      padding: 16px;
      border-radius: 8px;
      max-height: 400px;
      overflow-y: auto;
      font-size: 13px;
    `;
    responseEl.textContent = this.response;

    const closeBtn = contentEl.createEl('button', { text: 'Close' });
    closeBtn.style.cssText = `margin-top: 16px; padding: 8px 24px;`;
    closeBtn.addEventListener('click', () => this.close());
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ============================================================================
// SETTINGS TAB
// ============================================================================

class AgentPilotSettingTab extends PluginSettingTab {
  plugin: AgentPilotPlugin;

  constructor(app: App, plugin: AgentPilotPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Agent Pilot Settings' });

    new Setting(containerEl)
      .setName('Orchestrator URL')
      .setDesc('URL of your Agent Pilot orchestrator server')
      .addText(text => text
        .setPlaceholder('http://localhost:3333')
        .setValue(this.plugin.settings.orchestratorUrl)
        .onChange(async (value) => {
          this.plugin.settings.orchestratorUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Auto-refresh Activity')
      .setDesc('Automatically refresh agent activity status')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoRefreshQueue)
        .onChange(async (value) => {
          this.plugin.settings.autoRefreshQueue = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Refresh Interval')
      .setDesc('How often to refresh activity (in milliseconds)')
      .addText(text => text
        .setValue(String(this.plugin.settings.refreshInterval))
        .onChange(async (value) => {
          this.plugin.settings.refreshInterval = parseInt(value) || 3000;
          await this.plugin.saveSettings();
        }));

    // Connection test
    const testContainer = containerEl.createDiv({ cls: 'setting-item' });
    const testBtn = testContainer.createEl('button', { text: 'Test Connection' });
    const statusEl = testContainer.createEl('span');
    statusEl.style.marginLeft = '10px';

    testBtn.addEventListener('click', async () => {
      statusEl.textContent = 'Testing...';
      try {
        const response = await fetch(`${this.plugin.settings.orchestratorUrl}/api/vault`);
        if (response.ok) {
          const data = await response.json();
          statusEl.textContent = `Connected! ${data.totalDocuments} docs, ${data.totalAgents} agents`;
          statusEl.style.color = 'var(--text-success)';
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (e) {
        statusEl.textContent = `Failed: ${e.message}`;
        statusEl.style.color = 'var(--text-error)';
      }
    });
  }
}

// ============================================================================
// MAIN PLUGIN
// ============================================================================

export default class AgentPilotPlugin extends Plugin {
  settings: AgentPilotSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register main view
    this.registerView(
      PILOT_VIEW_TYPE,
      (leaf) => new AgentPilotView(leaf, this)
    );

    // Add ribbon icon
    this.addRibbonIcon('bot', 'Agent Pilot', () => {
      this.activateView();
    });

    // Commands
    this.addCommand({
      id: 'open-pilot',
      name: 'Open Agent Pilot',
      callback: () => this.activateView()
    });

    this.addCommand({
      id: 'run-agent',
      name: 'Run Agent',
      callback: () => new QuickSpawnModal(this.app, this).open()
    });

    this.addCommand({
      id: 'run-agents',
      name: 'Run Agents on Current Document',
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !activeFile.path.endsWith('.md')) {
          new Notice('Please open a markdown file first');
          return;
        }
        new RunAgentsModal(this.app, this, activeFile.path).open();
      }
    });

    this.addCommand({
      id: 'manage-agents',
      name: 'Manage Document Agents',
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !activeFile.path.endsWith('.md')) {
          new Notice('Please open a markdown file first');
          return;
        }
        new ManageAgentsModal(this.app, this, activeFile.path).open();
      }
    });

    // Settings tab
    this.addSettingTab(new AgentPilotSettingTab(this.app, this));

    console.log('Agent Pilot plugin loaded');
  }

  async onunload(): Promise<void> {
    console.log('Agent Pilot plugin unloaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(PILOT_VIEW_TYPE)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: PILOT_VIEW_TYPE, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

}

// ============================================================================
// QUICK SPAWN MODAL
// ============================================================================

class QuickSpawnModal extends Modal {
  private plugin: AgentPilotPlugin;

  constructor(app: App, plugin: AgentPilotPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Run Agent' });

    const activeFile = this.app.workspace.getActiveFile();

    try {
      const response = await fetch(`${this.plugin.settings.orchestratorUrl}/api/agents`);
      const agents = await response.json();

      const docAgents = agents.filter((a: any) => a.type === 'doc');
      const standaloneAgents = agents.filter((a: any) => a.type === 'standalone');

      // Doc agents section
      if (docAgents.length > 0) {
        contentEl.createEl('h3', { text: 'Document Agents', cls: 'quick-spawn-section' });
        if (activeFile) {
          contentEl.createEl('p', {
            text: `Will run on: ${activeFile.name}`,
            cls: 'quick-spawn-hint'
          });
        } else {
          contentEl.createEl('p', {
            text: 'Open a document first to run these',
            cls: 'quick-spawn-hint'
          });
        }

        for (const agent of docAgents) {
          const btn = contentEl.createEl('button', {
            text: agent.name,
            cls: activeFile ? 'mod-cta' : ''
          });
          btn.style.cssText = 'display: block; width: 100%; margin-bottom: 8px;';
          if (!activeFile) btn.disabled = true;

          btn.addEventListener('click', async () => {
            if (!activeFile) return;
            // Use spawn endpoint so doc agents appear in activity queue
            await fetch(`${this.plugin.settings.orchestratorUrl}/api/agents/spawn`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agentPath: agent.path,
                message: 'Process this document.',
                context: { documentPath: activeFile.path }
              })
            });
            new Notice(`Running ${agent.name} on ${activeFile.name}`);
            this.close();
          });
        }
      }

      // Standalone agents section
      if (standaloneAgents.length > 0) {
        contentEl.createEl('h3', { text: 'Standalone Agents', cls: 'quick-spawn-section' });

        for (const agent of standaloneAgents) {
          const btn = contentEl.createEl('button', {
            text: agent.name,
            cls: 'mod-cta'
          });
          btn.style.cssText = 'display: block; width: 100%; margin-bottom: 8px;';
          btn.addEventListener('click', async () => {
            await fetch(`${this.plugin.settings.orchestratorUrl}/api/agents/spawn`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentPath: agent.path })
            });
            new Notice(`Running: ${agent.name}`);
            this.close();
          });
        }
      }

      if (docAgents.length === 0 && standaloneAgents.length === 0) {
        contentEl.createEl('p', { text: 'No doc or standalone agents available' });
      }

      // Add styles
      const style = contentEl.createEl('style');
      style.textContent = `
        .quick-spawn-section { margin-top: 16px; margin-bottom: 8px; font-size: 14px; }
        .quick-spawn-hint { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
      `;

    } catch (e) {
      contentEl.createEl('p', { text: `Error: ${e.message}` });
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ============================================================================
// RUN AGENTS MODAL
// ============================================================================

interface DocumentAgent {
  path: string;
  status: string;
  trigger: any;
  triggerRaw: string | null;
  lastRun: string | null;
  enabled: boolean;
}

class RunAgentsModal extends Modal {
  private plugin: AgentPilotPlugin;
  private documentPath: string;
  private agents: DocumentAgent[] = [];
  private selectedAgents: Set<string> = new Set();

  constructor(app: App, plugin: AgentPilotPlugin, documentPath: string) {
    super(app);
    this.plugin = plugin;
    this.documentPath = documentPath;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('run-agents-modal');

    contentEl.createEl('h2', { text: 'Run Agents' });
    contentEl.createEl('p', {
      text: `Document: ${this.documentPath}`,
      cls: 'run-agents-path'
    });

    const loadingEl = contentEl.createDiv({ text: 'Loading agents...' });

    try {
      const response = await fetch(
        `${this.plugin.settings.orchestratorUrl}/api/documents/${this.documentPath}/agents`
      );
      const agents = await response.json();
      this.agents = agents;

      loadingEl.remove();

      if (agents.length === 0) {
        contentEl.createEl('p', {
          text: 'No agents configured for this document.',
          cls: 'run-agents-empty'
        });
        contentEl.createEl('p', {
          text: 'Add an "agents" array to the document frontmatter to configure agents.',
          cls: 'run-agents-hint'
        });
        return;
      }

      // Agent list with checkboxes
      const listEl = contentEl.createDiv({ cls: 'run-agents-list' });

      for (const agent of agents) {
        const row = listEl.createDiv({ cls: 'run-agents-row' });

        const checkbox = row.createEl('input', { type: 'checkbox' });
        checkbox.checked = agent.status === 'pending' || agent.status === 'needs_run';
        if (checkbox.checked) {
          this.selectedAgents.add(agent.path);
        }

        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            this.selectedAgents.add(agent.path);
          } else {
            this.selectedAgents.delete(agent.path);
          }
        });

        const label = row.createDiv({ cls: 'run-agents-label' });
        const agentName = agent.path.replace('agents/', '').replace('.md', '');
        label.createEl('span', { text: agentName, cls: 'run-agents-name' });

        const statusBadge = label.createEl('span', {
          cls: `run-agents-status run-agents-status-${agent.status}`,
          text: agent.status
        });

        if (agent.triggerRaw) {
          label.createEl('span', {
            cls: 'run-agents-trigger',
            text: agent.triggerRaw
          });
        }

        if (agent.lastRun) {
          const lastRun = new Date(agent.lastRun);
          label.createEl('span', {
            cls: 'run-agents-lastrun',
            text: `Last: ${lastRun.toLocaleDateString()} ${lastRun.toLocaleTimeString()}`
          });
        }
      }

      // Actions
      const actionsEl = contentEl.createDiv({ cls: 'run-agents-actions' });

      const selectAllBtn = actionsEl.createEl('button', { text: 'Select All', cls: 'mod-cta' });
      selectAllBtn.addEventListener('click', () => {
        this.selectedAgents.clear();
        for (const agent of this.agents) {
          this.selectedAgents.add(agent.path);
        }
        listEl.querySelectorAll('input[type="checkbox"]').forEach((cb: HTMLInputElement) => {
          cb.checked = true;
        });
      });

      const selectNoneBtn = actionsEl.createEl('button', { text: 'Select None' });
      selectNoneBtn.addEventListener('click', () => {
        this.selectedAgents.clear();
        listEl.querySelectorAll('input[type="checkbox"]').forEach((cb: HTMLInputElement) => {
          cb.checked = false;
        });
      });

      const runBtn = actionsEl.createEl('button', { text: 'Run Selected', cls: 'mod-warning' });
      runBtn.addEventListener('click', () => this.runSelected());

      const runAllBtn = actionsEl.createEl('button', { text: 'Run All Pending', cls: 'mod-cta' });
      runAllBtn.addEventListener('click', () => this.runAllPending());

      // Add styles
      this.addModalStyles();

    } catch (e) {
      loadingEl.textContent = `Error: ${e.message}`;
    }
  }

  private async runSelected(): Promise<void> {
    if (this.selectedAgents.size === 0) {
      new Notice('No agents selected');
      return;
    }

    try {
      const response = await fetch(
        `${this.plugin.settings.orchestratorUrl}/api/documents/${this.documentPath}/run-agents`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agents: Array.from(this.selectedAgents) })
        }
      );

      const data = await response.json();
      new Notice(`Started ${data.ran} agent(s)`);
      this.close();

    } catch (e) {
      new Notice(`Error: ${e.message}`);
    }
  }

  private async runAllPending(): Promise<void> {
    try {
      const response = await fetch(
        `${this.plugin.settings.orchestratorUrl}/api/documents/${this.documentPath}/run-agents`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }
      );

      const data = await response.json();
      new Notice(`Started ${data.ran} agent(s)`);
      this.close();

    } catch (e) {
      new Notice(`Error: ${e.message}`);
    }
  }

  private addModalStyles(): void {
    const styleId = 'run-agents-modal-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .run-agents-modal {
        max-width: 500px;
      }

      .run-agents-path {
        color: var(--text-muted);
        font-size: 12px;
        font-family: monospace;
      }

      .run-agents-empty {
        color: var(--text-muted);
        font-style: italic;
      }

      .run-agents-hint {
        font-size: 12px;
        color: var(--text-muted);
      }

      .run-agents-list {
        margin: 16px 0;
        max-height: 300px;
        overflow-y: auto;
      }

      .run-agents-row {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 8px;
        background: var(--background-secondary);
        border-radius: 4px;
        margin-bottom: 8px;
      }

      .run-agents-row input[type="checkbox"] {
        margin-top: 4px;
      }

      .run-agents-label {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .run-agents-name {
        font-weight: 600;
      }

      .run-agents-status {
        display: inline-block;
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 10px;
        text-transform: uppercase;
        margin-left: 8px;
      }

      .run-agents-status-pending {
        background: var(--text-muted);
        color: white;
      }

      .run-agents-status-needs_run {
        background: var(--text-accent);
        color: white;
      }

      .run-agents-status-running {
        background: var(--text-accent);
        color: white;
      }

      .run-agents-status-completed {
        background: var(--text-success);
        color: white;
      }

      .run-agents-status-error {
        background: var(--text-error);
        color: white;
      }

      .run-agents-trigger {
        font-size: 11px;
        color: var(--text-muted);
        font-family: monospace;
      }

      .run-agents-lastrun {
        font-size: 11px;
        color: var(--text-muted);
      }

      .run-agents-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 16px;
      }

      .run-agents-actions button {
        padding: 8px 16px;
      }
    `;
    document.head.appendChild(style);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ============================================================================
// MANAGE AGENTS MODAL
// ============================================================================

class ManageAgentsModal extends Modal {
  private plugin: AgentPilotPlugin;
  private documentPath: string;
  private documentAgents: DocumentAgent[] = [];
  private availableAgents: AgentInfo[] = [];

  constructor(app: App, plugin: AgentPilotPlugin, documentPath: string) {
    super(app);
    this.plugin = plugin;
    this.documentPath = documentPath;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('manage-agents-modal');

    contentEl.createEl('h2', { text: 'Manage Document Agents' });
    contentEl.createEl('p', {
      text: this.documentPath,
      cls: 'manage-agents-path'
    });

    const loadingEl = contentEl.createDiv({ text: 'Loading...' });

    try {
      const [docAgentsRes, availAgentsRes] = await Promise.all([
        fetch(`${this.plugin.settings.orchestratorUrl}/api/documents/${this.documentPath}/agents`),
        fetch(`${this.plugin.settings.orchestratorUrl}/api/agents`)
      ]);

      this.documentAgents = await docAgentsRes.json();
      this.availableAgents = await availAgentsRes.json();

      loadingEl.remove();
      this.renderContent();

    } catch (e) {
      loadingEl.textContent = `Error: ${e.message}`;
    }
  }

  private renderContent(): void {
    const { contentEl } = this;

    const existingContent = contentEl.querySelector('.manage-agents-content');
    if (existingContent) existingContent.remove();

    const content = contentEl.createDiv({ cls: 'manage-agents-content' });

    // Current agents
    content.createEl('h3', { text: 'Configured Agents' });

    if (this.documentAgents.length === 0) {
      content.createEl('p', {
        text: 'No agents configured. Add one below!',
        cls: 'manage-agents-empty'
      });
    } else {
      const agentsList = content.createDiv({ cls: 'manage-agents-list' });

      for (let i = 0; i < this.documentAgents.length; i++) {
        const agent = this.documentAgents[i];
        this.renderAgentRow(agentsList, agent, i);
      }
    }

    // Add agent section
    content.createEl('h3', { text: 'Add Agent', cls: 'manage-agents-add-header' });

    const addRow = content.createDiv({ cls: 'manage-agents-add-row' });

    const select = addRow.createEl('select', { cls: 'manage-agents-select' });
    select.createEl('option', { value: '', text: 'Select an agent...' });

    const configuredPaths = new Set(this.documentAgents.map(a => a.path));
    for (const agent of this.availableAgents) {
      if (!configuredPaths.has(agent.path)) {
        select.createEl('option', {
          value: agent.path,
          text: `${agent.name} (${agent.type || 'chatbot'})`
        });
      }
    }

    const triggerInput = addRow.createEl('input', {
      type: 'text',
      placeholder: 'Trigger (optional)',
      cls: 'manage-agents-trigger-input'
    });

    const addBtn = addRow.createEl('button', { text: 'Add', cls: 'mod-cta' });
    addBtn.addEventListener('click', () => {
      if (!select.value) {
        new Notice('Please select an agent');
        return;
      }

      this.documentAgents.push({
        path: select.value,
        status: 'pending',
        trigger: null,
        triggerRaw: triggerInput.value || null,
        lastRun: null,
        enabled: true
      });

      this.renderContent();
    });

    // Actions
    const actions = content.createDiv({ cls: 'manage-agents-actions' });

    const saveBtn = actions.createEl('button', { text: 'Save Changes', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => this.saveChanges());

    const cancelBtn = actions.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    this.addModalStyles();
  }

  private renderAgentRow(container: HTMLElement, agent: DocumentAgent, index: number): void {
    const row = container.createDiv({ cls: 'manage-agents-row' });

    const info = row.createDiv({ cls: 'manage-agents-info' });
    const agentName = agent.path.replace('agents/', '').replace('.md', '');
    info.createEl('span', { text: agentName, cls: 'manage-agents-name' });

    const triggerContainer = row.createDiv({ cls: 'manage-agents-trigger-container' });
    triggerContainer.createEl('span', { text: 'Trigger:', cls: 'manage-agents-label' });

    const triggerInput = triggerContainer.createEl('input', {
      type: 'text',
      value: agent.triggerRaw || '',
      placeholder: 'manual',
      cls: 'manage-agents-trigger-edit'
    });

    triggerInput.addEventListener('change', () => {
      this.documentAgents[index].triggerRaw = triggerInput.value || null;
    });

    const removeBtn = row.createEl('button', { text: 'Remove', cls: 'manage-agents-remove' });
    removeBtn.addEventListener('click', () => {
      this.documentAgents.splice(index, 1);
      this.renderContent();
    });
  }

  private async saveChanges(): Promise<void> {
    try {
      const agents = this.documentAgents.map(a => ({
        path: a.path,
        status: a.status || 'pending',
        trigger: a.triggerRaw || null,
        enabled: a.enabled !== false
      }));

      const response = await fetch(
        `${this.plugin.settings.orchestratorUrl}/api/documents/${this.documentPath}/agents`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agents })
        }
      );

      if (response.ok) {
        new Notice('Agents saved!');
        this.close();
      } else {
        const data = await response.json();
        new Notice(`Error: ${data.error}`);
      }
    } catch (e) {
      new Notice(`Error: ${e.message}`);
    }
  }

  private addModalStyles(): void {
    const styleId = 'manage-agents-modal-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .manage-agents-modal { max-width: 600px; }
      .manage-agents-path { color: var(--text-muted); font-size: 12px; font-family: monospace; margin-bottom: 16px; }
      .manage-agents-content h3 { margin-top: 16px; margin-bottom: 8px; font-size: 14px; }
      .manage-agents-empty { color: var(--text-muted); font-style: italic; }
      .manage-agents-list { display: flex; flex-direction: column; gap: 8px; }
      .manage-agents-row { display: flex; align-items: center; gap: 12px; padding: 10px; background: var(--background-secondary); border-radius: 6px; }
      .manage-agents-info { flex: 1; }
      .manage-agents-name { font-weight: 600; }
      .manage-agents-trigger-container { display: flex; align-items: center; gap: 8px; }
      .manage-agents-label { font-size: 12px; color: var(--text-muted); }
      .manage-agents-trigger-edit { width: 120px; padding: 4px 8px; font-size: 12px; font-family: monospace; }
      .manage-agents-remove { padding: 4px 12px; background: var(--background-modifier-error); color: white; border: none; border-radius: 4px; font-size: 11px; cursor: pointer; }
      .manage-agents-add-header { margin-top: 24px !important; border-top: 1px solid var(--background-modifier-border); padding-top: 16px; }
      .manage-agents-add-row { display: flex; gap: 8px; align-items: center; }
      .manage-agents-select { flex: 1; padding: 8px; }
      .manage-agents-trigger-input { width: 140px; padding: 8px; font-family: monospace; font-size: 12px; }
      .manage-agents-actions { display: flex; gap: 8px; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--background-modifier-border); }
      .manage-agents-actions button { padding: 8px 20px; }
    `;
    document.head.appendChild(style);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
