import { walkNodes } from "./tree.js";
import { asNumber, figmaColorToCss, isRecord } from "./util.js";

export const VARIABLE_DEFS_LIMITATIONS = [
  "REST-only — not official Desktop MCP get_variable_defs (no Plugin API, no live file bindings).",
  "Real Figma variables require Enterprise + PAT scope file_variables:read.",
  "Aliases are resolved one level; leftover aliases or cycles are labeled, not followed further.",
  "Non-Enterprise files fall back to file styles metadata and/or inferred values from a subtree; those are marked inferred: true.",
] as const;

export type TokenMode = "full" | "trim" | "summary";
export type TokenSource = "variables" | "styles" | "inferred" | "mixed";

export type TokenValue =
  | { kind: "color"; css: string }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "typography"; fontFamily?: string; fontWeight?: number; fontSize?: number; color?: string }
  | {
      kind: "alias";
      id: string;
      name?: string;
      circular?: boolean;
      unresolved?: boolean;
    };

export type TokenDef = {
  id: string;
  name: string;
  resolvedType: string;
  collectionId?: string;
  collectionName?: string;
  scopes?: string[];
  valuesByMode: Record<string, TokenValue>;
  inferred?: true;
  published?: boolean;
  description?: string;
};

export type TokenCollection = {
  id: string;
  name: string;
  defaultModeId: string;
  modes: Array<{ id: string; name: string }>;
  remote?: boolean;
};

export type VariableDefs = {
  source: TokenSource;
  fileKey: string;
  tool: "get_variable_defs";
  limitations: string[];
  collections: TokenCollection[];
  modes: Array<{ id: string; name: string; collectionId: string; collectionName?: string }>;
  variables: TokenDef[];
  warnings: string[];
  variablesAvailable: boolean;
  stats: { count: number; truncated: boolean; mode: TokenMode };
};

export type TokenSummary = {
  source: TokenSource;
  variablesAvailable: boolean;
  tokens: Array<{ name: string; resolvedType: string; value: unknown; inferred?: true }>;
  warnings: string[];
};

export type ShapeVariablesOptions = {
  fileKey: string;
  mode?: TokenMode;
  maxVariables?: number;
  resolveAliases?: boolean;
};

