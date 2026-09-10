const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com", "api.figma.com"]);

/** Hosts Figma uses for short-lived fill/render downloads (S3 + figma.com). */
export function isTrustedAssetHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (FIGMA_HOSTS.has(host) || host.endsWith(".figma.com")) {
    return true;
  }
  if (!host.endsWith(".amazonaws.com")) {
    return false;
  }
  if (host.includes("figma")) {
    return true;
  }
  // Regional S3 used by Figma image URLs.
  if (host === "s3.amazonaws.com") {
    return true;
  }
  if (/^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host)) {
    return true;
  }
  if (/^[a-z0-9._-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host)) {
    return true;
  }
  return false;
}

export function assertTrustedAssetUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid asset URL: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS asset URL (${parsed.protocol}): ${raw}`);
  }
  if (!isTrustedAssetHost(parsed.hostname)) {
    throw new Error(
      `Refusing to download from untrusted host ${parsed.hostname}. Only Figma and Figma S3 CDN hosts are allowed.`,
    );
  }
  return parsed;
}

export type DownloadedAsset = {
  contentType: string;
  byteLength: number;
  dataUri?: string;
  skipped?: boolean;
  reason?: string;
};

export type DownloadAssetOptions = {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
};

function header(response: Response, name: string): string | undefined {
  return response.headers.get(name) ?? undefined;
}

export async function downloadTrustedAsset(
  rawUrl: string,
  options: DownloadAssetOptions,
): Promise<DownloadedAsset> {
  const maxRedirects = options.maxRedirects ?? 3;
  let current = assertTrustedAssetUrl(rawUrl).toString();

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await options.fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = header(response, "location");
      if (!location) {
        throw new Error(`Asset redirect from ${current} had no Location header.`);
      }
      current = new URL(location, current).toString();
      assertTrustedAssetUrl(current);
      continue;
    }

    if (!response.ok) {
      return {
        contentType: header(response, "content-type") ?? "application/octet-stream",
        byteLength: 0,
        skipped: true,
        reason: `HTTP ${response.status} downloading asset`,
      };
    }

    const contentType = (header(response, "content-type") ?? "application/octet-stream").split(";")[0]!.trim();
    const declared = Number.parseInt(header(response, "content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      return {
        contentType,
        byteLength: declared,
        skipped: true,
        reason: `content-length ${declared} exceeds maxBytes ${options.maxBytes}`,
      };
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > options.maxBytes) {
      return {
        contentType,
        byteLength: buffer.byteLength,
        skipped: true,
        reason: `body ${buffer.byteLength} exceeds maxBytes ${options.maxBytes}`,
      };
    }

    const base64 = Buffer.from(buffer).toString("base64");
    return {
      contentType,
      byteLength: buffer.byteLength,
      dataUri: `data:${contentType};base64,${base64}`,
    };
  }

  return {
    contentType: "application/octet-stream",
    byteLength: 0,
    skipped: true,
    reason: `Too many redirects (max ${maxRedirects})`,
  };
}

export function readUrlMap(payload: unknown, key = "images"): Record<string, string | null> {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const images = (payload as Record<string, unknown>)[key];
  if (!images || typeof images !== "object") {
    return {};
  }
  const out: Record<string, string | null> = {};
  for (const [id, value] of Object.entries(images as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[id] = value;
    } else {
      out[id] = null;
    }
  }
  return out;
}
