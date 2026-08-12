# nvim-ui-mcp — Design

**Status:** MVP design, authoritative for implementation.
**Target Neovim:** 0.10+
**Target platforms:** Linux, macOS, Windows

---

## 1. Goals

`nvim-ui-mcp` is an MCP server that lets an AI coding agent **see, drive, and verify the actual
rendered Neovim UI** — not just buffer contents or API state. It attaches to Neovim as a real UI
client via `nvim_ui_attach()` and maintains an in-memory reconstruction of the screen that Neovim
would have painted to a terminal.

Three principles govern every design decision:

1. **The rendered UI is the source of truth.** What the agent observes is what a human would see.
2. **Structured Neovim state augments the rendered UI, never replaces it.** Cursor position, mode,
   buffer/window/file metadata, and floating-window geometry are returned *alongside* the screen
   text to help the agent interpret it — they are not a substitute for it.
3. **The primary agent workflow is `observe → act → observe → verify`.** Every tool exists to serve
   one of those four verbs.

The motivating use case is autonomous Neovim plugin development and UI bug reproduction: an agent
can open a plugin's UI, trigger it, look at the composited grid (including completion popups,
floats, virtual text, and messages), and assert on what actually rendered.

## 2. Non-Goals

- **Not a generic Neovim automation/API framework.** No LSP queries, no diagnostics API, no Git
  integration, no filesystem tools, no buffer-edit helper wrappers. Those already exist elsewhere
  (e.g. `paulburgess1357/nvim-mcp`) and operate at the API layer; this project deliberately
  operates at the *UI* layer, and the two tool surfaces do not overlap.
- **No companion Neovim plugin.** Everything uses native RPC/UI interfaces. Users install nothing
  inside Neovim.
- **No screenshot/OCR as the primary observation mechanism.** The text grid is primary. The
  architecture keeps the cell grid (text + highlight id) intact so an optional PNG renderer could
  be layered on later, but colour rendering is out of scope for the MVP.
- **No custom `ext_multigrid` compositor.** We rely on Neovim's own compositor and consume the
  single composited grid.
- **No full colour fidelity in the MVP.** Highlight IDs and their attribute definitions are stored,
  but the text serialization does not encode them.

## 3. Architecture

```
MCP Client (Claude, etc.)
  │  stdio (JSON-RPC)
  ▼
McpServer                    src/mcp/server.ts
  │  dispatches tool calls
  ▼
SessionManager               src/session/manager.ts
  │  routes by session id
  ▼
NeovimSession                src/session/session.ts
  │  owns: process handle (test mode) or socket (attach mode),
  │        neovim client, UiEventProcessor, ShadowScreen
  ▼
neovim npm client (node-client)
  │  msgpack-RPC over the child's stdio or a socket/named pipe
  │  ◀── `redraw` notifications (async, unsolicited)
  ▼
Neovim
```

Module layout:

```
src/
  index.ts                  public exports / MCP entry point
  rpc/connect.ts            launchNeovim() and connectToAddress()
  session/session.ts        NeovimSession: lifecycle, uiAttach, event wiring
  session/manager.ts        SessionManager: Map<id, NeovimSession>
  ui/events.ts              discriminated-union types for handled UI events
  ui/event-processor.ts     UiEventProcessor: redraw batch parser → ShadowScreen
  screen/cell.ts            Cell = { text, hlId }
  screen/shadow-screen.ts   ShadowScreen: grid, cursor, size, highlights, mode
  screen/serializer.ts      deterministic row-by-row text rendering
  screen/diff.ts            snapshot comparison → compact diff
  mcp/server.ts             MCP server setup
  mcp/tools/*.ts            the 8 tool handlers
```

The dependency direction is strictly downward: `screen/` depends on nothing, `ui/` depends only on
`screen/`, `session/` depends on `ui/` + `rpc/`, and `mcp/` depends on `session/`. In particular
**`ShadowScreen`, the UI event types, and `UiEventProcessor` have no dependency on the RPC client
whatsoever** — they consume plain arrays. This makes the core domain unit-testable without Neovim,
and keeps it portable if the transport ever has to be replaced (see §14).

