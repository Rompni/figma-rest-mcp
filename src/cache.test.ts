import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TtlCache } from "./cache.js";

describe("TtlCache", () => {
  it("returns stored values before TTL", async () => {
    let now = 1_000;
    const cache = new TtlCache(60_000, () => now);
    cache.set("me", { id: "1" });
    assert.deepEqual(cache.get("me"), { id: "1" });
    now = 60_999;
    assert.deepEqual(cache.get("me"), { id: "1" });
  });

  it("expires after TTL", () => {
    let now = 1_000;
    const cache = new TtlCache(60_000, () => now);
    cache.set("file:abc", { name: "x" });
    now = 61_000;
    assert.equal(cache.get("file:abc"), undefined);
  });

  it("wrap loads once within TTL", async () => {
    let now = 0;
    const cache = new TtlCache(60_000, () => now);
    let loads = 0;
    const first = await cache.wrap("nodes:a", async () => {
      loads += 1;
      return { ok: true };
    });
    const second = await cache.wrap("nodes:a", async () => {
      loads += 1;
      return { ok: false };
    });
    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true });
    assert.equal(loads, 1);
  });
});
