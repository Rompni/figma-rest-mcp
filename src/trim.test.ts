import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyFileMode } from "./trim.js";

const tree = {
  name: "File",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    prototypeDevice: { type: "NONE" },
    children: [
      {
        id: "1:1",
        name: "Page",
        type: "CANVAS",
        styleOverrideTable: { "1": {} },
        interactions: [{ foo: true }],
        children: [
          {
            id: "1:2",
            name: "Hero",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
            characters: "nope",
            prototypeDevice: "x",
          },
        ],
      },
    ],
  },
};

describe("applyFileMode", () => {
  it("keeps noisy keys in full mode", () => {
    const full = applyFileMode(tree, "full") as typeof tree;
    assert.equal(full.document.prototypeDevice.type, "NONE");
  });

  it("strips noisy keys in trim mode", () => {
    const trimmed = applyFileMode(tree, "trim") as typeof tree;
    assert.equal(trimmed.name, "File");
    assert.equal(trimmed.document.prototypeDevice, undefined);
    assert.equal(trimmed.document.children[0]?.styleOverrideTable, undefined);
    assert.equal(trimmed.document.children[0]?.interactions, undefined);
    assert.equal(trimmed.document.children[0]?.children[0]?.name, "Hero");
  });

  it("keeps only summary fields in summary mode", () => {
    const summary = applyFileMode(tree, "summary") as {
      document: { children: Array<{ children: Array<Record<string, unknown>> }> };
    };
    const hero = summary.document.children[0]?.children[0];
    assert.deepEqual(Object.keys(hero ?? {}).sort(), [
      "absoluteBoundingBox",
      "characters",
      "id",
      "name",
      "type",
    ]);
  });
});