const DEFAULT_MODE_ID = "default";

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}-${i}`)) {
    i += 1;
  }
  const name = `${base}-${i}`;
  used.add(name);
  return name;
}

function isAlias(value: unknown): value is { type: "VARIABLE_ALIAS"; id: string } {
  return isRecord(value) && value.type === "VARIABLE_ALIAS" && typeof value.id === "string";
}

function metaBlock(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {};
  }
  if (isRecord(payload.meta)) {
    return payload.meta;
  }
  return payload;
}

export function extractVariableMaps(payload: unknown): {
  variables: Record<string, unknown>;
  collections: Record<string, unknown>;
} {
  const meta = metaBlock(payload);
  return {
    variables: isRecord(meta.variables) ? meta.variables : {},
    collections: isRecord(meta.variableCollections) ? meta.variableCollections : {},
  };
}

function normalizeValue(value: unknown, resolvedType: string): TokenValue {
  if (isAlias(value)) {
    return { kind: "alias", id: value.id, unresolved: true };
  }
  if (resolvedType === "COLOR" && isRecord(value)) {
    const css = figmaColorToCss(value);
    if (css) {
      return { kind: "color", css };
    }
  }
  if (resolvedType === "FLOAT" && typeof value === "number") {
    return { kind: "number", value };
  }
  if (resolvedType === "STRING" && typeof value === "string") {
    return { kind: "string", value };
  }
  if (resolvedType === "BOOLEAN" && typeof value === "boolean") {
    return { kind: "boolean", value };
  }
  if (typeof value === "number") {
    return { kind: "number", value };
  }
  if (typeof value === "string") {
    return { kind: "string", value };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", value };
  }
  if (isRecord(value) && asNumber(value.r) !== undefined) {
    const css = figmaColorToCss(value);
    if (css) {
      return { kind: "color", css };
    }
  }
  return { kind: "string", value: JSON.stringify(value) };
}

function resolveOneLevel(
  value: unknown,
  resolvedType: string,
  variables: Record<string, unknown>,
  modeId: string,
): TokenValue {
  if (!isAlias(value)) {
    return normalizeValue(value, resolvedType);
  }
  const target = variables[value.id];
  if (!isRecord(target)) {
    return { kind: "alias", id: value.id, unresolved: true };
  }
  const targetName = typeof target.name === "string" ? target.name : undefined;
  const targetType = typeof target.resolvedType === "string" ? target.resolvedType : resolvedType;
  const values = isRecord(target.valuesByMode) ? target.valuesByMode : {};
  const next = modeId in values ? values[modeId] : Object.values(values)[0];
  if (isAlias(next)) {
    return {
      kind: "alias",
      id: value.id,
      name: targetName,
      circular: next.id === value.id,
      unresolved: true,
    };
  }
  if (next === undefined) {
    return { kind: "alias", id: value.id, name: targetName, unresolved: true };
  }
  return normalizeValue(next, targetType);
}

function displayValue(value: TokenValue | undefined): unknown {
  if (!value) {
    return undefined;
  }
  switch (value.kind) {
    case "color":
      return value.css;
    case "number":
      return value.value;
    case "string":
      return value.value;
    case "boolean":
      return value.value;
    case "typography":
      return {
        fontFamily: value.fontFamily,
        fontWeight: value.fontWeight,
        fontSize: value.fontSize,
        color: value.color,
      };
    case "alias":
      return value;
    default:
      return undefined;
  }
}

function capList<T>(list: T[], max: number): { items: T[]; truncated: boolean } {
  if (list.length <= max) {
    return { items: list, truncated: false };
  }
  return { items: list.slice(0, max), truncated: true };
}

export function shapeVariableDefs(payload: unknown, options: ShapeVariablesOptions): VariableDefs {
  const mode = options.mode ?? "trim";
  const max =
    options.maxVariables ?? (mode === "summary" ? 60 : mode === "full" ? 400 : 120);
  const resolveAliases = options.resolveAliases !== false;
  const { variables: rawVars, collections: rawCols } = extractVariableMaps(payload);

  const collections: TokenCollection[] = [];
  const modes: VariableDefs["modes"] = [];
  const collectionNameById = new Map<string, string>();
  const defaultModeByCollection = new Map<string, string>();

  for (const [id, raw] of Object.entries(rawCols)) {
    if (!isRecord(raw)) {
      continue;
    }
    const name = typeof raw.name === "string" ? raw.name : id;
    const defaultModeId = typeof raw.defaultModeId === "string" ? raw.defaultModeId : DEFAULT_MODE_ID;
    const modeList: Array<{ id: string; name: string }> = [];
    if (Array.isArray(raw.modes)) {
      for (const item of raw.modes) {
        if (isRecord(item) && typeof item.modeId === "string") {
          modeList.push({
            id: item.modeId,
            name: typeof item.name === "string" ? item.name : item.modeId,
          });
        }
      }
    }
    collectionNameById.set(id, name);
    defaultModeByCollection.set(id, defaultModeId);
    collections.push({
      id,
      name,
      defaultModeId,
      modes: modeList,
      remote: raw.remote === true ? true : undefined,
    });
    for (const item of modeList) {
      modes.push({ id: item.id, name: item.name, collectionId: id, collectionName: name });
    }
  }

  const tokens: TokenDef[] = [];
  for (const [id, raw] of Object.entries(rawVars)) {
    if (!isRecord(raw)) {
      continue;
    }
    if (mode !== "full" && raw.hiddenFromPublishing === true) {
      continue;
    }
    const resolvedType = typeof raw.resolvedType === "string" ? raw.resolvedType : "UNKNOWN";
    const collectionId = typeof raw.variableCollectionId === "string" ? raw.variableCollectionId : undefined;
    const valuesRaw = isRecord(raw.valuesByMode) ? raw.valuesByMode : {};
    const defaultMode = collectionId ? defaultModeByCollection.get(collectionId) : undefined;
    const valuesByMode: Record<string, TokenValue> = {};
    const entries = Object.entries(valuesRaw);
    for (const [modeId, value] of entries) {
      if (mode === "summary" && defaultMode && modeId !== defaultMode && entries.length > 1) {
        continue;
      }
      valuesByMode[modeId] = resolveAliases
        ? resolveOneLevel(value, resolvedType, rawVars, modeId)
        : normalizeValue(value, resolvedType);
    }
    const scopes = Array.isArray(raw.scopes)
      ? raw.scopes.filter((item): item is string => typeof item === "string").slice(0, mode === "full" ? 32 : 8)
      : undefined;
    const token: TokenDef = {
      id: typeof raw.id === "string" ? raw.id : id,
      name: typeof raw.name === "string" ? raw.name : id,
      resolvedType,
      collectionId,
      collectionName: collectionId ? collectionNameById.get(collectionId) : undefined,
      valuesByMode,
      published: raw.remote === true ? true : undefined,
    };
    if (scopes && scopes.length > 0 && mode !== "summary") {
      token.scopes = scopes;
    }
    if (mode === "full" && typeof raw.description === "string" && raw.description) {
      token.description = raw.description;
    }
    tokens.push(token);
  }

  tokens.sort((a, b) => a.name.localeCompare(b.name));
  const { items, truncated } = capList(tokens, max);
  return {
    source: "variables",
    fileKey: options.fileKey,
    tool: "get_variable_defs",
    limitations: [...VARIABLE_DEFS_LIMITATIONS],
    collections,
    modes,
    variables: items,
    warnings: truncated ? [`Truncated to ${max} variables (mode=${mode}).`] : [],
    variablesAvailable: items.length > 0,
    stats: { count: items.length, truncated, mode },
  };
}

export function emptyVariableDefs(fileKey: string, warnings: string[], mode: TokenMode = "trim"): VariableDefs {
  return {
    source: "variables",
    fileKey,
    tool: "get_variable_defs",
    limitations: [...VARIABLE_DEFS_LIMITATIONS],
    collections: [],
    modes: [],
    variables: [],
    warnings,
    variablesAvailable: false,
    stats: { count: 0, truncated: false, mode },
  };
}

type StyleMeta = {
  id: string;
  key?: string;
  name: string;
  styleType: string;
  description?: string;
  nodeId?: string;
};

export function extractStyleList(payload: unknown): StyleMeta[] {
  const meta = metaBlock(payload);
  const list = Array.isArray(meta.styles)
    ? meta.styles
    : isRecord(meta.styles)
      ? Object.entries(meta.styles).map(([id, value]) => ({ ...(isRecord(value) ? value : {}), id }))
      : [];
  const out: StyleMeta[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    const id =
      (typeof item.id === "string" && item.id) ||
      (typeof item.node_id === "string" && item.node_id) ||
      (typeof item.key === "string" && item.key) ||
      "";
    const name = typeof item.name === "string" ? item.name : id;
    if (!id && !name) {
      continue;
    }
    const styleType =
      (typeof item.style_type === "string" && item.style_type) ||
      (typeof item.styleType === "string" && item.styleType) ||
      "FILL";
    out.push({
      id: id || name,
      key: typeof item.key === "string" ? item.key : undefined,
      name,
      styleType,
      description: typeof item.description === "string" ? item.description : undefined,
      nodeId: typeof item.node_id === "string" ? item.node_id : typeof item.nodeId === "string" ? item.nodeId : undefined,
    });
  }
  return out;
}

function styleTypeToResolved(styleType: string): string {
  switch (styleType.toUpperCase()) {
    case "FILL":
    case "PAINT":
      return "COLOR";
    case "TEXT":
      return "TYPOGRAPHY";
    case "EFFECT":
      return "EFFECT";
    case "GRID":
      return "GRID";
    default:
      return styleType.toUpperCase();
  }
}

function firstSolidCss(node: Record<string, unknown>): string | undefined {
  if (!Array.isArray(node.fills)) {
    return undefined;
  }
  for (const paint of node.fills) {
    if (!isRecord(paint) || paint.visible === false || paint.type !== "SOLID" || !isRecord(paint.color)) {
      continue;
    }
    const css = figmaColorToCss(paint.color, asNumber(paint.opacity));
    if (css) {
      return css;
    }
  }
  return undefined;
}

function typographyValue(node: Record<string, unknown>): TokenValue | undefined {
  const style = isRecord(node.style) ? node.style : undefined;
  if (!style && node.type !== "TEXT") {
    return undefined;
  }
  const color = firstSolidCss(node);
  return {
    kind: "typography",
    fontFamily: typeof style?.fontFamily === "string" ? style.fontFamily : undefined,
    fontWeight: asNumber(style?.fontWeight),
    fontSize: asNumber(style?.fontSize),
    color,
  };
}

function collectStyleMaps(payload: unknown): Record<string, StyleMeta> {
  const map: Record<string, StyleMeta> = {};
  const ingest = (id: string, raw: unknown) => {
    if (!isRecord(raw)) {
      return;
    }
    const name = typeof raw.name === "string" ? raw.name : id;
    const styleType =
      (typeof raw.styleType === "string" && raw.styleType) ||
      (typeof raw.style_type === "string" && raw.style_type) ||
      "FILL";
    map[id] = {
      id,
      key: typeof raw.key === "string" ? raw.key : undefined,
      name,
      styleType,
      description: typeof raw.description === "string" ? raw.description : undefined,
    };
  };
  if (isRecord(payload) && isRecord(payload.styles)) {
    for (const [id, raw] of Object.entries(payload.styles)) {
      ingest(id, raw);
    }
  }
  if (isRecord(payload) && isRecord(payload.nodes)) {
    for (const entry of Object.values(payload.nodes)) {
      if (isRecord(entry) && isRecord(entry.styles)) {
        for (const [id, raw] of Object.entries(entry.styles)) {
          ingest(id, raw);
        }
      }
    }
  }
  return map;
}

export function tokensFromStyles(
  stylesPayload: unknown,
  options: { fileKey: string; nodeTree?: unknown; mode?: TokenMode; maxVariables?: number },
): TokenDef[] {
  const listed = extractStyleList(stylesPayload);
  const fromTree = collectStyleMaps(options.nodeTree);
  const byId = new Map<string, StyleMeta>();
  for (const item of listed) {
    byId.set(item.id, item);
    if (item.key) {
      byId.set(item.key, item);
    }
  }
  for (const [id, item] of Object.entries(fromTree)) {
    if (!byId.has(id)) {
      byId.set(id, item);
    }
  }

  const usage = new Map<string, TokenValue>();
  if (options.nodeTree) {
    walkNodes(options.nodeTree, (node) => {
      const styles = isRecord(node.styles) ? node.styles : undefined;
      if (!styles) {
        return;
      }
      const fillId = typeof styles.fill === "string" ? styles.fill : typeof styles.fills === "string" ? styles.fills : undefined;
      if (fillId) {
        const css = firstSolidCss(node);
        if (css) {
          usage.set(fillId, { kind: "color", css });
        }
      }
      const textId = typeof styles.text === "string" ? styles.text : undefined;
      if (textId && node.type === "TEXT") {
        const ty = typographyValue(node);
        if (ty) {
          usage.set(textId, ty);
        }
      }
    });
  }

  const tokens: TokenDef[] = [];
  const seen = new Set<string>();
  for (const meta of byId.values()) {
    if (seen.has(meta.id)) {
      continue;
    }
    seen.add(meta.id);
    const resolvedType = styleTypeToResolved(meta.styleType);
    const value = usage.get(meta.id) ?? (meta.key ? usage.get(meta.key) : undefined);
    const valuesByMode: Record<string, TokenValue> = {};
    if (value) {
      valuesByMode[DEFAULT_MODE_ID] = value;
    }
    tokens.push({
      id: meta.key ?? meta.id,
      name: meta.name,
      resolvedType,
      collectionId: "styles",
      collectionName: "File styles",
      valuesByMode,
    });
  }
  tokens.sort((a, b) => a.name.localeCompare(b.name));
  const max = options.maxVariables ?? 80;
  return capList(tokens, max).items;
}

function luminance(css: string): number {
  const hex = css.startsWith("#") ? css.slice(1) : "";
  if (hex.length !== 6) {
    return 0.5;
  }
  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function nameColor(css: string, rank: number, used: Set<string>): string {
  const lum = luminance(css);
  if (lum > 0.92) {
    return uniqueName("color/background", used);
  }
  if (lum > 0.8) {
    return uniqueName("color/surface", used);
  }
  if (lum < 0.12) {
    return uniqueName(rank === 0 ? "color/text" : "color/text-muted", used);
  }
  if (rank === 0) {
    return uniqueName("color/primary", used);
  }
  if (rank === 1) {
    return uniqueName("color/accent", used);
  }
  return uniqueName(`color/${css.replace("#", "")}`, used);
}

function nameText(size: number | undefined, used: Set<string>): string {
  if (size !== undefined && size >= 32) {
    return uniqueName("text/display", used);
  }
  if (size !== undefined && size >= 24) {
    return uniqueName("text/heading", used);
  }
  if (size !== undefined && size >= 18) {
    return uniqueName("text/title", used);
  }
  if (size !== undefined && size >= 14) {
    return uniqueName("text/body", used);
  }
  return uniqueName("text/caption", used);
}

function nameRadius(n: number, used: Set<string>): string {
  if (n <= 4) {
    return uniqueName("radius/sm", used);
  }
  if (n <= 8) {
    return uniqueName("radius/md", used);
  }
  if (n <= 16) {
    return uniqueName("radius/lg", used);
  }
  return uniqueName("radius/xl", used);
}

function nameSpace(n: number, kind: "gap" | "padding" | "space", used: Set<string>): string {
  if (kind === "gap") {
    return uniqueName(used.has("space/gap") ? `space/${n}` : "space/gap", used);
  }
  if (kind === "padding") {
    return uniqueName(used.has("space/padding") ? `space/${n}` : "space/padding", used);
  }
  return uniqueName(`space/${n}`, used);
}

export function inferTokensFromTree(
  tree: unknown,
  options?: { maxVariables?: number },
): TokenDef[] {
  const colorCounts = new Map<string, number>();
  const textCounts = new Map<string, { count: number; value: TokenValue }>();
  const radiusCounts = new Map<number, number>();
  const gapCounts = new Map<number, number>();
  const padCounts = new Map<number, number>();

  walkNodes(tree, (node) => {
    const css = firstSolidCss(node);
    if (css) {
      colorCounts.set(css, (colorCounts.get(css) ?? 0) + 1);
    }
    if (node.type === "TEXT") {
      const ty = typographyValue(node);
      const key = JSON.stringify(displayValue(ty));
      const prev = textCounts.get(key);
      textCounts.set(key, { count: (prev?.count ?? 0) + 1, value: ty ?? { kind: "string", value: "" } });
    }
    const radius = asNumber(node.cornerRadius);
    if (radius !== undefined && radius > 0) {
      radiusCounts.set(radius, (radiusCounts.get(radius) ?? 0) + 1);
    }
    const gap = asNumber(node.itemSpacing);
    if (gap !== undefined && gap > 0 && (node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL")) {
      gapCounts.set(gap, (gapCounts.get(gap) ?? 0) + 1);
    }
    const pads = [
      asNumber(node.paddingTop),
      asNumber(node.paddingRight),
      asNumber(node.paddingBottom),
      asNumber(node.paddingLeft),
    ].filter((n): n is number => n !== undefined && n > 0);
    if (pads.length > 0 && pads.every((n) => n === pads[0])) {
      padCounts.set(pads[0]!, (padCounts.get(pads[0]!) ?? 0) + 1);
    }
  });

  const used = new Set<string>();
  const tokens: TokenDef[] = [];
  const push = (token: TokenDef) => {
    tokens.push(token);
  };

  const colors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  colors.forEach(([css], index) => {
    const name = nameColor(css, index, used);
    push({
      id: `inferred:${name}`,
      name,
      resolvedType: "COLOR",
      collectionId: "inferred",
      collectionName: "Inferred from subtree",
      valuesByMode: { [DEFAULT_MODE_ID]: { kind: "color", css } },
      inferred: true,
    });
  });

  const texts = [...textCounts.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  for (const item of texts) {
    const size = item.value.kind === "typography" ? item.value.fontSize : undefined;
    const name = nameText(size, used);
    push({
      id: `inferred:${name}`,
      name,
      resolvedType: "TYPOGRAPHY",
      collectionId: "inferred",
      collectionName: "Inferred from subtree",
      valuesByMode: { [DEFAULT_MODE_ID]: item.value },
      inferred: true,
    });
  }

  const radii = [...radiusCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [n] of radii) {
    const name = nameRadius(n, used);
    push({
      id: `inferred:${name}`,
      name,
      resolvedType: "FLOAT",
      collectionId: "inferred",
      collectionName: "Inferred from subtree",
      valuesByMode: { [DEFAULT_MODE_ID]: { kind: "number", value: n } },
      inferred: true,
    });
  }

  const gaps = [...gapCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [n] of gaps) {
    const name = nameSpace(n, "gap", used);
    push({
      id: `inferred:${name}`,
      name,
      resolvedType: "FLOAT",
      collectionId: "inferred",
      collectionName: "Inferred from subtree",
      valuesByMode: { [DEFAULT_MODE_ID]: { kind: "number", value: n } },
      inferred: true,
    });
  }

  const pads = [...padCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [n] of pads) {
    const name = nameSpace(n, "padding", used);
    push({
      id: `inferred:${name}`,
      name,
      resolvedType: "FLOAT",
      collectionId: "inferred",
      collectionName: "Inferred from subtree",
      valuesByMode: { [DEFAULT_MODE_ID]: { kind: "number", value: n } },
      inferred: true,
    });
  }

  const max = options?.maxVariables ?? 40;
  return capList(tokens, max).items;
}

export function mergeFallbackDefs(options: {
  fileKey: string;
  styleTokens: TokenDef[];
  inferredTokens: TokenDef[];
  warnings: string[];
  mode?: TokenMode;
}): VariableDefs {
  const mode = options.mode ?? "trim";
  const collections: TokenCollection[] = [];
  if (options.styleTokens.length > 0) {
    collections.push({
      id: "styles",
      name: "File styles",
      defaultModeId: DEFAULT_MODE_ID,
      modes: [{ id: DEFAULT_MODE_ID, name: "Default" }],
    });
  }
  if (options.inferredTokens.length > 0) {
    collections.push({
      id: "inferred",
      name: "Inferred from subtree",
      defaultModeId: DEFAULT_MODE_ID,
      modes: [{ id: DEFAULT_MODE_ID, name: "Default" }],
    });
  }
  const variables = [...options.styleTokens, ...options.inferredTokens];
  const hasStyles = options.styleTokens.length > 0;
  const hasInferred = options.inferredTokens.length > 0;
  const source: TokenSource = hasStyles && hasInferred ? "mixed" : hasStyles ? "styles" : "inferred";
  const warnings = [...options.warnings];
  if (hasInferred) {
    warnings.push("Inferred tokens are heuristic (repeated fills/type/radii/spacing). They are not Figma variables.");
  }
  if (hasStyles && options.styleTokens.every((token) => Object.keys(token.valuesByMode).length === 0)) {
    warnings.push("File styles listing has names but no paint values. Pass node_id to resolve colors from usage in the subtree.");
  }
  const modes = collections.flatMap((col) =>
    col.modes.map((item) => ({ id: item.id, name: item.name, collectionId: col.id, collectionName: col.name })),
  );
  return {
    source,
    fileKey: options.fileKey,
    tool: "get_variable_defs",
    limitations: [...VARIABLE_DEFS_LIMITATIONS],
    collections,
    modes,
    variables,
    warnings,
    variablesAvailable: false,
    stats: { count: variables.length, truncated: false, mode },
  };
}

export function compactTokenSummary(defs: VariableDefs, limit = 32): TokenSummary {
  const tokens = defs.variables.slice(0, limit).map((token) => {
    const modeId = Object.keys(token.valuesByMode)[0];
    const value = displayValue(modeId ? token.valuesByMode[modeId] : undefined);
    return {
      name: token.name,
      resolvedType: token.resolvedType,
      value,
      inferred: token.inferred,
    };
  });
  const warnings = [...defs.warnings];
  if (defs.variables.length > limit) {
    warnings.push(`Token summary truncated to ${limit} of ${defs.variables.length}. Call get_variable_defs for the full list.`);
  }
  return {
    source: defs.source,
    variablesAvailable: defs.variablesAvailable,
    tokens,
    warnings,
  };
}

export function countMappedVariables(payload: unknown): number {
  return Object.keys(extractVariableMaps(payload).variables).length;
}
