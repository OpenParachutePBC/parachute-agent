# Obsidian Agent Pilot - Development Guide

## Project Overview

An AI agent system that uses Obsidian vaults as both configuration and execution environment. Agents are defined in markdown files with YAML frontmatter, and conversations are persisted as readable markdown for syncing across devices.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Obsidian Plugin │────▶│  Express Server  │────▶│  Claude SDK     │
│ (UI in Obsidian)│     │  (port 3333)     │     │  (query API)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
             ┌──────────────┐      ┌──────────────┐
             │ Session Mgr  │      │ Orchestrator │
             │ (markdown)   │      │ (agent exec) │
             └──────────────┘      └──────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express API server - routes and WebSocket |
| `lib/orchestrator.js` | Central agent execution controller using Claude SDK |
| `lib/session-manager.js` | Chat session persistence as markdown files |
| `lib/agent-loader.js` | Loads agent definitions from markdown frontmatter |
| `lib/queue.js` | Execution queue with disk persistence |
| `lib/document-scanner.js` | Scans vault for document-agent configurations |
| `lib/vault-utils.js` | Shared file reading/writing utilities |
| `lib/context-loader.js` | Loads context files for agent prompts |
| `obsidian-plugin/main.ts` | Obsidian plugin source (TypeScript) |

## Commands

```bash
# Start server (production)
npm start

# Start server with auto-reload
npm run dev

# Run tests
npm test

# Start with custom vault path
VAULT_PATH=/path/to/vault npm start
```

## Testing

Uses Node.js built-in test runner. Test files are colocated with source:
- `lib/session-manager.test.js` - Session management tests

Run specific test file:
```bash
node --test lib/session-manager.test.js
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents` | GET | List available agents |
| `/api/agents/:path` | GET | Get agent details |
| `/api/chat` | POST | Send message to agent |
| `/api/sessions` | GET | List active sessions |
| `/api/sessions/clear` | POST | Clear session for agent |

## Agent Definition Format

Agents are markdown files in `agents/` with YAML frontmatter:

```markdown
---
name: Agent Name
description: What this agent does
model: claude-sonnet-4-20250514
system_prompt: |
  You are a helpful assistant...
tools:
  - vault_search
  - vault_read
---

# Agent Name

Additional documentation or context for the agent.
```

## Session Storage

Sessions are stored as markdown in `agent-chats/`:
- Readable in Obsidian
- Sync via Obsidian Sync
- Frontmatter contains session metadata
- Conversation formatted as H3 headers with timestamps

## Key Patterns

### SDK Session Resumption
The `sdk_session_id` in frontmatter enables conversation resumption with Claude SDK. Always validate this value before use - must be a valid string, not `[object Object]`.

### Error Handling
- Agent execution errors are caught and returned in response
- Session manager logs errors but doesn't throw on save failures
- Queue persists to disk for recovery after crashes

### File Paths
All paths in the codebase are relative to vault root unless prefixed with absolute path.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_PATH` | `./sample-vault` | Path to Obsidian vault |
| `PORT` | `3333` | Server port |
| `ANTHROPIC_API_KEY` | (required) | Claude API key |

## Common Issues

1. **"Claude Code process exited with code 1"** - Usually caused by invalid `sdk_session_id`. Check that session files don't contain `sdk_session_id: "[object Object]"`.

2. **Session not resuming** - Ensure `sdk_session_id` is a valid string in the session markdown file.

3. **Agent not found** - Check that agent file exists in `agents/` folder with valid frontmatter.
