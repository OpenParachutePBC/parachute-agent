# Parachute Agent - Development Guide

## Project Overview

Parachute Agent is the backend for Parachute - an AI agent system that uses markdown files as both configuration and execution environment. Agents are defined in markdown files with YAML frontmatter, and conversations are persisted as readable markdown.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│ Parachute App   │     │ Obsidian Plugin │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │   Express Server      │
         │   (port 3333)         │
         └───────────┬───────────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   ┌──────────────┐      ┌──────────────┐
   │ Session Mgr  │      │ Orchestrator │
   │ (markdown)   │      │ (Claude SDK) │
   └──────────────┘      └──────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express API server |
| `lib/orchestrator.js` | Agent execution via Claude SDK |
| `lib/session-manager.js` | Session persistence as markdown |
| `lib/agent-loader.js` | Load agent definitions from markdown |
| `lib/vault-utils.js` | Shared file utilities |
| `obsidian-plugin/main.ts` | Optional Obsidian plugin |

## Commands

```bash
npm start                        # Start server
npm run dev                      # Start with auto-reload
npm test                         # Run tests
VAULT_PATH=/path/to/vault npm start  # Custom vault
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents` | GET | List agents |
| `/api/chat` | POST | Send message (body: `{message, agentPath?, sessionId?}`) |
| `/api/chat/stream` | POST | Streaming chat via SSE (same body as `/api/chat`) |
| `/api/chat/sessions` | GET | List all sessions |
| `/api/chat/session/:id` | GET | Get session by ID with messages |
| `/api/chat/session/:id/archive` | POST | Archive a session |
| `/api/chat/session/:id/unarchive` | POST | Unarchive a session |
| `/api/chat/session/:id` | DELETE | Delete session permanently |
| `/api/chat/session` | DELETE | Clear session (legacy) |
| `/api/stats` | GET | Get session stats and memory usage |
| `/api/permissions/stream` | GET | SSE stream for permission requests |
| `/api/permissions/:id/grant` | POST | Grant a pending permission |
| `/api/permissions/:id/deny` | POST | Deny a pending permission |

## Agent Definition Format

```markdown
---
name: Agent Name
description: What this agent does
model: claude-sonnet-4-20250514
system_prompt: |
  You are a helpful assistant...
---

# Agent Name

Additional context for the agent.
```

## Session Storage

Sessions stored as markdown in `agent-chats/`:
- Human-readable format
- YAML frontmatter with session metadata
- Conversation as H3 headers with timestamps

## Key Patterns

### Session Architecture (Lazy Loading)
Sessions use a two-tier architecture:
- **Index** (`sessionIndex`): Lightweight, loaded at startup. Contains metadata only.
- **Loaded Sessions** (`loadedSessions`): Full content loaded on-demand from markdown.
- **Active SDK Sessions** (`activeSessions`): Ephemeral, may expire.

### SDK Session Resumption
The `sdk_session_id` in frontmatter enables conversation resumption:
- Try SDK resume first (fastest, if session still alive on Anthropic's servers)
- If unavailable/expired, inject context from markdown history
- Context injection: Last N messages that fit in ~50k tokens
- New SDK session ID captured and saved to markdown

### Session Resume Debug Info
Every chat response includes `sessionResume` with:
```json
{
  "method": "sdk_resume | context_injection | new",
  "sdkSessionValid": true,
  "sdkResumeAttempted": true,
  "contextInjected": false,
  "messagesInjected": 0,
  "tokensEstimate": 0,
  "previousMessageCount": 10,
  "loadedFromDisk": true,
  "cacheHit": false
}
```

### Session Management
- Each chat gets a unique `sessionId` for isolation
- Sessions track `archived` status (persisted in YAML)
- Plugin uses `serverId` for history fetch vs `id` for API routing
- Stale sessions evicted from memory after 30 min

### Permission System
- Agents define `write_permissions` as glob patterns in frontmatter
- Writes outside allowed paths trigger permission requests via SSE
- Plugin shows inline permission dialogs for user approval

### Streaming Chat
The `/api/chat/stream` endpoint returns SSE events for real-time UI updates:
- `session`: Session ID and resume info at start
- `init`: SDK initialized with available tools
- `text`: Text content (full content, updated incrementally)
- `tool_use`: Tool being executed with name and input
- `done`: Final result with toolCalls, durationMs, spawned, sessionResume
- `error`: Error message if something went wrong

### Error Handling
- Agent execution errors returned in response
- Session manager logs errors but doesn't throw on save failures

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_PATH` | `./sample-vault` | Path to markdown folder |
| `PORT` | `3333` | Server port |
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
