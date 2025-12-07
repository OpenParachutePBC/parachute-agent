# Obsidian Agent Pilot

A system that transforms Obsidian vaults into living, autonomous knowledge bases powered by AI agents.

## Overview

Obsidian Agent Pilot enables:
- **Document-as-Agent-Target**: Any markdown document can have agents assigned to process it
- **Multiple Agents per Document**: Each document can have multiple agents with independent triggers and status
- **Agent Types**: `workflow` (one-shot) and `chatbot` (persistent conversation)
- **Trigger System**: Time-based (`daily@22:00`, `weekly@monday`) or event-based (`on_save`, `manual`)
- **Orchestrated Execution**: Queue-based processing with spawn depth limiting

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Obsidian Plugin                           │
│  (thin client - UI, commands, sends requests to server)      │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP API
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Express Server                            │
│                    (server.js)                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Orchestrator                              │  │
│  │  - Queue management                                    │  │
│  │  - Session management (chatbot agents)                 │  │
│  │  - Trigger checking loop                               │  │
│  │  - Agent execution via Claude Agent SDK                │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │Agent Loader  │  │Doc Scanner   │  │Session Manager   │  │
│  │              │  │              │  │                  │  │
│  │Loads agent   │  │Scans vault   │  │Persists chat     │  │
│  │definitions   │  │for documents │  │sessions          │  │
│  │from agents/  │  │with agent    │  │                  │  │
│  │              │  │configs       │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────┬───────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│  Claude Agent    │    │   Vault Files    │
│  SDK             │    │   (Markdown)     │
└──────────────────┘    └──────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Start the server (uses sample-vault by default)
npm start

# Or point to your own vault
VAULT_PATH=/path/to/your/vault npm start

# The server runs on http://localhost:3333
```

### Obsidian Plugin

The plugin is pre-installed in `sample-vault/.obsidian/plugins/agent-pilot/`.

For your own vault:
1. Copy `obsidian-plugin/` contents to your `.obsidian/plugins/agent-pilot/`
2. Build with `cd obsidian-plugin && npm run build`
3. Enable "Agent Pilot" in Obsidian settings

## Project Structure

```
obsidian-agent-pilot/
├── server.js                 # Express API server
├── lib/
│   ├── orchestrator.js       # Central agent execution controller
│   ├── agent-loader.js       # Loads agent definitions from markdown
│   ├── document-scanner.js   # Scans vault for document-agent configs
│   ├── session-manager.js    # Manages chat sessions for chatbot agents
│   ├── queue.js              # Execution queue with persistence
│   └── vault-utils.js        # Shared vault file utilities
├── obsidian-plugin/
│   ├── main.ts               # Plugin source
│   ├── styles.css            # Plugin styles
│   └── manifest.json
└── sample-vault/
    ├── agents/               # Agent definitions
    │   ├── daily-reflection.md
    │   ├── idea-curator.md
    │   ├── project-manager.md
    │   ├── weekly-review.md
    │   └── task-breakdown.md
    ├── daily/                # Daily notes (targets for agents)
    ├── ideas/                # Ideas inbox
    ├── projects/             # Project documents
    └── summaries/            # Generated summaries
```

## Concepts

### Agent Definitions (in `agents/`)

Agent definitions live in the `agents/` folder. Each defines an agent's behavior:

```yaml
---
agent:
  name: daily-reflection
  type: workflow              # 'workflow' (one-shot) or 'chatbot' (persistent)
  description: Process daily journal entries
  model: sonnet

  context:
    include: ["daily/*", "projects/*"]
    max_files: 10

  permissions:
    read: ["*"]
    write: ["daily/*", "summaries/*"]
    spawn: ["agents/weekly-review.md"]
    tools: [Read, Write, Grep]

  constraints:
    max_spawns: 2
    timeout: 120
---

# System Prompt

You are a thoughtful reflection partner...
```

### Document-Agent Configuration (in any document)

Any document can reference agents in its frontmatter:

```yaml
---
title: My Daily Note
agents:
  - path: agents/daily-reflection.md
    status: pending           # pending, needs_run, running, completed, error
    trigger: daily@22:00      # When to run
  - path: agents/idea-curator.md
    status: pending
    trigger: manual           # Only run when manually triggered
---
```

### Trigger Types

| Trigger | Description |
|---------|-------------|
| `daily@HH:MM` | Run daily at specified time |
| `weekly@day` | Run weekly on specified day |
| `hourly` | Run every hour |
| `manual` | Only run when manually triggered |
| `on_save` | Run when document is saved (plugin) |

### Agent Status Flow

```
pending → needs_run → running → completed
                   ↘ error
```

## API Endpoints

### Chat & Agents

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Chat with vault/document agent |
| `/api/chat/sessions` | GET | List all chat sessions |
| `/api/chat/history` | GET | Get chat history for agent |
| `/api/chat/session` | DELETE | Clear a chat session |
| `/api/agents` | GET | List all defined agents |
| `/api/agents/spawn` | POST | Queue an agent for execution |

### Documents

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/documents` | GET | List all documents |
| `/api/documents/:path` | GET | Get specific document |
| `/api/documents/:path/agents` | GET | Get agents for document |
| `/api/documents/:path/agents` | PUT | Update agents for document |
| `/api/documents/:path/run-agents` | POST | Run agents on document |
| `/api/documents/:path/reset-agents` | POST | Reset agent status to pending |

### Queue & System

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/queue` | GET | View queue state |
| `/api/queue/process` | POST | Trigger queue processing |
| `/api/triggers/check` | POST | Check all document triggers |
| `/api/vault` | GET | Get vault info |
| `/api/search?q=` | GET | Search vault |

## Obsidian Plugin Commands

- **Open Agent Pilot** - Opens the sidebar panel
- **Quick Spawn Agent** - Run a workflow agent
- **Run Agents on Current Document** - Execute agents configured for the open document
- **Manage Document Agents** - Add/remove/configure agents for current document

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3333 | Server port |
| `HOST` | 0.0.0.0 | Server host (0.0.0.0 for Tailscale) |
| `VAULT_PATH` | ./sample-vault | Path to Obsidian vault |

### Plugin Settings

- **Orchestrator URL**: Server URL (default: http://localhost:3333)
- **Auto-refresh Activity**: Auto-update activity tab
- **Refresh Interval**: How often to refresh (ms)

## Development

```bash
# Server
npm start                     # Start server
npm run dev                   # Start with nodemon (if configured)

# Plugin
cd obsidian-plugin
npm install
npm run build                 # Build plugin
npm run dev                   # Watch mode
```

## Credits

Built with:
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk) - AI agent execution
- [Obsidian](https://obsidian.md/) - Knowledge management
- [Express](https://expressjs.com/) - HTTP server
- [gray-matter](https://github.com/jonschlinkert/gray-matter) - YAML frontmatter parsing
