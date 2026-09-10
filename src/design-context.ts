import type { TokenSummary } from "./tokens.js";
import { asNumber, figmaColorToCss, isRecord } from "./util.js";

export const DESIGN_CONTEXT_LIMITATIONS = [
  "REST-only snapshot — not official MCP get_design_context (no Plugin API, no extra codegen/semantics).",
  "Auto-layout maps to CSS flex when layoutMode is HORIZONTAL or VERTICAL; otherwise display is unknown.",
  "Constraints / absoluteBoundingBox are position hints, not a complete CSS layout.",
  "Mixed text styles flatten to the node style object + first visible solid fill.",
  "Image fills are imageRef strings only — use get_images or bundle_image_fills for pixels (no data-URIs here).",
] as const;

export type BBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SizingHint = "fixed" | "hug" | "fill" | "unknown";

export type LayoutHints = {
  display?: "flex";
  flexDirection?: "row" | "column";
  flexWrap?: "wrap" | "nowrap";
  gap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  alignItems?: string;
  justifyContent?: string;
  sizing?: {
    horizontal?: SizingHint;
    vertical?: SizingHint;
    width?: number;
    height?: number;
  };
  flexGrow?: number;
  alignSelf?: string;
  constraints?: { horizontal?: string; vertical?: string };
  assumptions: string[];
};

export type PaintSummary = {
  type: string;
  color?: string;
  imageRef?: string;
  scaleMode?: string;
  colors?: string[];
  opacity?: number;
};

export type Typography = {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeight?: string | number;
  letterSpacing?: number;
  textAlign?: string;
  color?: string;
};

export type DesignContextNode = {
  id: string;
  name: string;
  type: string;
  bbox?: BBox;
  visible?: boolean;
  layout?: LayoutHints;
  text?: { characters: string; typography?: Typography };
  fills?: PaintSummary[];
  strokes?: PaintSummary[];
  strokeWeight?: number;
  cornerRadius?: number;
  opacity?: number;
  component?: { componentId: string; name?: string; componentSetId?: string };
  children?: DesignContextNode[];
  truncated?: boolean;
};

export type DesignContextLite = {
  source: "figma-rest";
  tool: "get_design_context_lite";
  fileKey: string;
  nodeId: string;
  limitations: string[];
  imageFillsHint: string;
  root: DesignContextNode;
  stats: { nodes: number; truncated: boolean; depthFetched: number; maxNodes: number };
  markdown?: string;
  /** Present when include_tokens is true. Compact; not official get_variable_defs. */
  tokens?: TokenSummary;
};

export type DesignContextOptions = {
  maxNodes?: number;
  includeMarkdown?: boolean;
  depthFetched?: number;
};

type Counter = { nodes: number; truncated: boolean };

const DEFAULT_MAX_NODES = 80;

function bboxOf(node: Record<string, unknown>): BBox | undefined {
  const box = node.absoluteBoundingBox;
  if (!isRecord(box)) {
    return undefined;
  }
  const x = asNumber(box.x);
  const y = asNumber(box.y);
  const width = asNumber(box.width);
  const height = asNumber(box.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function mapAlign(value: unknown, kind: "justify" | "align"): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value) {
    case "MIN":
      return "flex-start";
    case "CENTER":
      return "center";
    case "MAX":
      return "flex-end";
    case "SPACE_BETWEEN":
      return kind === "justify" ? "space-between" : undefined;
    case "BASELINE":
      return kind === "align" ? "baseline" : undefined;
    default:
      return undefined;
  }
}

function mapSizingMode(value: unknown): SizingHint | undefined {
  if (value === "FIXED") {
    return "fixed";
  }
  if (value === "HUG" || value === "AUTO") {
    return "hug";
  }
  if (value === "FILL") {
    return "fill";
  }
  return undefined;
}

