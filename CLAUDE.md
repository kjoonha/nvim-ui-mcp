# nvim-ui-mcp

Playwright for Neovim agents. MCP server exposing the **rendered** Neovim UI (not just buffer/API state) so AI agents can observe→act→observe→verify against real screen output — floats, completion menus, highlights, cursor, mode.

Full architecture/rationale: **DESIGN.md** (read it before touching RPC/screen/session layers). Original requirements: `.omc/specs/deep-interview-nvim-ui-mcp.md`. Consensus plan: `.omc/plans/nvim-ui-mcp-plan.md`.

## Three principles (drive every design decision here)
1. Rendered UI is source of truth.
2. Structured Neovim state augments the rendered UI, never replaces it.
3. Primary loop: observe → act → observe → verify.

## Stack
TypeScript/Node 22+, `@modelcontextprotocol/server` (stdio transport), `neovim` npm client (msgpack-RPC, `nvim_ui_attach` + `ext_linegrid`), Zod schemas, Vitest, tsup, ESLint+typescript-eslint strict.

## Architecture (layered, each independently testable)

```
src/rpc/        connect.ts          launch/attach to Neovim over msgpack-RPC (socket or embedded stdio)
src/ui/         events.ts, event-processor.ts    parse `redraw` batches into typed UiEvent[]
src/screen/     cell.ts, shadow-screen.ts, serializer.ts, diff.ts   pure grid model, no transport/MCP deps
src/session/    session.ts, manager.ts, observation.ts, wait.ts    ties RPC+screen together, session lifecycle
src/mcp/        server.ts, stdio.ts, tools/*.ts    MCP tool registration + handlers
```

Data flow: `rpc/connect` → RPC client emits `redraw` notifications → `ui/event-processor` parses into `UiEvent[]` → `screen/shadow-screen` mutates grid state → `screen/serializer` renders text → `mcp/tools/*` package it for the agent.

### ShadowScreen consistency gate
Screen is only safe to read when `consistent === true`. Mutation sets `consistent = false` and clears dirty rows; the `flush` event (last event in a `redraw` batch) sets `consistent = true`. Never read mid-batch.

### Session lifecycle
`SessionManager` (unbounded `Map`, no cap/idle-timeout by design choice — flagged nice-to-have, not fixed) owns `NeovimSession` instances. Two modes:
- **test mode** (`nvim_launch`): server spawns+owns `nvim --embed`, `nvim_close` may kill it.
- **attach mode** (`nvim_attach`): connects to an existing `--listen` socket/named-pipe; `nvim_close` refuses these (not ours to kill).

## MCP tool surface (exactly 8 — do not expand)
`nvim_launch`, `nvim_attach`, `nvim_observe`, `nvim_observe_diff`, `nvim_input`, `nvim_command`, `nvim_wait`, `nvim_close`.

This is a deliberate scope wall (see spec Non-Goals): no LSP queries, no git integration, no filesystem tools, no generic `nvim_*` API wrapper sprawl. Resist adding tools; extend existing ones' schemas instead if a new need shows up.

## Known gotchas (do not relearn these the hard way)

- **Edge- vs level-triggered `nvim_wait`**: `redraw` / `screen-change` / `idle` conditions are edge-triggered — they can race if the repaint already happened before the wait started. `contains` / `not-contains` are level-triggered (check current state), always prefer them when you know the expected text. Documented in DESIGN.md §11 and README.
- **`nvim_input`/`nvim_command` return before repaint.** Always `nvim_wait` before `nvim_observe` after an action.
- **`neovim` npm client landmines** (DESIGN.md §4): console hijacking on attach, and a `qa!` + `client.close()` deadlock on shutdown if not sequenced carefully — see `session.ts#close()` for the grace-period + SIGKILL fallback and fire-and-forget `qa!` handling.
- **`connectToAddress` in `rpc/connect.ts`**: must await the socket's `connect` event before building the RPC client — building it over an unconnected socket causes an unhandled rejection (was a real bug, fixed).
- **`session.ts#attachUi`**: uses `Promise.race` between attach-success/failure/timeout; the losing promises need `.catch(() => undefined)` suppression or you leak an unhandled rejection.
- **Floating windows**: Neovim composites floats into the single global grid already (no `ext_multigrid`), so float content is already in `screen` text. `nvim_observe`'s `floats` array (from `nvim_list_wins()` + `nvim_win_get_config()`, single Lua round-trip in `session/observation.ts`) gives row/col/width/height to distinguish float from background text at the same coordinates.
- **No highlight/colour diffing** in `nvim_observe_diff` — deliberate scope cut, text-only diff (DESIGN.md §15).

## Constraints
Neovim 0.10+ only (no legacy pre-linegrid event handling). Linux + macOS + Windows (RPC layer must handle Unix sockets and Windows named pipes — see `normalizePipeAddress` in `rpc/connect.ts`). MIT license.

## Commands
```bash
npm test              # unit + integration (needs real nvim on PATH)
npm run test:unit
npm run test:integration
npm run typecheck
npm run lint
npm run build
```
151 tests, all green as of last verification (120 unit / 31 integration, real `/usr/bin/nvim` binary, PID-tracked with orphan-process assertions in `afterAll`).

## Status
v0.1.0 implemented end-to-end (all 8 tools, both modes, floating windows, unit+integration tests, CI workflow). Went through deep-interview → ralplan consensus (Planner/Architect/Critic) → autopilot execution → Phase 4 validation (architect/security/code-review all approved). Two should-fix code-review items already applied (removed dead `HANDLED_EVENTS` export in `ui/events.ts`; de-duplicated `screen` field in `mcp/tools/shared.ts#observationResult`). Committed and pushed to `origin/main`.

Deliberately deferred (not bugs, just out of MVP scope — see DESIGN.md §15 and code-review notes): session cap/idle timeout in `SessionManager`, no `pcall` around the Lua metadata script in `observation.ts`, `gridScroll`'s `cols` param currently unused/undocumented, module-level `sessionCounter` in tests affects isolation slightly.