### Concurrency model

Node.js is single-threaded. MCP tool calls and Neovim redraw notifications are both processed on
the same event loop, so tool calls against a session are naturally serialized — no explicit queue
or lock is needed because there is no preemption between `await` points that we do not control. A
long-running `nvim_wait` is a Promise resolved from a redraw callback; it never blocks the loop.

## 4. RPC Design and Async Notification Handling

Neovim's msgpack-RPC is **bidirectional**: a UI client issues requests (`nvim_ui_attach`,
`nvim_input`, `nvim_command`) and simultaneously receives unsolicited **notifications**, of which
`redraw` is the only one we care about. A request/response-only client is therefore insufficient.

We use the official `neovim` npm package (node-client), which exposes:

- `attach({ proc })` — speak msgpack-RPC over a child process's stdin/stdout.
- `attach({ socket })` — speak msgpack-RPC over a Unix domain socket or Windows named pipe.
- `nvim.uiAttach(width, height, options)` — the `nvim_ui_attach` request.
- an `EventEmitter` `notification` event: `(method: string, args: unknown[]) => void`.

`redraw` notification payloads arrive as `args = [[eventName, ...argSets], ...]` — a **batch** of
events, where each event is itself an array whose first element is the event name and whose
remaining elements are one or more argument tuples for that same event. `UiEventProcessor` flattens
this shape before dispatching.

### Dual-stdio clarification

There are two independent stdio channels and they must not be confused:

| Channel | Endpoints |
|---|---|
| MCP JSON-RPC | the **server process's own** stdin/stdout ↔ the MCP client |
| Neovim msgpack-RPC (test mode) | the **spawned child's** stdin/stdout ↔ the server |

The server's own stdin/stdout are never shared with Neovim. This resolves the `--embed` vs
`--headless` question: **test mode spawns `nvim --embed`**, which makes the child expect a UI client
on *its* stdio. `--headless` is wrong here, since it suppresses the UI entirely. In attach mode the
Neovim channel is a socket/named pipe, so the question does not arise.

Because the server's stdout carries MCP JSON-RPC framing, **nothing else may ever write to stdout**.
All diagnostics go to stderr.

Two node-client behaviours found during the Step 1.5 smoke test constrain everything above them:

- **The `neovim` package monkey-patches global `console`** onto a winston logger that is silent
  unless `NVIM_NODE_LOG_FILE` or `ALLOW_CONSOLE` is set (it does this precisely to stop stray
  `console.log` from corrupting an RPC stdio channel). Any diagnostic output of ours must therefore
  use `process.stderr.write` directly; `console.error` silently vanishes.
- **`nvim.command('qa!')` never settles**, because Neovim exits before it can reply, and
  **`client.close()` never settles once the child has exited**, because it ends a writer whose
  `finish` event will never fire. Shutdown therefore fires `qa!` without awaiting it, waits on the
  process `exit` event (with a grace period before `SIGKILL`), and closes the client only for a
  still-live transport. Awaiting either call directly deadlocks `nvim_close`.
- **`attach({ socket })` builds the client over a socket that has not connected yet.** It calls
  `net.createConnection` and installs no `error` listener, so a refused or missing socket surfaces
  as an *unhandled rejection from inside the client* — which would take down a long-running server —
  while the caller sits out its own `ui_attach` timeout instead of failing fast. `connectToAddress`
  therefore awaits `connect` on its own socket first and only then calls `attach({ reader, writer })`.
  This turned a 10s timeout plus an unhandled rejection into an immediate, named error.
- **A `Promise.race` against a dying transport leaks a rejection.** When the attach race settles on
  the transport-failure branch, the still-pending `uiAttach` request is later rejected by the client
  with the same socket error and has no handler. Every promise entered into that race carries its own
  no-op `catch` for exactly this reason.

### Transport normalization

`connectToAddress(address)` passes the address straight through to `attach({ socket: address })`.
Node's `net.connect()` accepts both a filesystem path (`/tmp/nvim.sock`, from `nvim --listen`) and a
Windows named pipe path (`\\.\pipe\nvim.12345.0`), so a single code path covers all three platforms.
There is no host/port form in the MVP, because `nvim --listen` does not default to TCP.

