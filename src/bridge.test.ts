import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import {
  DISCONNECTED_MESSAGE,
  isLoopbackAddress,
  listenBridge,
  type FigmaBridgeServer,
} from "./bridge.js";

describe("isLoopbackAddress", () => {
  it("accepts IPv4, IPv6, and mapped IPv4 loopback", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("8.8.8.8"), false);
  });
});

describe("FigmaBridgeServer", () => {
  let bridge: FigmaBridgeServer | undefined;

  after(async () => {
    await bridge?.close();
  });

  async function start(): Promise<FigmaBridgeServer> {
    await bridge?.close();
    bridge = await listenBridge({ token: "secret-token", host: "127.0.0.1", port: 0 });
    return bridge;
  }

  it("rejects HTTP without the bridge token and reports disconnected status", async () => {
    const server = await start();
    const unauth = await fetch(`http://127.0.0.1:${server.port}/status`);
    assert.equal(unauth.status, 401);
    const status = await fetch(`http://127.0.0.1:${server.port}/status`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(status.status, 200);
    const body = (await status.json()) as { connected: boolean; running: boolean };
    assert.equal(body.running, true);
    assert.equal(body.connected, false);
  });

  it("fails immediately when the plugin is not connected", async () => {
    const server = await start();
    await assert.rejects(() => server.runCommand({ op: "create_frame", name: "x" }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, DISCONNECTED_MESSAGE);
      return true;
    });
  });

  it("round-trips a job to a connected plugin socket", async () => {
    const server = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/plugin?token=secret-token`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.send(
        JSON.stringify({
          type: "hello",
          token: "secret-token",
          fileName: "Demo",
          fileKey: "AbCdEfGhIjKlMnOpQrStUv",
          editorType: "figma",
          pageName: "Page 1",
        }),
      );
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type?: string; id?: string };
        if (msg.type === "command" && msg.id) {
          ws.send(
            JSON.stringify({
              type: "result",
              id: msg.id,
              ok: true,
              result: { createdNodeIds: ["1:2"] },
              createdNodeIds: ["1:2"],
            }),
          );
        }
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(server.status().connected, true);
      assert.equal(server.status().plugin?.fileName, "Demo");
      const result = await server.runCommand({ op: "create_frame", name: "Box", width: 240, height: 120 });
      assert.equal(result.ok, true);
      assert.deepEqual(result.createdNodeIds, ["1:2"]);
    } finally {
      ws.close();
    }
  });

  it("times out if the plugin never answers", async () => {
    const server = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/plugin?token=secret-token`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      await assert.rejects(() => server.runCommand({ op: "set_text", id: "1:2", characters: "x" }, { timeoutMs: 80 }), /Timed out after 80ms/);
    } finally {
      ws.close();
    }
  });

  it("rejects a websocket with the wrong token", async () => {
    const server = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/plugin?token=nope`);
    const closed = await new Promise<number | undefined>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.on("unexpected-response", () => resolve(401));
      ws.on("error", () => resolve(undefined));
    });
    assert.ok(closed === 401 || closed === 1006 || closed === undefined);
  });
});
