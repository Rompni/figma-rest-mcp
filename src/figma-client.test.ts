import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FigmaApiError } from "./errors.js";
import { FIGMA_API_BASE, FigmaRestClient } from "./figma-client.js";

type MockCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(handler: (call: MockCall) => Response): { fetchImpl: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: MockCall = {
      url,
      method: String(init?.method ?? "GET"),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

describe("FigmaRestClient", () => {
  it("sends X-Figma-Token to /v1/me", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { id: "u1", email: "a@b.c" }));
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    const me = await client.whoami();
    assert.deepEqual(me, { id: "u1", email: "a@b.c" });
    assert.equal(calls[0]?.url, `${FIGMA_API_BASE}/me`);
    assert.equal(calls[0]?.headers["x-figma-token"], "figd_test");
  });

  it("gets a file with default depth 2 and parses design URLs", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { name: "File" }));
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.getFile("https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Title");
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/files/AbCdEfGhIjKlMnOpQrStUv");
    assert.equal(url.searchParams.get("depth"), "2");
  });

  it("gets nodes with normalized ids", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { nodes: {} }));
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.getNodes("AbCdEfGhIjKlMnOpQrStUv", ["1-2", "3:4"]);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/files/AbCdEfGhIjKlMnOpQrStUv/nodes");
    assert.equal(url.searchParams.get("ids"), "1:2,3:4");
  });

  it("gets images as png by default", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { images: { "1:2": "https://cdn.example/x.png" } }));
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.getImages("AbCdEfGhIjKlMnOpQrStUv", "1-2");
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/images/AbCdEfGhIjKlMnOpQrStUv");
    assert.equal(url.searchParams.get("format"), "png");
    assert.equal(url.searchParams.get("ids"), "1:2");
  });

  it("gets comments", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { comments: [] }));
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.getComments("https://figma.com/file/AbCdEfGhIjKlMnOpQrStUv/x");
    assert.equal(calls[0]?.url, `${FIGMA_API_BASE}/files/AbCdEfGhIjKlMnOpQrStUv/comments`);
  });

  it("caches whoami within TTL", async () => {
    let hits = 0;
    const { fetchImpl } = mockFetch(() => {
      hits += 1;
      return jsonResponse(200, { id: "u1" });
    });
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.whoami();
    await client.whoami();
    assert.equal(hits, 1);
  });

  it("maps 401 with REST-not-MCP wording", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse(401, { err: "Invalid token" }));
    const client = new FigmaRestClient({ token: "bad", fetchImpl });
    await assert.rejects(
      () => client.whoami(),
      (err: unknown) => {
        assert.ok(err instanceof FigmaApiError);
        assert.equal(err.status, 401);
        assert.match(err.message, /401 Unauthorized/);
        assert.match(err.message, /official MCP/);
        return true;
      },
    );
  });

  it("retries 429 honoring Retry-After then succeeds", async () => {
    const waits: number[] = [];
    let hits = 0;
    const { fetchImpl } = mockFetch(() => {
      hits += 1;
      if (hits === 1) {
        return jsonResponse(429, { err: "Rate limit" }, { "retry-after": "2" });
      }
      return jsonResponse(200, { name: "ok" });
    });
    const client = new FigmaRestClient({
      token: "figd_test",
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const body = await client.getFileMeta("AbCdEfGhIjKlMnOpQrStUv");
    assert.deepEqual(body, { name: "ok" });
    assert.equal(hits, 2);
    assert.deepEqual(waits, [2000]);
  });

  it("maps 429 including Retry-After after retries are exhausted", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(429, { err: "Rate limit" }, { "retry-after": "15" }));
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl, maxRetries: 2, sleep: async () => undefined });
    await assert.rejects(
      () => client.getFile("AbCdEfGhIjKlMnOpQrStUv"),
      (err: unknown) => {
        assert.ok(err instanceof FigmaApiError);
        assert.equal(err.status, 429);
        assert.equal(err.retryAfterSeconds, 15);
        assert.match(err.message, /REST rate limit/);
        return true;
      },
    );
    assert.equal(calls.length, 3);
  });

  it("gets image fills from /files/{key}/images", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { images: { ref: "https://cdn.example/a.png" } }));
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.getImageFills("AbCdEfGhIjKlMnOpQrStUv");
    assert.equal(calls[0]?.url, `${FIGMA_API_BASE}/files/AbCdEfGhIjKlMnOpQrStUv/images`);
  });

  it("lists projects and project files", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.includes("/projects/99/files")) {
        return jsonResponse(200, { name: "Proj", files: [] });
      }
      return jsonResponse(200, { name: "Team", projects: [{ id: "99", name: "Proj" }] });
    });
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.listProjects("https://www.figma.com/files/team/123");
    await client.listProjectFiles("99");
    assert.equal(calls[0]?.url, `${FIGMA_API_BASE}/teams/123/projects`);
    assert.equal(calls[1]?.url, `${FIGMA_API_BASE}/projects/99/files`);
  });

  it("auto-paginates team components via meta.cursor.after", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      const url = new URL(call.url);
      if (!url.searchParams.get("after")) {
        return jsonResponse(200, {
          meta: { components: [{ key: "a" }], cursor: { after: 10 } },
        });
      }
      return jsonResponse(200, { meta: { components: [{ key: "b" }] } });
    });
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    const body = (await client.getTeamComponents("123")) as {
      meta: { components: Array<{ key: string }> };
    };
    assert.deepEqual(
      body.meta.components.map((c) => c.key),
      ["a", "b"],
    );
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1]!.url).searchParams.get("after"), "10");
  });

  it("auto-paginates file versions via pagination.next_page", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.includes("before=9")) {
        return jsonResponse(200, { versions: [{ id: "v2" }], pagination: {} });
      }
      return jsonResponse(200, {
        versions: [{ id: "v1" }],
        pagination: { next_page: `${FIGMA_API_BASE}/files/AbCdEfGhIjKlMnOpQrStUv/versions?before=9` },
      });
    });
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    const body = (await client.getFileVersions("AbCdEfGhIjKlMnOpQrStUv")) as { versions: Array<{ id: string }> };
    assert.deepEqual(
      body.versions.map((v) => v.id),
      ["v1", "v2"],
    );
    assert.equal(calls.length, 2);
  });

  it("posts comments as JSON", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { id: "c1" }));
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.postComment("AbCdEfGhIjKlMnOpQrStUv", { message: "Looks good" });
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.body, JSON.stringify({ message: "Looks good" }));
  });

  it("talks to Webhooks v2 and mentions scopes on 403", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse(200, { id: "wh1" });
      }
      if (call.url.includes("/v2/webhooks/wh1")) {
        return jsonResponse(200, { id: "wh1", event_type: "FILE_UPDATE" });
      }
      return jsonResponse(200, { webhooks: [{ id: "wh1" }], pagination: {} });
    });
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.listWebhooks({ context: "team", contextId: "https://www.figma.com/files/team/123" });
    await client.getWebhook("wh1");
    await client.createWebhook({
      event_type: "FILE_UPDATE",
      context: "team",
      context_id: "123",
      endpoint: "https://example.com/hook",
      passcode: "secret",
    });
    assert.equal(calls[0]?.url.startsWith("https://api.figma.com/v2/webhooks"), true);
    assert.equal(new URL(calls[0]!.url).searchParams.get("context_id"), "123");
    assert.equal(calls[1]?.url, "https://api.figma.com/v2/webhooks/wh1");
    assert.equal(calls[2]?.method, "POST");
    assert.equal(JSON.parse(calls[2]!.body ?? "{}").context_id, "123");

    const denied = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: async () => jsonResponse(403, { err: "Invalid scope" }),
    });
    await assert.rejects(
      () => denied.listWebhooks({ context: "team", contextId: "123" }),
      (err: unknown) => {
        assert.ok(err instanceof FigmaApiError);
        assert.match(err.message, /webhooks:read/);
        return true;
      },
    );
  });

  it("gets a published style by library key", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { meta: { key: "s1" } }));
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    await client.getStyle("s1");
    assert.equal(calls[0]?.url, `${FIGMA_API_BASE}/styles/s1`);
  });

  it("bundles image fills from a trusted CDN and skips untrusted hosts", async () => {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.includes("api.figma.com")) {
        return jsonResponse(200, {
          images: {
            good: "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/a",
            bad: "https://evil.example/x.png",
          },
        });
      }
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    });
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    const bundle = await client.bundleImageFills("AbCdEfGhIjKlMnOpQrStUv");
    assert.equal(bundle.assets.good?.skipped, undefined);
    assert.match(bundle.assets.good?.dataUri ?? "", /^data:image\/png;base64,/);
    assert.equal(bundle.assets.bad?.skipped, true);
    assert.match(bundle.assets.bad?.reason ?? "", /untrusted host/);
  });

  it("maps GET /nodes into getDesignContextLite", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse(200, {
        nodes: {
          "1:2": {
            document: {
              id: "1:2",
              name: "Hero",
              type: "FRAME",
              layoutMode: "HORIZONTAL",
              itemSpacing: 8,
              children: [],
            },
            components: {},
          },
        },
      }),
    );
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    const ctx = await client.getDesignContextLite("AbCdEfGhIjKlMnOpQrStUv", "1-2");
    assert.equal(ctx.root.name, "Hero");
    assert.equal(ctx.root.layout?.flexDirection, "row");
    assert.equal(ctx.root.layout?.gap, 8);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/v1/files/AbCdEfGhIjKlMnOpQrStUv/nodes");
    assert.equal(url.searchParams.get("ids"), "1:2");
    assert.equal(url.searchParams.get("depth"), "6");
  });

  it("getVariableDefs uses local variables when the REST map is present", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse(200, {
        meta: {
          variableCollections: {
            c1: { id: "c1", name: "C", defaultModeId: "m", modes: [{ modeId: "m", name: "A" }] },
          },
          variables: {
            v1: {
              id: "v1",
              name: "color/brand",
              variableCollectionId: "c1",
              resolvedType: "COLOR",
              valuesByMode: { m: { r: 1, g: 0, b: 0, a: 1 } },
            },
          },
        },
      }),
    );
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    const defs = await client.getVariableDefs("AbCdEfGhIjKlMnOpQrStUv");
    assert.equal(defs.source, "variables");
    assert.equal(defs.variables[0]?.name, "color/brand");
    assert.match(calls[0]!.url, /\/variables\/local/);
  });

  it("getVariableDefs falls back after a variables 403", async () => {
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.includes("/variables/")) {
        return jsonResponse(403, { err: "Invalid scope" });
      }
      if (call.url.endsWith("/styles")) {
        return jsonResponse(200, { meta: { styles: [{ key: "k", node_id: "10:1", style_type: "FILL", name: "Brand" }] } });
      }
      return jsonResponse(200, { nodes: {} });
    });
    const client = new FigmaRestClient({ token: "figd_test", fetchImpl });
    const defs = await client.getVariableDefs("AbCdEfGhIjKlMnOpQrStUv", { nodeId: "1:2" });
    assert.notEqual(defs.source, "variables");
    assert.equal(defs.variablesAvailable, false);
    assert.ok(defs.warnings.some((line) => /file_variables:read/.test(line)));
  });
});