## 5. UI Event Processing

`UiEventProcessor.handleRedraw(batch)` walks the batch in order and dispatches each event to the
corresponding `ShadowScreen` method. The MVP handles exactly the events required to reconstruct a
composited `ext_linegrid` screen:

| Event | Effect |
|---|---|
| `grid_resize(grid, width, height)` | resize grid, preserving overlapping content |
| `grid_line(grid, row, colStart, cells, wrap?)` | write cells into a row |
| `grid_clear(grid)` | fill entire grid with spaces / hl 0 |
| `grid_scroll(grid, top, bot, left, right, rows, cols)` | move a region vertically |
| `grid_cursor_goto(grid, row, col)` | move cursor |
| `hl_attr_define(id, rgbAttrs, ctermAttrs, info)` | record highlight definition |
| `default_colors_set(fg, bg, sp, ...)` | record default fg/bg/sp |
| `mode_change(name, index)` | record current mode |
| `flush()` | mark screen consistent; clear dirty rows on next mutation |

`grid_destroy` and other `ext_multigrid`-only events are intentionally unhandled: the MVP never
enables `ext_multigrid`, so they are never sent. Any other event (`win_viewport`, `msg_*`, …) is
counted as unhandled and ignored rather than throwing — Neovim adds UI events over time and an
unknown event must never crash a session.

Only `grid === 1` (the global composited grid) is processed. Events for other grid ids are ignored.

### `grid_line` cell decoding

Each entry of `cells` is `[text]`, `[text, hlId]`, or `[text, hlId, repeat]`, decoded exactly per
the `ui-linegrid` protocol:

- **`hlId` omitted:** reuse the last `hlId` seen *within this same `grid_line` call*. The first cell
  of a `grid_line` always carries an explicit `hlId`.
- **`repeat` present:** write that many consecutive cells with the same text and `hlId`.
- **Double-width characters:** Neovim emits the wide char in the left cell and a **literal empty
  string `""`** in the following cell. The empty cell is never repeated. `ShadowScreen` stores the
  `""` verbatim, which is what makes column arithmetic stay correct.

This mirrors Neovim's own `test/functional/ui/screen.lua` model, which is the reference
implementation we validate against.

## 6. Screen Representation

```ts
type Cell = { text: string; hlId: number };
```

`ShadowScreen` holds:

- **grid:** `Cell[][]`, `rows × cols`
- **cursor:** `{ row, col }`
- **size:** `{ rows, cols }`
- **highlights:** `Map<number, HlAttrs>` from `hl_attr_define`
- **defaultColors:** `{ fg, bg, sp }` from `default_colors_set`
- **mode:** `{ name, index }`
- **consistent:** `boolean` — the flush gate (§6.1)
- **dirtyRows:** `Set<number>` — rows mutated since the last flush (§8)

Operations: `gridResize`, `gridLine`, `gridClear`, `gridScroll`, `gridCursorGoto`, `hlAttrDefine`,
`defaultColorsSet`, `modeChange`, `flush`.

### 6.1 Consistency gate

Neovim guarantees that a screen is only coherent at a `flush`. Between flushes the grid can hold
half-applied state. `ShadowScreen.consistent` is therefore set to `false` by **any** grid-mutating
event and set to `true` only by `flush`. Observation tools read the screen only while `consistent`
is `true`; if it is `false` they wait for the next flush. This prevents an agent from ever seeing a
torn frame.

### 6.2 Serialization format

**Decision: plain text rows, one string per row, joined by `\n`. No cursor marker, no row numbers,
no highlight encoding, no trailing-whitespace trimming.**

Rationale: the `wait-until-contains(text)` / `wait-until-not-contains(text)` conditions and every
agent-side assertion do substring matching against this string. Any in-band marker (`|` row
delimiters, a `█` at the cursor, `  1 ` line-number gutters we invented ourselves) would corrupt
those matches and force agents to strip decoration before asserting. Cursor position, row indices,
mode, and size are returned as **separate structured fields** in the observation payload, so no
information is lost — it is simply not mixed into the text channel.

