# nvim-ui-mcp

**Playwright for Neovim agents.**

`nvim-ui-mcp` lets AI agents **see, interact with, and verify the actual Neovim UI** through the Model Context Protocol.

Unlike existing Neovim MCP servers that primarily expose buffers, diagnostics, and editor APIs, `nvim-ui-mcp` attaches as a real Neovim UI client and observes the rendered screen — including windows, floating UIs, highlights, virtual text, completion menus, messages, and cursor state.

This enables coding agents to do more than operate Neovim: they can **reproduce UI bugs, test plugin behavior, interact with complex workflows, and verify visual results autonomously.**

Think **Playwright, but for Neovim plugin development.**

---

## Requirements

- **Neovim 0.10+** on `PATH`
- **Node.js 22+**
- Linux, macOS, or Windows

## Install

```bash
npm install -g nvim-ui-mcp
```

## MCP client configuration

Claude Code:

```bash
claude mcp add nvim-ui -- npx -y nvim-ui-mcp
```

Or, for any client that reads a JSON config (`claude_desktop_config.json`, `.mcp.json`, …):

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

## Tools

| Tool | Purpose |
|---|---|
| `nvim_launch` | Start an isolated, disposable Neovim this server owns |
| `nvim_attach` | Attach to a running Neovim via its `--listen` address |
| `nvim_observe` | Rendered screen + cursor, mode, size, buffer/window, float geometry |
| `nvim_observe_diff` | Only what changed since the last observation |
| `nvim_input` | Send keys in Neovim notation (`ihello<Esc>`, `<C-n>`, …) |
| `nvim_command` | Run an Ex command |
| `nvim_wait` | Block until a screen condition holds |
| `nvim_close` | Terminate a launched instance (refuses attach-mode sessions) |

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

// 4. Synchronize before looking again — see the note below
nvim_wait    { "sessionId": "nvim-1", "condition": "contains", "text": "hello world" }

// 5. Verify, cheaply
nvim_observe_diff { "sessionId": "nvim-1" }
//          → { "changed": true, "rowChanges": [{ "row": 0, "after": "hello world…" }] }

nvim_close   { "sessionId": "nvim-1" }
```

### Always wait before observing

`nvim_input` and `nvim_command` return as soon as Neovim accepts the request — **not** when the
screen has repainted. Observing immediately races the redraw.

Prefer `contains` / `not-contains` whenever you know what should appear: they test current screen
content, so they work whether the redraw lands before or after the wait starts. `redraw`,
`screen-change` and `idle` are edge-triggered and can miss a repaint that already happened — use
`idle` only when you cannot predict the resulting text.

### Observing floating windows

Neovim composites floats into a single grid, so popup and float content is already in `screen`. The
`floats` array from `nvim_observe` reports each float's `row`, `col`, `width` and `height`, which is
how you tell a completion popup from buffer text at the same coordinates.

### Attach mode

```bash
nvim --listen /tmp/nvim.sock
```

```jsonc
nvim_attach { "address": "/tmp/nvim.sock" }
```

The instance belongs to you, so `nvim_close` refuses it. Note that Neovim sizes the screen to the
smallest attached UI, so requesting a size can shrink your own view.

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

MIT
