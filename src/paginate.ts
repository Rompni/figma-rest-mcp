import { asNumber, isRecord } from "./util.js";

export const FIGMA_API_HOST = "api.figma.com";

export function metaCursorAfter(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.meta) || !isRecord(body.meta.cursor)) {
    return undefined;
  }
  return asNumber(body.meta.cursor.after);
}

export function paginationNextPage(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.pagination)) {
    return undefined;
  }
  const next = body.pagination.next_page;
  return typeof next === "string" && next.length > 0 ? next : undefined;
}

export function assertFigmaApiUrl(url: string): URL {
  const parsed = url.startsWith("https://") || url.startsWith("http://")
    ? new URL(url)
    : new URL(url, `https://${FIGMA_API_HOST}`);
  if (parsed.protocol !== "https:" || parsed.hostname !== FIGMA_API_HOST) {
    throw new Error(`Refusing to follow pagination URL outside https://${FIGMA_API_HOST}: ${url}`);
  }
  return parsed;
}
