import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { messageForStatus } from "./errors.js";
import {
  compactTokenSummary,
  inferTokensFromTree,
  mergeFallbackDefs,
  shapeVariableDefs,
  tokensFromStyles,
} from "./tokens.js";

const dir = dirname(fileURLToPath(import.meta.url));
const localVars = JSON.parse(readFileSync(join(dir, "fixtures/variables-local.json"), "utf8")) as unknown;
const fileStyles = JSON.parse(readFileSync(join(dir, "fixtures/file-styles.json"), "utf8")) as unknown;
const cardTree = JSON.parse(readFileSync(join(dir, "fixtures/design-context-card.json"), "utf8")) as unknown;

describe("shapeVariableDefs", () => {
  it("shapes local variables into a codegen-friendly list and resolves one-level aliases", () => {
    const defs = shapeVariableDefs(localVars, { fileKey: "AbCdEfGhIjKlMnOpQrStUv", mode: "trim" });
    assert.equal(defs.source, "variables");
    assert.equal(defs.variablesAvailable, true);
    assert.equal(defs.collections[0]?.name, "Primitives");
    assert.ok(defs.modes.some((mode) => mode.name === "Light"));

    const primary = defs.variables.find((item) => item.name === "color/primary");
    assert.ok(primary);
    assert.equal(primary?.resolvedType, "COLOR");
    assert.equal(primary?.valuesByMode["1:0"]?.kind, "color");
    if (primary?.valuesByMode["1:0"]?.kind === "color") {
      assert.match(primary.valuesByMode["1:0"].css, /^#/);
    }

    const alias = defs.variables.find((item) => item.name === "color/primary-alias");
    assert.equal(alias?.valuesByMode["1:0"]?.kind, "color");
    if (alias?.valuesByMode["1:0"]?.kind === "color") {
      assert.equal(alias.valuesByMode["1:0"].css, primary?.valuesByMode["1:0"]?.kind === "color" ? primary.valuesByMode["1:0"].css : "");
    }

    const space = defs.variables.find((item) => item.name === "space/md");
    assert.deepEqual(space?.valuesByMode["1:0"], { kind: "number", value: 16 });
    assert.ok(!defs.variables.some((item) => item.name === "hidden/secret"));
  });

  it("summary mode keeps only the default mode and drops hidden + scopes", () => {
    const defs = shapeVariableDefs(localVars, { fileKey: "k", mode: "summary" });
    const primary = defs.variables.find((item) => item.name === "color/primary");
    assert.deepEqual(Object.keys(primary?.valuesByMode ?? {}), ["1:0"]);
    assert.equal(primary?.scopes, undefined);
  });

  it("full mode keeps hidden variables", () => {
    const defs = shapeVariableDefs(localVars, { fileKey: "k", mode: "full" });
    assert.ok(defs.variables.some((item) => item.name === "hidden/secret"));
  });

  it("labels a circular alias instead of looping", () => {
    const circular = {
      meta: {
        variableCollections: {
          c1: { id: "c1", name: "C", defaultModeId: "m", modes: [{ modeId: "m", name: "A" }] },
        },
        variables: {
          a: {
            id: "a",
            name: "loop",
            variableCollectionId: "c1",
            resolvedType: "COLOR",
            valuesByMode: { m: { type: "VARIABLE_ALIAS", id: "a" } },
          },
        },
      },
    };
    const defs = shapeVariableDefs(circular, { fileKey: "k" });
    const value = defs.variables[0]?.valuesByMode.m;
    assert.equal(value?.kind, "alias");
    if (value?.kind === "alias") {
      assert.equal(value.circular, true);
      assert.equal(value.unresolved, true);
    }
  });
});

describe("tokensFromStyles + inferTokensFromTree", () => {
  it("builds style tokens and fills values from subtree usage", () => {
    const tree = {
      nodes: {
        "2:1": {
          document: {
            id: "2:1",
            name: "Card",
            type: "FRAME",
            styles: { fill: "10:1" },
            fills: [{ type: "SOLID", color: { r: 0.05, g: 0.4, b: 0.95, a: 1 } }],
            children: [
              {
                id: "3:1",
                name: "Body",
                type: "TEXT",
                styles: { text: "10:2" },
                characters: "Hi",
                style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
                fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }],
              },
            ],
          },
          styles: {
            "10:1": { key: "stylekey1", name: "Primary / 500", styleType: "FILL" },
            "10:2": { key: "stylekey2", name: "Body / Regular", styleType: "TEXT" },
          },
        },
      },
    };
    const tokens = tokensFromStyles(fileStyles, { fileKey: "k", nodeTree: tree });
    const fill = tokens.find((item) => item.name === "Primary / 500");
    assert.equal(fill?.resolvedType, "COLOR");
    assert.equal(fill?.valuesByMode.default?.kind, "color");
    const text = tokens.find((item) => item.name === "Body / Regular");
    assert.equal(text?.resolvedType, "TYPOGRAPHY");
    assert.equal(text?.valuesByMode.default?.kind, "typography");
  });

  it("infers labeled tokens from a subtree and marks inferred: true", () => {
    const inferred = inferTokensFromTree(cardTree);
    assert.ok(inferred.length > 0);
    assert.ok(inferred.every((item) => item.inferred === true));
    assert.ok(inferred.some((item) => item.name.startsWith("color/")));
    assert.ok(inferred.some((item) => item.name.startsWith("text/")));
    assert.ok(inferred.some((item) => item.name.startsWith("radius/") || item.name.startsWith("space/")));
    const merged = mergeFallbackDefs({
      fileKey: "k",
      styleTokens: tokensFromStyles(fileStyles, { fileKey: "k" }),
      inferredTokens: inferred,
      warnings: [],
    });
    assert.equal(merged.source, "mixed");
    assert.equal(merged.variablesAvailable, false);
    assert.ok(merged.warnings.some((line) => /not Figma variables/i.test(line)));
  });
});

describe("compactTokenSummary", () => {
  it("flattens default values for design context", () => {
    const defs = shapeVariableDefs(localVars, { fileKey: "k", mode: "summary" });
    const summary = compactTokenSummary(defs, 2);
    assert.equal(summary.variablesAvailable, true);
    assert.equal(summary.tokens.length, 2);
    assert.ok(summary.warnings.some((line) => /truncated/i.test(line)));
  });
});

describe("variables 403", () => {
  it("tells the agent to use Enterprise + file_variables:read and the fallback tools", () => {
    const msg = messageForStatus(403, { err: "Invalid scope" }, undefined, "/v1/files/abc/variables/local");
    assert.match(msg, /Enterprise/);
    assert.match(msg, /file_variables:read/);
    assert.match(msg, /get_variable_defs|get_design_tokens_fallback/);
    assert.match(msg, /not a seat\/tool-call quota from Figma's official MCP/);
  });
});