function axisSizing(
  node: Record<string, unknown>,
  axis: "horizontal" | "vertical",
  layoutMode: string | undefined,
): SizingHint {
  const explicit =
    axis === "horizontal"
      ? mapSizingMode(node.layoutSizingHorizontal)
      : mapSizingMode(node.layoutSizingVertical);
  if (explicit) {
    return explicit;
  }
  const primary = layoutMode === "HORIZONTAL" ? "horizontal" : layoutMode === "VERTICAL" ? "vertical" : undefined;
  if (!primary) {
    return "unknown";
  }
  const isPrimary = axis === primary;
  const mode = mapSizingMode(isPrimary ? node.primaryAxisSizingMode : node.counterAxisSizingMode);
  return mode ?? "unknown";
}

export function mapLayout(node: Record<string, unknown>): LayoutHints | undefined {
  const assumptions: string[] = [];
  const layoutMode = typeof node.layoutMode === "string" ? node.layoutMode : undefined;
  const bbox = bboxOf(node);
  const hints: LayoutHints = { assumptions };

  if (layoutMode === "HORIZONTAL" || layoutMode === "VERTICAL") {
    hints.display = "flex";
    hints.flexDirection = layoutMode === "HORIZONTAL" ? "row" : "column";
    if (node.layoutWrap === "WRAP") {
      hints.flexWrap = "wrap";
    } else if (node.layoutWrap === "NO_WRAP") {
      hints.flexWrap = "nowrap";
    }
    const gap = asNumber(node.itemSpacing);
    if (gap !== undefined) {
      hints.gap = gap;
    }
    const pad = {
      top: asNumber(node.paddingTop) ?? 0,
      right: asNumber(node.paddingRight) ?? 0,
      bottom: asNumber(node.paddingBottom) ?? 0,
      left: asNumber(node.paddingLeft) ?? 0,
    };
    if (pad.top || pad.right || pad.bottom || pad.left) {
      hints.padding = pad;
    }
    hints.justifyContent = mapAlign(node.primaryAxisAlignItems, "justify");
    hints.alignItems = mapAlign(node.counterAxisAlignItems, "align");
    assumptions.push("Figma auto-layout → CSS flex (primary axis = justify-content, counter = align-items).");
  } else if (layoutMode === "NONE" || layoutMode) {
    assumptions.push("No auto-layout; CSS display cannot be inferred from REST.");
  }

  const horizontal = axisSizing(node, "horizontal", layoutMode);
  const vertical = axisSizing(node, "vertical", layoutMode);
  const sizing: NonNullable<LayoutHints["sizing"]> = {
    horizontal,
    vertical,
  };
  if (bbox) {
    sizing.width = bbox.width;
    sizing.height = bbox.height;
  }
  if (horizontal !== "unknown" || vertical !== "unknown" || bbox) {
    hints.sizing = sizing;
  }

  const grow = asNumber(node.layoutGrow);
  if (grow !== undefined && grow > 0) {
    hints.flexGrow = grow;
    assumptions.push("layoutGrow > 0 mapped to flex-grow (fill along parent primary axis).");
  }
  if (node.layoutAlign === "STRETCH") {
    hints.alignSelf = "stretch";
  } else if (node.layoutAlign === "MIN") {
    hints.alignSelf = "flex-start";
  } else if (node.layoutAlign === "MAX") {
    hints.alignSelf = "flex-end";
  } else if (node.layoutAlign === "CENTER") {
    hints.alignSelf = "center";
  }

  if (isRecord(node.constraints)) {
    const horizontalC = typeof node.constraints.horizontal === "string" ? node.constraints.horizontal : undefined;
    const verticalC = typeof node.constraints.vertical === "string" ? node.constraints.vertical : undefined;
    if (horizontalC || verticalC) {
      hints.constraints = { horizontal: horizontalC, vertical: verticalC };
      assumptions.push("constraints are Figma pin/scale hints, not CSS position/inset.");
    }
  }

  if (!hints.display && !hints.sizing && !hints.constraints && !hints.flexGrow && !hints.alignSelf) {
    return undefined;
  }
  return hints;
}

