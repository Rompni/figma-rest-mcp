export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Figma REST colors are 0–1 floats. */
export function figmaColorToCss(color: Record<string, unknown>, opacity?: number): string | undefined {
  const r = asNumber(color.r);
  const g = asNumber(color.g);
  const b = asNumber(color.b);
  if (r === undefined || g === undefined || b === undefined) {
    return undefined;
  }
  const a = opacity ?? asNumber(color.a) ?? 1;
  const R = Math.round(r * 255);
  const G = Math.round(g * 255);
  const B = Math.round(b * 255);
  if (a >= 0.999) {
    return `#${toHex(R)}${toHex(G)}${toHex(B)}`;
  }
  return `rgba(${R}, ${G}, ${B}, ${Math.round(a * 1000) / 1000})`;
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}