Whitespace is preserved exactly so that column alignment is observable. Double-width cells
serialize as the wide character followed by *nothing* for the `""` continuation cell, so the
rendered string has the same display width as the terminal row.

## 7. Hybrid Observation Model

`nvim_observe` returns both channels in one payload:

```jsonc
{
  "screen": "…row\n…row\n…",     // rendered grid, the source of truth
  "rows": 24, "cols": 80,
  "cursor": { "row": 0, "col": 5 },
  "mode": { "name": "normal", "index": 0 },
  "buffer": { "id": 1, "name": "/abs/path/file.txt" },
  "window": { "id": 1000 },
  "floats": [ { "winId": 1001, "row": 3, "col": 10, "width": 20, "height": 5 } ]
}
```

The `floats` array comes from `nvim_list_wins()` + `nvim_win_get_config()`. Because
`ext_multigrid` is off, floating windows are composited *into* the single grid — the agent sees
their content in `screen` but cannot tell from the text alone which region is a float versus buffer
content. The geometry list resolves that ambiguity without needing a compositor of our own.

## 8. Diff Strategy

**Decision: the MVP diffs by snapshot comparison, not by consuming dirty-row events.**

`nvim_observe_diff` compares the previous serialized snapshot against the current one and returns
changed rows (`{ row, before, after }`) plus cursor/mode/size deltas. This is simple, deterministic,
and fully decoupled from the event processor — a diff can be taken at any time, including across
many flushes, and it cannot desync from the screen because it is derived *from* the screen.

**Highlight changes are deliberately not diffed.** The MVP's text serialization carries no highlight
information (§6.2), so a "highlight 42 was redefined" entry would be noise an agent cannot act on,
and folding the full highlight map into every snapshot would make snapshots far more expensive than
the screens they describe. `hl_attr_define` is still recorded on the screen, so highlight diffing
becomes available the moment a consumer for it exists (a colour-aware observation or PNG render).

However, `UiEventProcessor`/`ShadowScreen` maintain **`dirtyRows: Set<number>`** from day one:
every grid-mutating event records the rows it touched, and the set is cleared when a new frame
begins after a flush. Nothing in the MVP reads it. It exists so that event-driven diffing — cheaper
on very large grids, and able to report "row touched but content identical" — can be added later as
a pure addition, with no change to the architecture and no retrofit of the event handlers.

## 9. MCP Tool Surface

Eight tools. This list is deliberately closed; growth toward a generic Neovim API wrapper is a
non-goal.

| Tool | Parameters | Returns |
|---|---|---|
| `nvim_launch` | `cwd?`, `rows?`, `cols?`, `init?` \| `clean?`, `file?`, `args?` | `sessionId` |
| `nvim_attach` | `address` (Unix socket path or Windows named pipe) | `sessionId` |
| `nvim_observe` | `sessionId` | hybrid observation (§7) |
| `nvim_observe_diff` | `sessionId` | compact diff since last observation (§8) |
| `nvim_input` | `sessionId`, `keys` (supports `<Esc>`, `<C-n>`, `<leader>`, plain text) | keys consumed |
| `nvim_command` | `sessionId`, `command` (Ex command) | ok / error |
| `nvim_wait` | `sessionId`, `condition`, `timeoutMs` | resolved / timeout error |
| `nvim_close` | `sessionId` | ok; **error for attach-mode sessions** |

`nvim_wait` conditions: `redraw`, `screen-change`, `idle(ms)`, `contains(text)`,
`not-contains(text)` — all bounded by `timeoutMs` and failing loudly on timeout.

Input schemas are declared with Zod and validated at the tool boundary.

## 10. Session Lifecycle

### Test mode (server owns the instance)

1. `nvim_launch` spawns `nvim --embed` (plus `--clean`/`-u <init>`, `cwd`, initial file, extra args).
2. `attach({ proc })` over the child's stdio.
3. `uiAttach(cols, rows, { ext_linegrid: true })`.
4. Redraw notifications flow into `UiEventProcessor` → `ShadowScreen`.
5. `nvim_close` (or server shutdown) detaches the UI, quits Neovim, and — if the process has not
   exited within a short grace period — kills it. **No orphan Neovim processes may survive.**

