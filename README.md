<div align="center">

# nvim-ui-mcp

**Playwright for Neovim agents.**

An MCP server that lets AI agents *see, act on, and verify* the real, rendered Neovim UI —
not just buffer text and API state.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![Neovim](https://img.shields.io/badge/neovim-0.10%2B-57A143.svg)](https://neovim.io)
[![npm](https://img.shields.io/npm/v/nvim-ui-mcp.svg)](https://www.npmjs.com/package/nvim-ui-mcp)

</div>

---

<p align="center">
Most Neovim MCP servers expose buffers, diagnostics, and editor APIs.<br>
<code>nvim-ui-mcp</code> attaches as a real Neovim UI client and hands the agent the
<b>rendered screen</b> — windows, floats, completion menus, cursor, and mode —
so it can reproduce bugs, drive plugin workflows, and verify visual results
the same way a human staring at a terminal would.
</p>

<p align="center">Think <b>Playwright, but for Neovim.</b></p>

## Table of Contents

<ul>
  <li><a href="#requirements">Requirements</a></li>
  <li><a href="#installation">Installation</a></li>
  <li><a href="#mcp-client-configuration">MCP Client Configuration</a></li>
  <li><a href="#tools">Tools</a></li>
  <li><a href="#usage">Usage</a></li>
  <li><a href="#gotchas">Gotchas</a></li>
  <li><a href="#attach-mode">Attach Mode</a></li>
  <li><a href="#development">Development</a></li>
  <li><a href="#license">License</a></li>
</ul>

## Requirements

<table>
  <tr><td><b>Neovim</b></td><td>0.10+, on <code>PATH</code></td></tr>
  <tr><td><b>Node.js</b></td><td>22+</td></tr>
  <tr><td><b>OS</b></td><td>Linux, macOS, or Windows</td></tr>
</table>

## Installation

```bash
npm install -g nvim-ui-mcp
```

## MCP Client Configuration

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add nvim-ui -- npx -y nvim-ui-mcp
```

</details>

<details>
<summary><b>Any JSON-config client</b> (<code>claude_desktop_config.json</code>, <code>.mcp.json</code>, …)</summary>

```json
{
  "mcpServers": {
    "nvim-ui": {
      "command": "npx",
      "args": ["-y", "nvim-ui-mcp"]
    }
  }
}
```

</details>

## Tools

Exactly 8 tools — deliberately not a generic `nvim_*` API wrapper.

<table>
  <thead>
    <tr><th>Tool</th><th>Purpose</th></tr>
  </thead>
  <tbody>
    <tr><td><code>nvim_launch</code></td><td>Start an isolated, disposable Neovim this server owns</td></tr>
    <tr><td><code>nvim_attach</code></td><td>Attach to a running Neovim via its <code>--listen</code> address</td></tr>
    <tr><td><code>nvim_observe</code></td><td>Rendered screen + cursor, mode, size, buffer/window, float geometry</td></tr>
    <tr><td><code>nvim_observe_diff</code></td><td>Only what changed since the last observation</td></tr>
    <tr><td><code>nvim_input</code></td><td>Send keys in Neovim notation (<code>ihello&lt;Esc&gt;</code>, <code>&lt;C-n&gt;</code>, …)</td></tr>
    <tr><td><code>nvim_command</code></td><td>Run an Ex command</td></tr>
    <tr><td><code>nvim_wait</code></td><td>Block until a screen condition holds</td></tr>
    <tr><td><code>nvim_close</code></td><td>Terminate a launched instance (refuses attach-mode sessions)</td></tr>
  </tbody>
</table>

## Usage

The loop is **observe → act → wait → observe**:

```jsonc
// 1. Start an isolated instance
nvim_launch  { "clean": true, "rows": 24, "cols": 80 }
//          → { "sessionId": "nvim-1", ... }

// 2. Look at the real screen
nvim_observe { "sessionId": "nvim-1" }
//          → { "screen": "…24 rows of text…", "cursor": {...}, "mode": {...} }

// 3. Act
nvim_input   { "sessionId": "nvim-1", "keys": "ihello world<Esc>" }

// 4. Synchronize before looking again — see Gotchas below
nvim_wait    { "sessionId": "nvim-1", "condition": "contains", "text": "hello world" }

// 5. Verify, cheaply
nvim_observe_diff { "sessionId": "nvim-1" }
//          → { "changed": true, "rowChanges": [{ "row": 0, "after": "hello world…" }] }

nvim_close   { "sessionId": "nvim-1" }
```

## Gotchas

<details open>
<summary><b>Always wait before observing</b></summary>
<br>

`nvim_input` and `nvim_command` return as soon as Neovim accepts the request — **not** when the
screen has repainted. Observing immediately races the redraw.

</details>

<details open>
<summary><b>Prefer level-triggered waits</b></summary>
<br>

`contains` / `not-contains` test current screen content, so they work whether the redraw lands
before or after the wait started. `redraw`, `screen-change`, and `idle` are edge-triggered and can
miss a repaint that already happened — use `idle` only when you cannot predict the resulting text.

</details>

<details>
<summary><b>Floating windows are already in <code>screen</code></b></summary>
<br>

Neovim composites floats into a single grid, so popup and float content is already in the
rendered text. The `floats` array from `nvim_observe` reports each float's `row`, `col`, `width`,
and `height` — how you tell a completion popup from buffer text at the same coordinates.

</details>

## Attach Mode

```bash
nvim --listen /tmp/nvim.sock
```

```jsonc
nvim_attach { "address": "/tmp/nvim.sock" }
```

The instance belongs to you, so `nvim_close` refuses it. Neovim sizes the screen to the smallest
attached UI, so requesting a size can shrink your own view.

## Development

```bash
npm install
npm test          # unit + integration, needs a real nvim binary
npm run typecheck
npm run lint
npm run build
```

See [DESIGN.md](./DESIGN.md) for the architecture, the UI event pipeline, and the known gaps.

## License

<a href="./LICENSE">MIT</a>
