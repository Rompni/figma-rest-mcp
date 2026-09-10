import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractText, findNodes } from "./tree.js";

const file = {
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:1",
        name: "Page 1",
        type: "CANVAS",
        children: [
          {
            id: "2:1",
            name: "Hero / Desktop",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
            children: [
              {
                id: "3:1",
                name: "Headline",
                type: "TEXT",
                characters: "Ship faster",
              },
            ],
          },
          {
            id: "2:2",
            name: "Footer",
            type: "FRAME",
          },
        ],
      },
    ],
  },
};

describe("findNodes", () => {
  it("filters by substring name and returns a slim record", () => {
    const matches = findNodes(file, { name: "hero" });
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0], {
      id: "2:1",
      name: "Hero / Desktop",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
      parentId: "1:1",
    });
  });

  it("filters by type and limit", () => {
    const matches = findNodes(file, { type: "FRAME", limit: 1 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.id, "2:1");
  });

  it("requires a filter", () => {
    assert.throws(() => findNodes(file, {}), /name, type/);
  });
});

describe("extractText", () => {
  it("returns TEXT copy with node ids", () => {
    const texts = extractText(file);
    assert.deepEqual(texts, [
      { id: "3:1", name: "Headline", characters: "Ship faster", parentId: "2:1" },
    ]);
  });
});
