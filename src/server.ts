import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FigmaBridge } from "./bridge.js";
import { registerBridgeTools } from "./bridge-tools.js";
import type { FigmaRestClient } from "./figma-client.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "figma-rest-mcp";
export const SERVER_VERSION = "1.5.0";

export type CreateFigmaMcpServerOptions = {
  /** Opt-in Desktop write. Omit on the default REST-only path. */
  writeBridge?: FigmaBridge;
};

export function createFigmaMcpServer(
  figma: FigmaRestClient,
  options: CreateFigmaMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerTools(server, figma);
  if (options.writeBridge) {
    registerBridgeTools(server, options.writeBridge);
  }
  return server;
}
