import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildDesignContextLite,
  extractNodeEntry,
  mapLayout,
  toMarkdown,
} from "./design-context.js";

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/design-context-card.json"), "utf8"),
) as unknown;

describe("mapLayout", () => {
  it("maps vertical auto-layout to CSS flex column", () => {
    const layout = mapLayout({
      layoutMode: "VERTICAL",
      itemSpacing: 12,
      paddingTop: 16,
      paddingRight: 8,
      paddingBottom: 16,
      paddingLeft: 8,
      primaryAxisAlignItems: "SPACE_BETWEEN",
      counterAxisAlignItems: "CENTER",
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "HUG",
      absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 200 },
    });
    assert.equal(layout?.display, "flex");
    assert.equal(layout?.flexDirection, "column");
    assert.equal(layout?.gap, 12);
    assert.deepEqual(layout?.padding, { top: 16, right: 8, bottom: 16, left: 8 });
    assert.equal(layout?.justifyContent, "space-between");
    assert.equal(layout?.alignItems, "center");
    assert.equal(layout?.sizing?.horizontal, "fill");
    assert.equal(layout?.sizing?.vertical, "hug");
    assert.match(layout?.assumptions[0] ?? "", /auto-layout → CSS flex/);
  });

  it("does not invent flex when layoutMode is NONE", () => {
    const layout = mapLayout({
      layoutMode: "NONE",
      constraints: { horizontal: "LEFT", vertical: "TOP" },
      absoluteBoundingBox: { x: 10, y: 20, width: 40, height: 40 },
    });
    assert.equal(layout?.display, undefined);
    assert.equal(layout?.constraints?.horizontal, "LEFT");
    assert.ok(layout?.assumptions.some((line) => /No auto-layout/i.test(line)));
  });
});

describe("buildDesignContextLite", () => {
  it("builds a slim codegen tree from a REST nodes payload", () => {
    const ctx = buildDesignContextLite(fixture, {
      fileKey: "AbCdEfGhIjKlMnOpQrStUv",
      nodeId: "2:1",
      depthFetched: 4,
      includeMarkdown: true,
    });
    assert.equal(ctx.tool, "get_design_context_lite");
    assert.equal(ctx.source, "figma-rest");
    assert.equal(ctx.root.id, "2:1");
    assert.equal(ctx.root.type, "FRAME");
    assert.equal(ctx.root.layout?.flexDirection, "column");
    assert.equal(ctx.root.layout?.gap, 12);
    assert.equal(ctx.root.fills?.[0]?.color, "#ffffff");
    assert.equal(ctx.root.children?.length, 3);

    const text = ctx.root.children?.[0];
    assert.equal(text?.type, "TEXT");
    assert.equal(text?.text?.characters, "Ship faster");
    assert.equal(text?.text?.typography?.fontFamily, "Inter");
    assert.equal(text?.text?.typography?.fontWeight, 600);
    assert.equal(text?.text?.typography?.fontSize, 20);
    assert.equal(text?.text?.typography?.textAlign, "center");
    assert.ok(text?.text?.typography?.color?.startsWith("#"));

    const photo = ctx.root.children?.[1];
    assert.equal(photo?.fills?.[0]?.type, "IMAGE");
    assert.equal(photo?.fills?.[0]?.imageRef, "abc123ref");
    assert.doesNotMatch(JSON.stringify(ctx), /data:image/);

    const button = ctx.root.children?.[2];
    assert.equal(button?.component?.componentId, "9:9");
    assert.equal(button?.component?.name, "Button / Primary");
    assert.equal(button?.component?.componentSetId, "9:1");

    assert.ok(ctx.limitations.some((line) => /not official MCP/i.test(line)));
    assert.match(ctx.markdown ?? "", /Ship faster/);
    assert.equal(ctx.stats.truncated, false);
    assert.doesNotMatch(JSON.stringify(ctx), /styleOverrideTable|prototypeDevice|data:image/);
  });

  it("honors maxNodes and marks truncated", () => {
    const ctx = buildDesignContextLite(fixture, {
      fileKey: "AbCdEfGhIjKlMnOpQrStUv",
      nodeId: "2:1",
      maxNodes: 2,
    });
    assert.equal(ctx.stats.truncated, true);
    assert.ok((ctx.root.children?.length ?? 0) <= 1);
    assert.equal(ctx.root.truncated, true);
  });

  it("errors when the node id is missing from the payload", () => {
    assert.throws(
      () =>
        buildDesignContextLite({ nodes: {} }, { fileKey: "k", nodeId: "9:9" }),
      /9:9/,
    );
  });
});

describe("extractNodeEntry", () => {
  it("reads document from GET /nodes shape", () => {
    const entry = extractNodeEntry(fixture, "2:1");
    assert.equal(entry.document.name, "Card");
    assert.equal((entry.components["9:9"] as { name: string }).name, "Button / Primary");
  });
});

describe("toMarkdown", () => {
  it("renders a compact tree", () => {
    const ctx = buildDesignContextLite(fixture, {
      fileKey: "AbCdEfGhIjKlMnOpQrStUv",
      nodeId: "2:1",
    });
    const md = toMarkdown(ctx.root, { fileKey: ctx.fileKey, nodeId: ctx.nodeId });
    assert.match(md, /Card/);
    assert.match(md, /flex column/);
    assert.match(md, /imageRef abc123ref/);
  });
});
