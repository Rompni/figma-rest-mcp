import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFileKey } from "./parse-file-key.js";
import { parseNodeId } from "./node-ids.js";

describe("parseFileKey", () => {
  it("accepts a raw key", () => {
    assert.equal(parseFileKey("AbCdEfGhIjKlMnOpQrStUv"), "AbCdEfGhIjKlMnOpQrStUv");
  });

  it("parses design URLs", () => {
    assert.equal(
      parseFileKey("https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/My-File"),
      "AbCdEfGhIjKlMnOpQrStUv",
    );
  });

  it("parses file URLs without protocol or www", () => {
    assert.equal(parseFileKey("figma.com/file/AbCdEfGhIjKlMnOpQrStUv/Title"), "AbCdEfGhIjKlMnOpQrStUv");
  });

  it("parses proto, board, and community URLs", () => {
    assert.equal(
      parseFileKey("https://figma.com/proto/AbCdEfGhIjKlMnOpQrStUv/Proto?node-id=1-2"),
      "AbCdEfGhIjKlMnOpQrStUv",
    );
    assert.equal(parseFileKey("https://www.figma.com/board/AbCdEfGhIjKlMnOpQrStUv/FigJam"), "AbCdEfGhIjKlMnOpQrStUv");
    assert.equal(parseFileKey("https://www.figma.com/community/file/123456789"), "123456789");
  });

  it("trims whitespace", () => {
    assert.equal(parseFileKey("  AbCdEfGhIjKlMnOpQrStUv  "), "AbCdEfGhIjKlMnOpQrStUv");
  });

  it("rejects empty and junk input", () => {
    assert.throws(() => parseFileKey(""), /Empty/);
    assert.throws(() => parseFileKey("https://example.com/not-figma"), /Could not parse/);
    assert.throws(() => parseFileKey("not a key!"), /Could not parse/);
  });
});

describe("parseNodeId", () => {
  it("normalizes 1-2 and reads node-id from a design URL", () => {
    assert.equal(parseNodeId("1-2"), "1:2");
    assert.equal(parseNodeId("1:2"), "1:2");
    assert.equal(
      parseNodeId("https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Title?node-id=12-34"),
      "12:34",
    );
  });

  it("rejects a Figma URL without node-id", () => {
    assert.throws(
      () => parseNodeId("https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/Title"),
      /node-id/,
    );
  });
});
