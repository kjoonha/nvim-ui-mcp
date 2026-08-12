import type { NeovimSession } from './session.js';

export interface FloatInfo {
  winId: number;
  relative: string;
  row: number;
  col: number;
  width: number;
  height: number;
  zindex: number | null;
}

export interface Observation {
  sessionId: string;
  /** The rendered grid — the authoritative observation. */
  screen: string;
  rows: number;
  cols: number;
  cursor: { row: number; col: number };
  mode: { name: string; index: number };
  buffer: { id: number; name: string };
  window: { id: number };
  /**
   * Geometry of every floating window. With `ext_linegrid` and no `ext_multigrid`
   * Neovim composites floats into the single grid, so their content is already in
   * `screen`; this tells an agent which regions are floats rather than buffer text.
   */
  floats: FloatInfo[];
}

/** Collects buffer/window/float metadata in a single RPC round trip. */
const METADATA_LUA = `
local floats = {}
for _, win in ipairs(vim.api.nvim_list_wins()) do
  local config = vim.api.nvim_win_get_config(win)
  if config.relative ~= nil and config.relative ~= '' then
    floats[#floats + 1] = {
      winId = win,
      relative = config.relative,
      row = config.row or 0,
      col = config.col or 0,
      width = config.width or 0,
      height = config.height or 0,
      zindex = config.zindex or -1,
    }
  end
end
local buf = vim.api.nvim_get_current_buf()
return {
  bufferId = buf,
  bufferName = vim.api.nvim_buf_get_name(buf),
  windowId = vim.api.nvim_get_current_win(),
  floats = floats,
}
`;

interface RawMetadata {
  bufferId?: unknown;
  bufferName?: unknown;
  windowId?: unknown;
  floats?: unknown;
}

/**
 * The hybrid observation: rendered screen plus the structured state needed to
 * interpret it. The screen is read only once the current frame is complete.
 */
export async function buildObservation(session: NeovimSession): Promise<Observation> {
  await session.ensureConsistent();
  const screen = session.text();
  session.markObserved();

  const metadata = await readMetadata(session);

  return {
    sessionId: session.id,
    screen,
    rows: session.screen.rows,
    cols: session.screen.cols,
    cursor: { ...session.screen.cursor },
    mode: { ...session.screen.mode },
    buffer: { id: metadata.bufferId, name: metadata.bufferName },
    window: { id: metadata.windowId },
    floats: metadata.floats,
  };
}

async function readMetadata(session: NeovimSession): Promise<{
  bufferId: number;
  bufferName: string;
  windowId: number;
  floats: FloatInfo[];
}> {
  const raw = (await session.nvim.lua(METADATA_LUA)) as RawMetadata | null;
  return {
    bufferId: toNumber(raw?.bufferId, 0),
    bufferName: typeof raw?.bufferName === 'string' ? raw.bufferName : '',
    windowId: toNumber(raw?.windowId, 0),
    floats: parseFloats(raw?.floats),
  };
}

function parseFloats(value: unknown): FloatInfo[] {
  // An empty Lua table can come back as either an empty list or an empty map.
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const float = entry as Record<string, unknown>;
    const zindex = toNumber(float.zindex, -1);
    return {
      winId: toNumber(float.winId, 0),
      relative: typeof float.relative === 'string' ? float.relative : '',
      row: toNumber(float.row, 0),
      col: toNumber(float.col, 0),
      width: toNumber(float.width, 0),
      height: toNumber(float.height, 0),
      zindex: zindex < 0 ? null : zindex,
    };
  });
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