function summarizePaint(paint: unknown): PaintSummary | undefined {
  if (!isRecord(paint) || paint.visible === false) {
    return undefined;
  }
  const type = typeof paint.type === "string" ? paint.type : "UNKNOWN";
  const opacity = asNumber(paint.opacity);
  const summary: PaintSummary = { type };
  if (opacity !== undefined && opacity < 1) {
    summary.opacity = opacity;
  }
  if (type === "SOLID" && isRecord(paint.color)) {
    const color = figmaColorToCss(paint.color, opacity);
    if (color) {
      summary.color = color;
    }
    return summary;
  }
  if (type === "IMAGE") {
    if (typeof paint.imageRef === "string") {
      summary.imageRef = paint.imageRef;
    }
    if (typeof paint.scaleMode === "string") {
      summary.scaleMode = paint.scaleMode;
    }
    return summary;
  }
  if (type.startsWith("GRADIENT") && Array.isArray(paint.gradientStops)) {
    const colors: string[] = [];
    for (const stop of paint.gradientStops) {
      if (isRecord(stop) && isRecord(stop.color)) {
        const css = figmaColorToCss(stop.color);
        if (css) {
          colors.push(css);
        }
      }
    }
    if (colors.length > 0) {
      summary.colors = colors;
    }
    return summary;
  }
  return summary;
}

function summarizePaints(value: unknown): PaintSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: PaintSummary[] = [];
  for (const paint of value) {
    const summary = summarizePaint(paint);
    if (summary) {
      out.push(summary);
    }
  }
  return out.length > 0 ? out : undefined;
}

function firstSolidColor(paints: PaintSummary[] | undefined): string | undefined {
  return paints?.find((paint) => paint.type === "SOLID" && paint.color)?.color;
}

function mapTypography(node: Record<string, unknown>, fills: PaintSummary[] | undefined): Typography | undefined {
  const style = isRecord(node.style) ? node.style : undefined;
  if (!style) {
    const color = firstSolidColor(fills);
    return color ? { color } : undefined;
  }
  const typography: Typography = {};
  if (typeof style.fontFamily === "string") {
    typography.fontFamily = style.fontFamily;
  }
  const weight = asNumber(style.fontWeight);
  if (weight !== undefined) {
    typography.fontWeight = weight;
  }
  const size = asNumber(style.fontSize);
  if (size !== undefined) {
    typography.fontSize = size;
  }
  if (style.lineHeightUnit === "PIXELS" && asNumber(style.lineHeightPx) !== undefined) {
    typography.lineHeight = asNumber(style.lineHeightPx);
  } else if (typeof style.lineHeightUnit === "string" && asNumber(style.lineHeightPercentFontSize) !== undefined) {
    typography.lineHeight = `${asNumber(style.lineHeightPercentFontSize)}%`;
  } else if (asNumber(style.lineHeightPx) !== undefined) {
    typography.lineHeight = asNumber(style.lineHeightPx);
  }
  const tracking = asNumber(style.letterSpacing);
  if (tracking !== undefined) {
    typography.letterSpacing = tracking;
  }
  if (typeof style.textAlignHorizontal === "string") {
    const align = style.textAlignHorizontal.toLowerCase();
    typography.textAlign = align === "justified" ? "justify" : align;
  }
  const color = firstSolidColor(fills);
  if (color) {
    typography.color = color;
  }
  return Object.keys(typography).length > 0 ? typography : undefined;
}

type ComponentMaps = {
  components: Record<string, unknown>;
  componentSets: Record<string, unknown>;
};

function componentInfo(node: Record<string, unknown>, maps: ComponentMaps): DesignContextNode["component"] {
  const componentId = typeof node.componentId === "string" ? node.componentId : undefined;
  if (!componentId) {
    return undefined;
  }
  const entry = isRecord(maps.components[componentId]) ? maps.components[componentId] : undefined;
  const name = typeof entry?.name === "string" ? entry.name : undefined;
  const componentSetId =
    (typeof entry?.componentSetId === "string" ? entry.componentSetId : undefined) ??
    (typeof node.componentSetId === "string" ? node.componentSetId : undefined);
  return { componentId, name, componentSetId };
}

