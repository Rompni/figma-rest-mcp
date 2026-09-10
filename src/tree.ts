import { isRecord } from "./util.js";

export type NameMatch = "substring" | "exact" | "regex";

export type FoundNode = {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: unknown;
  parentId?: string;
};

export type FindNodesOptions = {
  name?: string;
  nameMatch?: NameMatch;
  type?: string | string[];
  limit?: number;
};

export type ExtractedText = {
  id: string;
  name: string;
  characters: string;
  parentId?: string;
};

function namePredicate(name: string | undefined, match: NameMatch): ((value: string) => boolean) | undefined {
  if (!name) {
    return undefined;
  }
  if (match === "exact") {
    const expected = name;
    return (value) => value === expected;
  }
  if (match === "regex") {
    const re = new RegExp(name, "i");
    return (value) => re.test(value);
  }
  const needle = name.toLowerCase();
  return (value) => value.toLowerCase().includes(needle);
}

function typeSet(type: string | string[] | undefined): Set<string> | undefined {
  if (!type) {
    return undefined;
  }
  const list = Array.isArray(type) ? type : type.split(",");
  const set = new Set(list.map((item) => item.trim().toUpperCase()).filter(Boolean));
  return set.size > 0 ? set : undefined;
}

export function walkNodes(
  root: unknown,
  visit: (node: Record<string, unknown>, parentId: string | undefined) => boolean | void,
): void {
  const visitTree = (node: unknown, parentId: string | undefined): boolean => {
    if (!isRecord(node)) {
      return false;
    }
    const stop = visit(node, parentId);
    if (stop === true) {
      return true;
    }
    const id = typeof node.id === "string" ? node.id : undefined;
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (visitTree(child, id)) {
          return true;
        }
      }
    }
    return false;
  };

  if (isRecord(root) && root.document) {
    visitTree(root.document, undefined);
    return;
  }

  if (isRecord(root) && isRecord(root.nodes)) {
    for (const entry of Object.values(root.nodes)) {
      if (isRecord(entry) && "document" in entry) {
        if (visitTree(entry.document, undefined)) {
          return;
        }
      } else if (visitTree(entry, undefined)) {
        return;
      }
    }
    return;
  }

  visitTree(root, undefined);
}

export function findNodes(root: unknown, options: FindNodesOptions): FoundNode[] {
  const pred = namePredicate(options.name, options.nameMatch ?? "substring");
  const types = typeSet(options.type);
  if (!pred && !types) {
    throw new Error("find_nodes requires at least one of: name, type.");
  }
  const limit = options.limit ?? 50;
  const matches: FoundNode[] = [];

  walkNodes(root, (node, parentId) => {
    const id = typeof node.id === "string" ? node.id : "";
    const name = typeof node.name === "string" ? node.name : "";
    const type = typeof node.type === "string" ? node.type : "";
    if (!id) {
      return false;
    }
    if (pred && !pred(name)) {
      return false;
    }
    if (types && !types.has(type.toUpperCase())) {
      return false;
    }
    matches.push({
      id,
      name,
      type,
      absoluteBoundingBox: node.absoluteBoundingBox,
      parentId,
    });
    return matches.length >= limit;
  });

  return matches;
}

export function extractText(root: unknown, options?: { limit?: number }): ExtractedText[] {
  const limit = options?.limit ?? 500;
  const out: ExtractedText[] = [];

  walkNodes(root, (node, parentId) => {
    if (node.type !== "TEXT") {
      return false;
    }
    const id = typeof node.id === "string" ? node.id : "";
    if (!id) {
      return false;
    }
    const characters = typeof node.characters === "string" ? node.characters : "";
    out.push({
      id,
      name: typeof node.name === "string" ? node.name : "",
      characters,
      parentId,
    });
    return out.length >= limit;
  });

  return out;
}
