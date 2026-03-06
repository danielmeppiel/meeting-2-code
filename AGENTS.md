# AGENTS.md — Custom Instructions for Meeting → Code

## Project Overview

Meeting → Code is a Node.js/TypeScript application that automates the path from meeting decisions to shipped code using the GitHub Copilot SDK, WorkIQ MCP, and the GitHub platform.

## Architecture

- **Backend:** Express server (`src/server.ts`) with SSE streaming endpoints
- **Agents:** Modular TypeScript files under `src/agents/` — each handles one step of the pipeline
- **Frontend:** Vanilla JS single-page app in `public/` (no framework, no bundler)
- **Config:** `src/config.ts` provides `OWNER`, `REPO`, `REPO_PATH` from env vars

## Code Conventions

- ES modules everywhere (`"type": "module"` in package.json)
- TypeScript strict mode, ES2022 target, NodeNext module resolution
- Agent modules export a single async function with an options object (callbacks for progress/logging)
- SSE pattern: `sseHeaders(res)` returns a `sendEvent` function; all endpoints stream progress events
- No bundler — frontend uses native `<script type="module">` imports
- CSS is modular under `public/css/`; `public/styles.css` is generated via `npm run css:build`

## MCP Servers Used

1. **WorkIQ** (`@microsoft/workiq`) — local MCP server launched via `npx`. Connects to Microsoft 365 for meeting data.
2. **GitHub MCP** (`https://api.githubcopilot.com/mcp/`) — remote HTTP MCP server for repository code search and file reading.

## Key Patterns

- Copilot SDK sessions are created via `createAgentSession()` in `session-helpers.ts` which auto-approves permissions and logs tool calls
- All GitHub operations use `gh` CLI (not Octokit) for simplicity and auth reuse
- Agent assignment uses the GitHub REST API directly via `gh api`
- Error handling: agents throw meaningful errors; server endpoints catch and stream error events

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TARGET_OWNER` | `danielmeppiel` | GitHub owner of target repo |
| `TARGET_REPO` | `corporate-website` | Target repo name |
| `TARGET_REPO_PATH` | `~/Repos/<repo>` | Local clone path |
| `PORT` | `3000` | Server port |

## Development

```bash
npm install        # install deps
npm run dev        # watch mode (tsx watch)
npm run build      # type-check (tsc)
npm run css:build  # regenerate public/styles.css from partials
```