### Attach mode (connect to an existing instance)

1. The user starts `nvim --listen /tmp/nvim.sock` themselves.
2. `nvim_attach` connects the socket, *then* builds the RPC client on it (see §4), and calls
   `uiAttach` as an *additional* UI.
3. `nvim_close` **refuses** the session outright — the server does not own that instance and will
   not terminate it. Attach-mode sessions are detached when the server shuts down.

The refusal is deliberate and follows the spec's "terminates server-launched instances only". The
consequence is that there is no per-session release for attach mode inside a long-running server;
that gap is listed in §15 rather than solved by widening the eight-tool surface.

**Documented attach-mode limitations:** attaching a second UI means Neovim's global screen size
becomes the minimum of all attached UIs, so requesting a size can shrink the human's terminal view.
The observed grid is the *shared* screen — the agent sees exactly what the human sees, including
their cursor movements and mode changes. Attach mode is therefore for observing/reproducing against
a live instance, not for isolated testing.

## 11. Synchronization Strategy

Neovim's redraw stream is asynchronous, so "send input, then read the screen" is a race unless
synchronized. Four mechanisms, in increasing order of robustness:

1. **Flush gate (always on).** Reads never observe a screen mid-frame (§6.1).
2. **Wait-for-redraw / wait-for-screen-change.** Resolve on the next flush, or on the next flush
   whose serialized screen differs from a baseline captured when the wait starts.
3. **Wait-for-idle(N ms).** Resolve once N milliseconds pass with no redraw batch. Good for actions
   that produce *several* frames (a plugin that renders a float after a debounce, a completion popup
   behind an async LSP round trip).
4. **Wait-until-contains / not-contains(text).** Re-check the serialized screen on each flush until
   the substring appears or disappears.

### Edge-triggered vs level-triggered waits

This distinction is the single easiest way to misuse the wait API, and it cost real debugging time
during implementation:

- `redraw`, `screen-change` and `idle` are **edge-triggered**. They describe an *event relative to
  the moment the wait starts*. `nvim_input` resolves when the keys are queued, not when they are
  processed, so the redraw they cause can land on either side of the wait registration. If it lands
  first, `redraw` and `screen-change` block until some unrelated frame arrives (or time out), and
  `idle` can return *immediately* — it only means "quiet right now", which is trivially true when
  the action's own redraw has not started yet.
- `contains` / `not-contains` are **level-triggered**: they test a predicate over current screen
  content and return at once if it already holds. They cannot miss an edge in either direction.

**Therefore: prefer `contains`/`not-contains` whenever the expected result is known.** Reserve
`idle` for "something is going to happen and I do not know its final text", and treat `redraw` /
`screen-change` as low-level primitives. The tool descriptions steer agents the same way.

All conditions take an explicit timeout and fail with an error naming the condition *and including
the screen as it was at the deadline*, so a failed wait is diagnosable rather than a bare timeout.

## 12. Test vs Attach Mode Summary

| | Test mode | Attach mode |
|---|---|---|
| Who owns the process | the server | the user |
| Transport | child stdio (`--embed`) | Unix socket / named pipe (`--listen`) |
| Screen size | requested by the server | min of all attached UIs |
| Isolation | full (`--clean`, own cwd) | none, shares the user's session |
| `nvim_close` | terminates | rejected |
| Primary use | automated testing, bug repro | live observation/debugging |

## 13. Testing Approach

Three tiers:

- **Unit (`test/unit/`)** — `ShadowScreen`, `UiEventProcessor`, serializer, and diff, driven by
  hand-written redraw sequences. No Neovim process involved. Covers: initial grid creation,
  `grid_line` (plain, repeated cells, implicit `hlId` reuse), `grid_clear`, `grid_scroll` (up, down,
  partial region, over-scroll), `grid_resize` (larger and smaller), `grid_cursor_goto`,
  `hl_attr_define`, `mode_change`, the flush consistency gate, dirty-row tracking, Unicode and
  double-width/CJK/emoji/combining characters, text serialization, and diff computation.
