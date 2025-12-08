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
| `/api/chat` | POST | Send message |
| `/api/chat/sessions` | GET | List sessions |
| `/api/chat/session` | DELETE | Clear session |

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

### SDK Session Resumption
The `sdk_session_id` in frontmatter enables conversation resumption. Always validate this value - must be a valid string, not `[object Object]`.

### Error Handling
- Agent execution errors returned in response
- Session manager logs errors but doesn't throw on save failures

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_PATH` | `./sample-vault` | Path to markdown folder |
| `PORT` | `3333` | Server port |
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
