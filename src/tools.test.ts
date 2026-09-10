import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TtlCache } from "./cache.js";
import { FigmaRestClient } from "./figma-client.js";
import { createFigmaMcpServer } from "./server.js";
import { DisabledBridge, type FigmaBridge } from "./bridge.js";

const cardFixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/design-context-card.json"), "utf8"),
) as unknown;
const variablesFixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/variables-local.json"), "utf8"),
) as unknown;
const stylesFixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/file-styles.json"), "utf8"),
) as unknown;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function connectClient(
  figma: FigmaRestClient,
  writeBridge?: FigmaBridge,
): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const mcp = createFigmaMcpServer(figma, writeBridge ? { writeBridge } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await mcp.close();
    },
  };
}

const REQUIRED_TOOLS = [
  "whoami",
  "get_file",
  "get_nodes",
  "get_design_context_lite",
  "get_images",
  "get_comments",
  "list_projects",
  "list_project_files",
  "get_file_versions",
  "get_file_meta",
  "get_image_fills",
  "get_file_components",
  "get_file_component_sets",
  "get_file_styles",
  "get_team_components",
  "get_team_styles",
  "get_component",
  "get_style",
  "get_team_component_sets",
  "find_nodes",
  "extract_text",
  "get_local_variables",
  "get_published_variables",
  "get_variable_defs",
  "get_design_tokens_fallback",
  "get_dev_resources",
  "post_comment",
  "delete_comment",
  "get_comment_reactions",
  "post_comment_reaction",
  "delete_comment_reaction",
  "list_webhooks",
  "get_webhook",
  "create_webhook",
  "update_webhook",
  "delete_webhook",
  "bundle_image_fills",
  "render_nodes_as_data_uri",
];

const WRITE_TOOLS = ["bridge_status", "create_frame", "set_text"];
const EVAL_TOOLS = ["use_figma"];