- **Smoke (`test/smoke/`)** — a throwaway script, not part of the suite, that validates the
  node-client `uiAttach` notification path against a real Neovim before any domain code is written
  (the kill-switch gate of §14).
- **Integration (`test/integration/`)** — against a real `nvim` binary: the vertical slice
  (launch → attach → observe → input → observe → assert → shutdown), repeated observe/input cycles
  to catch desync and leaks, and a floating-window test. Every integration test asserts that no
  orphan Neovim process survives.

CI runs unit + integration on Linux, macOS, and Windows with Neovim 0.10.x installed.

## 14. Known Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **node-client `uiAttach` is not battle-tested for full UI consumption** — it was built for the plugin host, not for a UI client. | HIGH | Validated by a ~1h smoke test *before* any domain code (§13). **Kill-switch framework:** (1) smoke test shows no notifications or garbled payloads → skip the thin-RPC attempt, pivot to Go (`go-client`'s `AttachUI` is proven); (2) smoke passes but integration reveals subtle issues (dropped/reordered events under load) → build a thin msgpack-RPC layer over Node `net`, time-boxed to one week; (3) thin-RPC misses the time-box → pivot to Go. **Portability note:** `ShadowScreen`, the UI event types, and the tool schemas are pure logic with no node-client dependency, so they port unchanged in structure. |
| **Windows named-pipe edge cases** | MEDIUM | Node's `net.connect()` accepts `\\.\pipe\…` paths; a single `connectToAddress` code path serves all platforms, and Windows is in the CI matrix from Step 1 rather than deferred. |
| **`ext_linegrid` cell-repeat / double-width correctness** | MEDIUM | Modelled directly on Neovim's own `screen.lua`; unit tests cover CJK, emoji, combining characters, and repeat counts explicitly. Getting the `""` continuation cell wrong silently shifts every column to its right, so this is tested rather than assumed. |
| **Redraw volume / performance** | LOW | An editor emits tens to low hundreds of events per user action; the event loop absorbs this easily. Serialization is on-demand, not per-batch. |
| **Floating-window staleness** | LOW | With `ext_linegrid` and no `ext_multigrid` Neovim composites floats itself, so there is no z-order to manage. The only exposure is reading a partially-updated frame, which the flush gate and `wait-for-idle` already close. |
| **`neovim` npm package maintenance has slowed** | LOW | Core msgpack-RPC and `uiAttach` are stable, and the thin-RPC fallback above is the escape hatch. |
| **MCP SDK churn** | LOW | The TypeScript SDK v2 is stable, not beta; the dependency is pinned. |

## 15. Deferred / Known Gaps

Consciously not built for the MVP. Each is a decision, not an oversight.

| Gap | Why deferred | What it would take |
|---|---|---|
| **No per-session release for attach mode** | `nvim_close` refuses attach-mode sessions by spec, and adding a `nvim_detach` would be a ninth tool against a deliberately closed surface (§2). | Either widen `nvim_close` with an explicit `detach: true`, or accept server-shutdown as the only release point. |
| **Highlight/colour diffing** | The text representation carries no colour, so there is no consumer (§8). | Store per-row highlight ids in the snapshot once a colour-aware observation or PNG render exists. |
| **No PNG render** | Explicit non-goal for the MVP. | The grid keeps `{ text, hlId }` per cell and `hl_attr_define` attributes, which is everything a renderer needs; nothing in the model has to change. |
| **`mode_info_set` not stored** | Cursor shape/blink per mode does not affect text observation. | Capture the event in `ShadowScreen` and surface it in `nvim_observe`. |
| **No structured error taxonomy** | Errors are handled pragmatically: tool failures come back as MCP error results carrying Neovim's own message, which is what an agent needs to adapt. | Formalise codes if clients start branching on failure kind rather than reading the message. |
| **No debug/redraw tracing** | Would have to write somewhere other than stdout (§4) and nothing needed it during implementation. | A stderr or file logger gated behind an env var. |
| **Windows named pipes are unit-tested, not integration-tested here** | This machine is Linux; `normalizePipeAddress` is covered by unit tests that pin the platform, and the CI matrix runs the full suite on Windows. | Nothing — CI is the check. |