function mapNode(
  node: Record<string, unknown>,
  maps: ComponentMaps,
  counter: Counter,
  maxNodes: number,
): DesignContextNode | undefined {
  if (counter.nodes >= maxNodes) {
    counter.truncated = true;
    return undefined;
  }
  const id = typeof node.id === "string" ? node.id : "";
  const type = typeof node.type === "string" ? node.type : "UNKNOWN";
  if (!id) {
    return undefined;
  }
  counter.nodes += 1;

  const fills = summarizePaints(node.fills);
  const strokes = summarizePaints(node.strokes);
  const layout = mapLayout(node);
  const mapped: DesignContextNode = {
    id,
    name: typeof node.name === "string" ? node.name : "",
    type,
  };

  const bbox = bboxOf(node);
  if (bbox) {
    mapped.bbox = bbox;
  }
  if (node.visible === false) {
    mapped.visible = false;
  }
  if (layout) {
    mapped.layout = layout;
  }
  if (type === "TEXT") {
    mapped.text = {
      characters: typeof node.characters === "string" ? node.characters : "",
      typography: mapTypography(node, fills),
    };
  }
  if (fills) {
    mapped.fills = fills;
  }
  if (strokes) {
    mapped.strokes = strokes;
  }
  const strokeWeight = asNumber(node.strokeWeight);
  if (strokeWeight !== undefined) {
    mapped.strokeWeight = strokeWeight;
  }
  const radius = asNumber(node.cornerRadius);
  if (radius !== undefined) {
    mapped.cornerRadius = radius;
  }
  const opacity = asNumber(node.opacity);
  if (opacity !== undefined && opacity < 1) {
    mapped.opacity = opacity;
  }
  const component = componentInfo(node, maps);
  if (component) {
    mapped.component = component;
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    const children: DesignContextNode[] = [];
    for (const child of node.children) {
      if (counter.nodes >= maxNodes) {
        mapped.truncated = true;
        counter.truncated = true;
        break;
      }
      if (!isRecord(child)) {
        continue;
      }
      const mappedChild = mapNode(child, maps, counter, maxNodes);
      if (mappedChild) {
        children.push(mappedChild);
      } else if (counter.truncated) {
        mapped.truncated = true;
        break;
      }
    }
    if (children.length > 0) {
      mapped.children = children;
    }
  }

  return mapped;
}

export function extractNodeEntry(
  payload: unknown,
  nodeId: string,
): { document: Record<string, unknown>; components: Record<string, unknown>; componentSets: Record<string, unknown> } {
  if (!isRecord(payload)) {
    throw new Error("Figma REST payload is not an object.");
  }
  if (isRecord(payload.document) && payload.document.id === nodeId) {
    return { document: payload.document, components: {}, componentSets: {} };
  }
  if (isRecord(payload.nodes)) {
    const entry = payload.nodes[nodeId];
    if (!isRecord(entry)) {
      const keys = Object.keys(payload.nodes);
      throw new Error(
        `Node ${nodeId} was not in GET /v1/files/.../nodes. Returned keys: ${keys.slice(0, 8).join(", ") || "(none)"}.`,
      );
    }
    if (typeof entry.err === "string" && entry.err) {
      throw new Error(`Figma REST error for node ${nodeId}: ${entry.err}`);
    }
    if (!isRecord(entry.document)) {
      throw new Error(`Node ${nodeId} response has no document tree.`);
    }
    return {
      document: entry.document,
      components: isRecord(entry.components) ? entry.components : {},
      componentSets: isRecord(entry.componentSets) ? entry.componentSets : {},
    };
  }
  if (isRecord(payload.document)) {
    const found = findById(payload.document, nodeId);
    if (!found) {
      throw new Error(`Node ${nodeId} not found in the file tree. Pass the frame id and a sufficient depth.`);
    }
    return {
      document: found,
      components: isRecord(payload.components) ? payload.components : {},
      componentSets: isRecord(payload.componentSets) ? payload.componentSets : {},
    };
  }
  throw new Error("Unrecognized Figma REST payload; expected { nodes } or { document }.");
}

