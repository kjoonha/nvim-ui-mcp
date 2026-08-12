import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';

export type ToolResult = CallToolResult;

export const sessionIdSchema = z
  .string()
  .describe('Session id returned by nvim_launch or nvim_attach.');

export const cursorSchema = z.object({ row: z.number(), col: z.number() });
export const modeSchema = z.object({ name: z.string(), index: z.number() });
export const sizeSchema = z.object({ rows: z.number(), cols: z.number() });

export function jsonResult<T extends Record<string, unknown>>(payload: T): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Observations lead with the rendered screen as plain text so an agent reads the grid
 * directly, with the structured metadata following as JSON.
 */
export function observationResult<T extends Record<string, unknown>>(
  screen: string,
  payload: T,
): ToolResult {
  // `screen` already leads the text block; omit it from the trailing JSON so it
  // isn't sent twice on the wire. `structuredContent` keeps the full payload.
  const metadata: Record<string, unknown> = { ...payload };
  delete metadata.screen;
  return {
    content: [{ type: 'text', text: `${screen}\n\n${JSON.stringify(metadata, null, 2)}` }],
    structuredContent: payload,
  };
}

/**
 * Tool failures are returned as error results rather than thrown, so the agent sees the
 * reason and can adapt instead of the call failing at the protocol level.
 */
export async function runTool(handler: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await handler();
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}