describe("MCP tools", () => {
  it("lists REST tools including get_design_context_lite and hides write/eval by default", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async () => jsonResponse(200, {}),
      cache: new TtlCache(60_000),
    });
    const { client, close } = await connectClient(figma);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      for (const name of REQUIRED_TOOLS) {
        assert.ok(names.includes(name), `missing tool ${name}`);
      }
      assert.ok(!names.includes("parse_team_id"));
      for (const name of WRITE_TOOLS) {
        assert.ok(!names.includes(name), `default surface should not expose ${name}`);
      }
      for (const name of EVAL_TOOLS) {
        assert.ok(!names.includes(name), `eval tool ${name} must not be registered`);
      }
    } finally {
      await close();
    }
  });

  it("registers allowlisted write tools only when a write bridge is passed", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async () => jsonResponse(200, {}),
    });
    const { client, close } = await connectClient(figma, new DisabledBridge());
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      for (const name of WRITE_TOOLS) {
        assert.ok(names.includes(name), `missing write tool ${name}`);
      }
      assert.ok(!names.includes("use_figma"));
    } finally {
      await close();
    }
  });

  it("whoami returns JSON from GET /v1/me", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async (input) => {
        assert.equal(String(input), "https://api.figma.com/v1/me");
        return jsonResponse(200, { handle: "ada", email: "ada@example.com" });
      },
    });
    const { client, close } = await connectClient(figma);
    try {
      const result = await client.callTool({ name: "whoami", arguments: {} });
      assert.equal(result.isError, undefined);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      assert.match(text, /ada@example.com/);
    } finally {
      await close();
    }
  });

  it("returns a REST 403 error as an MCP tool error", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async () => jsonResponse(403, { err: "Forbidden" }),
    });
    const { client, close } = await connectClient(figma);
    try {
      const result = await client.callTool({
        name: "get_file",
        arguments: { file: "AbCdEfGhIjKlMnOpQrStUv" },
      });
      assert.equal(result.isError, true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      assert.match(text, /403 Forbidden/);
      assert.match(text, /not a seat\/tool-call quota from Figma's official MCP/);
    } finally {
      await close();
    }
  });

  it("find_nodes returns slim matches from a file tree", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async () =>
        jsonResponse(200, {
          document: {
            id: "0:0",
            name: "Document",
            type: "DOCUMENT",
            children: [{ id: "1:2", name: "Checkout", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } }],
          },
        }),
    });
    const { client, close } = await connectClient(figma);
    try {
      const result = await client.callTool({
        name: "find_nodes",
        arguments: { file: "AbCdEfGhIjKlMnOpQrStUv", name: "check" },
      });
      assert.equal(result.isError, undefined);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      assert.match(text, /"id": "1:2"/);
      assert.match(text, /Checkout/);
      assert.doesNotMatch(text, /prototypeDevice/);
    } finally {
      await close();
    }
  });

  it("get_design_context_lite returns slim codegen context from REST nodes", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        assert.equal(url.pathname, "/v1/files/AbCdEfGhIjKlMnOpQrStUv/nodes");
        assert.equal(url.searchParams.get("ids"), "2:1");
        return jsonResponse(200, cardFixture);
      },
    });
    const { client, close } = await connectClient(figma);
    try {
      const result = await client.callTool({
        name: "get_design_context_lite",
        arguments: {
          file: "https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Card?node-id=2-1",
        },
      });
      assert.equal(result.isError, undefined);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      const payload = JSON.parse(text) as {
        tool: string;
        root: { layout?: { flexDirection?: string }; children?: Array<{ text?: { characters?: string } }> };
      };
      assert.equal(payload.tool, "get_design_context_lite");
      assert.equal(payload.root.layout?.flexDirection, "column");
      assert.match(text, /Ship faster/);
      assert.match(text, /abc123ref/);
      assert.doesNotMatch(text, /use_figma/);
      assert.doesNotMatch(text, /data:image/);
    } finally {
      await close();
    }
  });

  it("get_variable_defs shapes local variables for codegen", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        assert.match(url.pathname, /\/variables\/local$/);
        return jsonResponse(200, variablesFixture);
      },
    });
    const { client, close } = await connectClient(figma);
    try {
      const result = await client.callTool({
        name: "get_variable_defs",
        arguments: { file: "AbCdEfGhIjKlMnOpQrStUv" },
      });
      assert.equal(result.isError, undefined);
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]?.text ?? "") as {
        source: string;
        variables: Array<{ name: string }>;
      };
      assert.equal(payload.source, "variables");
      assert.ok(payload.variables.some((item) => item.name === "color/primary"));
    } finally {
      await close();
    }
  });

  it("get_variable_defs falls back to styles/inferred on variables 403", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/variables/")) {
          return jsonResponse(403, { err: "Invalid scope" });
        }
        if (url.pathname.endsWith("/styles")) {
          return jsonResponse(200, stylesFixture);
        }
        if (url.pathname.endsWith("/nodes")) {
          return jsonResponse(200, cardFixture);
        }
        return jsonResponse(404, { err: "no" });
      },
    });
    const { client, close } = await connectClient(figma);
    try {
      const result = await client.callTool({
        name: "get_variable_defs",
        arguments: { file: "AbCdEfGhIjKlMnOpQrStUv", node_id: "2:1" },
      });
      assert.equal(result.isError, undefined);
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]?.text ?? "") as {
        source: string;
        variablesAvailable: boolean;
        variables: Array<{ inferred?: boolean; name: string }>;
        warnings: string[];
      };
      assert.notEqual(payload.source, "variables");
      assert.equal(payload.variablesAvailable, false);
      assert.ok(payload.warnings.some((line) => /Enterprise|file_variables:read/i.test(line)));
      assert.ok(payload.variables.some((item) => item.inferred === true));
    } finally {
      await close();
    }
  });

  it("get_variable_defs with fallback false surfaces the Enterprise 403", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async () => jsonResponse(403, { err: "Forbidden" }),
    });
    const { client, close } = await connectClient(figma);
    try {
      const result = await client.callTool({
        name: "get_variable_defs",
        arguments: { file: "AbCdEfGhIjKlMnOpQrStUv", fallback: false },
      });
      assert.equal(result.isError, true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      assert.match(text, /Enterprise/);
      assert.match(text, /file_variables:read/);
    } finally {
      await close();
    }
  });

  it("get_design_context_lite include_tokens attaches a compact token summary", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/nodes")) {
          return jsonResponse(200, cardFixture);
        }
        if (url.pathname.includes("/variables/local")) {
          return jsonResponse(200, variablesFixture);
        }
        return jsonResponse(404, {});
      },
    });
    const { client, close } = await connectClient(figma);
    try {
      const result = await client.callTool({
        name: "get_design_context_lite",
        arguments: { file: "AbCdEfGhIjKlMnOpQrStUv", node_id: "2:1", include_tokens: true },
      });
      assert.equal(result.isError, undefined);
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]?.text ?? "") as {
        tokens?: { source: string; tokens: Array<{ name: string }> };
      };
      assert.equal(payload.tokens?.source, "variables");
      assert.ok((payload.tokens?.tokens.length ?? 0) > 0);
    } finally {
      await close();
    }
  });

  it("create_frame fails immediately when the plugin is disconnected", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async () => jsonResponse(200, {}),
    });
    const { client, close } = await connectClient(figma, new DisabledBridge());
    try {
      const result = await client.callTool({
        name: "create_frame",
        arguments: { name: "Box" },
      });
      assert.equal(result.isError, true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      assert.match(text, /FIGMA_ENABLE_WRITE_BRIDGE|REST-only/i);
    } finally {
      await close();
    }
  });

  it("create_frame returns node ids from a connected mock bridge", async () => {
    const figma = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async () => jsonResponse(200, {}),
    });
    const mock: FigmaBridge = {
      status: () => ({
        running: true,
        host: "127.0.0.1",
        port: 3845,
        authRequired: true,
        connected: true,
        plugin: { fileName: "Demo", fileKey: "AbCdEfGhIjKlMnOpQrStUv", connectedAt: 1 },
      }),
      runCommand: async (command) => ({
        ok: true,
        result: { op: command.op },
        createdNodeIds: ["12:3"],
      }),
      close: async () => undefined,
    };
    const { client, close } = await connectClient(figma, mock);
    try {
      const result = await client.callTool({
        name: "create_frame",
        arguments: { name: "From MCP", width: 240, height: 120 },
      });
      assert.equal(result.isError, undefined);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      assert.match(text, /12:3/);
    } finally {
      await close();
    }
  });
});