function findById(node: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  if (node.id === id) {
    return node;
  }
  if (!Array.isArray(node.children)) {
    return undefined;
  }
  for (const child of node.children) {
    if (isRecord(child)) {
      const found = findById(child, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export function toMarkdown(root: DesignContextNode, extra?: { fileKey: string; nodeId: string }): string {
  const lines: string[] = [
    `# Design context lite (REST)`,
    extra ? `file \`${extra.fileKey}\` · node \`${extra.nodeId}\`` : "",
    `_Not official get_design_context. Layout is best-effort flex from auto-layout._`,
    "",
  ].filter(Boolean);

  const walk = (node: DesignContextNode, indent: number) => {
    const pad = "  ".repeat(indent);
    const size = node.bbox ? ` ${Math.round(node.bbox.width)}×${Math.round(node.bbox.height)}` : "";
    const head = `${pad}- **${node.name || "(unnamed)"}** (${node.type} \`${node.id}\`${size})`;
    const bits: string[] = [head];
    if (node.layout?.display === "flex") {
      const layoutBits = [
        `flex ${node.layout.flexDirection ?? ""}`.trim(),
        node.layout.gap !== undefined ? `gap ${node.layout.gap}` : "",
        node.layout.justifyContent ? `justify ${node.layout.justifyContent}` : "",
        node.layout.alignItems ? `align ${node.layout.alignItems}` : "",
      ].filter(Boolean);
      bits.push(`${pad}  layout: ${layoutBits.join("; ")}`);
    }
    if (node.text) {
      const ty = node.text.typography;
      const tyBits = [
        ty?.fontFamily,
        ty?.fontSize !== undefined ? `${ty.fontSize}px` : "",
        ty?.fontWeight !== undefined ? `w${ty.fontWeight}` : "",
        ty?.color,
      ].filter(Boolean);
      bits.push(`${pad}  text: ${JSON.stringify(node.text.characters)}${tyBits.length ? ` · ${tyBits.join(" ")}` : ""}`);
    }
    if (node.fills?.length) {
      bits.push(
        `${pad}  fills: ${node.fills
          .map((fill) => fill.color ?? (fill.imageRef ? `imageRef ${fill.imageRef}` : fill.type))
          .join(", ")}`,
      );
    }
    if (node.component) {
      bits.push(
        `${pad}  component: ${node.component.name ?? node.component.componentId} (\`${node.component.componentId}\`)`,
      );
    }
    if (node.truncated) {
      bits.push(`${pad}  …truncated`);
    }
    lines.push(bits.join("\n"));
    for (const child of node.children ?? []) {
      walk(child, indent + 1);
    }
  };

  walk(root, 0);
  return lines.join("\n");
}

export function buildDesignContextLite(
  payload: unknown,
  options: { fileKey: string; nodeId: string } & DesignContextOptions,
): DesignContextLite {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const { document, components, componentSets } = extractNodeEntry(payload, options.nodeId);
  const counter: Counter = { nodes: 0, truncated: false };
  const root = mapNode(document, { components, componentSets }, counter, maxNodes);
  if (!root) {
    throw new Error(`Could not map node ${options.nodeId}.`);
  }
  const result: DesignContextLite = {
    source: "figma-rest",
    tool: "get_design_context_lite",
    fileKey: options.fileKey,
    nodeId: options.nodeId,
    limitations: [...DESIGN_CONTEXT_LIMITATIONS],
    imageFillsHint: "Image fills are refs only. Call get_images (render) or bundle_image_fills (uploaded assets) for pixels.",
    root,
    stats: {
      nodes: counter.nodes,
      truncated: counter.truncated,
      depthFetched: options.depthFetched ?? 0,
      maxNodes,
    },
  };
  if (options.includeMarkdown) {
    result.markdown = toMarkdown(root, { fileKey: options.fileKey, nodeId: options.nodeId });
  }
  return result;
}
