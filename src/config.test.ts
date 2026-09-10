import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWriteBridgeEnabled, requireAccessToken } from "./config.js";

describe("requireAccessToken", () => {
  it("fails fast with a clear message when missing", () => {
    assert.throws(() => requireAccessToken({}), /Missing FIGMA_ACCESS_TOKEN/);
    assert.throws(() => requireAccessToken({ FIGMA_ACCESS_TOKEN: "   " }), /personal access token/);
  });

  it("returns a trimmed token", () => {
    assert.equal(requireAccessToken({ FIGMA_ACCESS_TOKEN: " figd_abc " }), "figd_abc");
  });
});

describe("isWriteBridgeEnabled", () => {
  it("is off by default", () => {
    assert.equal(isWriteBridgeEnabled({}), false);
    assert.equal(isWriteBridgeEnabled({ FIGMA_ENABLE_WRITE_BRIDGE: "0" }), false);
    assert.equal(isWriteBridgeEnabled({ FIGMA_ENABLE_WRITE_BRIDGE: "" }), false);
  });

  it("is on for 1/true/yes", () => {
    assert.equal(isWriteBridgeEnabled({ FIGMA_ENABLE_WRITE_BRIDGE: "1" }), true);
    assert.equal(isWriteBridgeEnabled({ FIGMA_ENABLE_WRITE_BRIDGE: "true" }), true);
    assert.equal(isWriteBridgeEnabled({ FIGMA_ENABLE_WRITE_BRIDGE: "YES" }), true);
  });
});
