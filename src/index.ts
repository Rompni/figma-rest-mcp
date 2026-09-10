#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startBridgeFromEnv, type FigmaBridge } from "./bridge.js";
import { isWriteBridgeEnabled, requireAccessToken } from "./config.js";
import { FigmaRestClient } from "./figma-client.js";
import { createFigmaMcpServer } from "./server.js";

async function main(): Promise<void> {
  const token = requireAccessToken();
  const figma = new FigmaRestClient({ token });
  let writeBridge: FigmaBridge | undefined;
  if (isWriteBridgeEnabled()) {
    try {
      writeBridge = await startBridgeFromEnv();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`figma-rest-mcp: write bridge failed to start (${message}). REST tools still run.`);
      throw err;
    }
  }
  const mcp = createFigmaMcpServer(figma, writeBridge ? { writeBridge } : {});
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  if (writeBridge) {
    console.error(
      "figma-rest-mcp: stdio MCP running. REST read + opt-in desktop write (structured commands only).",
    );
  } else {
    console.error("figma-rest-mcp: stdio MCP running (REST-only, headless).");
  }

  const shutdown = async () => {
    await writeBridge?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
