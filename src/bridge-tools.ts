import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DisabledBridge, type FigmaBridge } from "./bridge.js";
import { FigmaApiError } from "./errors.js";

const writeHint = { readOnlyHint: false, openWorldHint: true, destructiveHint: true } as const;
const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const text =
    err instanceof FigmaApiError ? err.message : err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/** Registered only when FIGMA_ENABLE_WRITE_BRIDGE=1. No free-form JS. */
export function registerBridgeTools(server: McpServer, bridge: FigmaBridge = new DisabledBridge()): void {
  server.registerTool(
    "bridge_status",
    {
      title: "Canvas bridge status",
      description:
        "Opt-in Desktop write: is the local Figma plugin connected? REST tools do not need this. Not registered unless FIGMA_ENABLE_WRITE_BRIDGE=1.",
      annotations: readOnly,
    },
    async () => jsonResult(bridge.status()),
  );

  server.registerTool(
    "create_frame",
    {
      title: "Create a frame",
      description:
        "Opt-in Desktop write: create a FRAME on the current page via allowlisted Plugin API (not REST, not eval). Requires Figma Desktop + companion plugin.",
      inputSchema: {
        name: z.string().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
      },
      annotations: writeHint,
    },
    async ({ name, width, height, x, y }) => {
      try {
        const result = await bridge.runCommand({ op: "create_frame", name, width, height, x, y });
        if (!result.ok) {
          return errorResult(new Error(result.error ?? "create_frame failed."));
        }
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "set_text",
    {
      title: "Set text characters",
      description:
        "Opt-in Desktop write: load the node's font (or Inter Regular) then set characters. Allowlisted command, not free-form JS.",
      inputSchema: {
        id: z.string().min(1).describe("Text node id."),
        characters: z.string().describe("New copy."),
      },
      annotations: writeHint,
    },
    async ({ id, characters }) => {
      try {
        const result = await bridge.runCommand({ op: "set_text", id, characters });
        if (!result.ok) {
          return errorResult(new Error(result.error ?? "set_text failed."));
        }
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
