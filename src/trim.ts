import { isRecord } from "./util.js";

/** How to shrink GET /v1/files (and nodes) JSON before returning it to the model. */
export type FileMode = "full" | "trim" | "summary";

const NOISY_KEYS = new Set([
  "prototypeDevice",
  "prototypeStartNodeID",
  "styleOverrideTable",
  "characterStyleOverrides",
  "lineTypes",
  "lineIndentations",
  "transitionNodeID",
  "transitionDuration",
  "transitionEasing",
  "overlayPositionType",
  "overlayBackground",
  "overlayBackgroundInteraction",
  "interactions",
  "annotations",
  "sharedPluginData",
  "pluginData",
  "exportSettings",
  "overflowDirection",
  "numberOfFixedChildren",
  "isMask",
  "effects",
  "blendMode",
  "preserveRatio",
  "layoutAlign",
  "layoutGrow",
  "constraints",
  "scrollBehavior",
]);

const SUMMARY_KEYS = new Set([
  "id",
  "name",
  "type",
  "visible",
  "children",
  "absoluteBoundingBox",
  "characters",
  "layoutMode",
  "layoutWrap",
  "itemSpacing",
  "counterAxisSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "fills",
  "strokes",
  "strokeWeight",
  "cornerRadius",
  "componentId",
  "componentProperties",
  "styles",
  "style",
  "boundVariables",
]);

function mapTree(value: unknown, mapper: (node: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => mapTree(item, mapper));
  }
  if (!isRecord(value)) {
    return value;
  }
  const mapped = mapper(value);
  if (Array.isArray(mapped.children)) {
    mapped.children = mapped.children.map((child) => mapTree(child, mapper));
  }
  return mapped;
}

function trimRecord(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node)) {
    if (NOISY_KEYS.has(key)) {
      continue;
    }
    out[key] = val;
  }
  return out;
}

function summarizeRecord(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node)) {
    if (SUMMARY_KEYS.has(key)) {
      out[key] = val;
    }
  }
  return out;
}

function transformDocument(payload: unknown, mapper: (node: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  if (isRecord(payload.document)) {
    return { ...payload, document: mapTree(payload.document, mapper) };
  }

  if (isRecord(payload.nodes)) {
    const nodes: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(payload.nodes)) {
      if (isRecord(entry) && "document" in entry) {
        nodes[id] = { ...entry, document: mapTree(entry.document, mapper) };
      } else {
        nodes[id] = mapTree(entry, mapper);
      }
    }
    return { ...payload, nodes };
  }

  return mapTree(payload, mapper);
}

export function applyFileMode(payload: unknown, mode: FileMode = "trim"): unknown {
  if (mode === "full") {
    return payload;
  }
  if (mode === "summary") {
    return transformDocument(payload, summarizeRecord);
  }
  return transformDocument(payload, trimRecord);
}
