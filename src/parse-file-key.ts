/**
 * Extract a Figma file key from a raw key or a Figma URL.
 *
 * Accepts:
 * - raw keys (`abcXYZ123`)
 * - `figma.com/design/<key>/...`
 * - `figma.com/file/<key>/...`
 * - proto / board / slides / deck / community URLs
 */
const FIGMA_URL_RE =
  /(?:https?:\/\/)?(?:www\.)?figma\.com\/(?:community\/)?(?:file|design|proto|board|slides|deck)\/([A-Za-z0-9]+)/i;

export function parseFileKey(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty Figma file key or URL.");
  }

  const fromUrl = trimmed.match(FIGMA_URL_RE);
  if (fromUrl?.[1]) {
    return fromUrl[1];
  }

  if (/^[A-Za-z0-9]+$/.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Could not parse a Figma file key from: ${trimmed}. Pass a raw key or a URL like https://www.figma.com/design/<key>/... or https://www.figma.com/file/<key>/...`,
  );
}
