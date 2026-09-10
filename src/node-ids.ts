export function normalizeNodeId(id: string): string {
  return id.trim().replace(/-/g, ":");
}

/** Accept a raw id (`1:2` / `1-2`) or pull `node-id` from a Figma URL. */
export function parseNodeId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Node id is empty.");
  }
  const looksLikeUrl = /figma\.com/i.test(trimmed) || /^https?:\/\//i.test(trimmed);
  if (looksLikeUrl) {
    try {
      const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      const url = new URL(withProtocol);
      const fromQuery = url.searchParams.get("node-id") ?? url.searchParams.get("node_id");
      if (fromQuery) {
        return normalizeNodeId(fromQuery);
      }
    } catch {
      // invalid URL
    }
    throw new Error("Figma URL has no node-id query parameter.");
  }
  return normalizeNodeId(trimmed);
}

/** Split a comma-separated string or array of node ids and normalize 1-2 → 1:2. */
export function normalizeNodeIds(ids: string | string[]): string[] {
  const raw = Array.isArray(ids) ? ids : ids.split(",");
  const out = raw.map(normalizeNodeId).filter(Boolean);
  if (out.length === 0) {
    throw new Error("At least one node id is required.");
  }
  return out;
}
