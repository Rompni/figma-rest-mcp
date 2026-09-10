import { downloadTrustedAsset, readUrlMap, type DownloadedAsset } from "./assets.js";
import { TtlCache } from "./cache.js";
import { FigmaApiError, messageForStatus, parseRetryAfter } from "./errors.js";
import { normalizeNodeIds } from "./node-ids.js";
import { assertFigmaApiUrl, metaCursorAfter, paginationNextPage } from "./paginate.js";
import { parseFileKey } from "./parse-file-key.js";
import { parseProjectId, parseTeamId } from "./parse-ids.js";
import { buildDesignContextLite, type DesignContextLite } from "./design-context.js";
import {
  compactTokenSummary,
  countMappedVariables,
  inferTokensFromTree,
  mergeFallbackDefs,
  shapeVariableDefs,
  tokensFromStyles,
  type TokenMode,
  type VariableDefs,
} from "./tokens.js";
import { extractText, findNodes, type FindNodesOptions } from "./tree.js";
import { isRecord } from "./util.js";

export const FIGMA_API_ORIGIN = "https://api.figma.com";
export const FIGMA_API_BASE = "https://api.figma.com/v1";

export const DEFAULT_ASSET_MAX_BYTES = 250_000;
export const DEFAULT_ASSET_MAX_ITEMS = 20;

export type ImageFormat = "png" | "jpg" | "svg" | "pdf";

export type SleepFn = (ms: number) => Promise<void>;

export type FigmaClientOptions = {
  token: string;
  fetchImpl?: typeof fetch;
  cache?: TtlCache;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: SleepFn;
};

export type PageOptions = {
  autoPaginate?: boolean;
  pageSize?: number;
  after?: number;
  before?: number;
  maxPages?: number;
};

type Query = Record<string, string | number | boolean | undefined>;

export type AssetBundle = {
  assets: Record<string, DownloadedAsset>;
  warnings: string[];
  maxBytes: number;
  maxAssets: number;
};

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class FigmaRestClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: TtlCache;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: SleepFn;

  constructor(options: FigmaClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cache = options.cache ?? new TtlCache(60_000);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
  }

  whoami(): Promise<unknown> {
    return this.cache.wrap("me", () => this.get("/me"));
  }

  getFile(
    file: string,
    options?: { depth?: number; geometry?: string; ids?: string | string[]; version?: string },
  ): Promise<unknown> {
    const key = parseFileKey(file);
    const depth = options?.depth ?? 2;
    const geometry = options?.geometry;
    const ids = options?.ids ? normalizeNodeIds(options.ids).join(",") : undefined;
    const version = options?.version;
    const cacheKey = `file:${key}:depth=${depth}:geometry=${geometry ?? ""}:ids=${ids ?? ""}:version=${version ?? ""}`;
    return this.cache.wrap(cacheKey, () =>
      this.get(`/files/${encodeURIComponent(key)}`, { depth, geometry, ids, version }),
    );
  }

  getNodes(
    file: string,
    ids: string | string[],
    options?: { depth?: number; geometry?: string },
  ): Promise<unknown> {
    const key = parseFileKey(file);
    const nodeIds = normalizeNodeIds(ids);
    const depth = options?.depth;
    const geometry = options?.geometry;
    const cacheKey = `nodes:${key}:ids=${nodeIds.join(",")}:depth=${depth ?? ""}:geometry=${geometry ?? ""}`;
    return this.cache.wrap(cacheKey, () =>
      this.get(`/files/${encodeURIComponent(key)}/nodes`, {
        ids: nodeIds.join(","),
        depth,
        geometry,
      }),
    );
  }

  getImages(
    file: string,
    ids: string | string[],
    options?: { format?: ImageFormat; scale?: number },
  ): Promise<unknown> {
    const key = parseFileKey(file);
    const nodeIds = normalizeNodeIds(ids);
    const format = options?.format ?? "png";
    return this.get(`/images/${encodeURIComponent(key)}`, {
      ids: nodeIds.join(","),
      format,
      scale: options?.scale,
    });
  }

  getImageFills(file: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.cache.wrap(`image-fills:${key}`, () => this.get(`/files/${encodeURIComponent(key)}/images`));
  }

  getFileMeta(file: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.cache.wrap(`meta:${key}`, () => this.get(`/files/${encodeURIComponent(key)}/meta`));
  }

  async getComments(file: string, options?: { asMd?: boolean }): Promise<unknown> {
    const key = parseFileKey(file);
    return this.get(`/files/${encodeURIComponent(key)}/comments`, {
      as_md: options?.asMd === true ? true : undefined,
    });
  }

  async postComment(
    file: string,
    body: { message: string; comment_id?: string; client_meta?: unknown },
  ): Promise<unknown> {
    const key = parseFileKey(file);
    return this.request("POST", `/files/${encodeURIComponent(key)}/comments`, { json: body });
  }

  async deleteComment(file: string, commentId: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.request("DELETE", `/files/${encodeURIComponent(key)}/comments/${encodeURIComponent(commentId)}`);
  }

  async getCommentReactions(
    file: string,
    commentId: string,
    options?: { autoPaginate?: boolean; maxPages?: number },
  ): Promise<unknown> {
    const key = parseFileKey(file);
    const path = `/files/${encodeURIComponent(key)}/comments/${encodeURIComponent(commentId)}/reactions`;
    return this.paginateNextPage(path, "reactions", options);
  }

  async postCommentReaction(file: string, commentId: string, emoji: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.request(
      "POST",
      `/files/${encodeURIComponent(key)}/comments/${encodeURIComponent(commentId)}/reactions`,
      { json: { emoji } },
    );
  }

  async deleteCommentReaction(file: string, commentId: string, emoji: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.request(
      "DELETE",
      `/files/${encodeURIComponent(key)}/comments/${encodeURIComponent(commentId)}/reactions`,
      { query: { emoji } },
    );
  }

  listProjects(team: string): Promise<unknown> {
    const teamId = parseTeamId(team);
    return this.get(`/teams/${encodeURIComponent(teamId)}/projects`);
  }

  listProjectFiles(project: string, options?: { branchData?: boolean }): Promise<unknown> {
    const projectId = parseProjectId(project);
    return this.get(`/projects/${encodeURIComponent(projectId)}/files`, {
      branch_data: options?.branchData === true ? true : undefined,
    });
  }

  async getFileVersions(file: string, options?: PageOptions): Promise<unknown> {
    const key = parseFileKey(file);
    const pageSize = options?.pageSize ?? 50;
    if (options?.autoPaginate === false) {
      return this.get(`/files/${encodeURIComponent(key)}/versions`, {
        page_size: pageSize,
        after: options.after,
        before: options.before,
      });
    }
    return this.paginateNextPage(`/files/${encodeURIComponent(key)}/versions`, "versions", {
      query: { page_size: pageSize, after: options?.after, before: options?.before },
      maxPages: options?.maxPages,
    });
  }

  getFileComponents(file: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.cache.wrap(`file-components:${key}`, () => this.get(`/files/${encodeURIComponent(key)}/components`));
  }

  getFileComponentSets(file: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.cache.wrap(`file-component-sets:${key}`, () =>
      this.get(`/files/${encodeURIComponent(key)}/component_sets`),
    );
  }

  getFileStyles(file: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.cache.wrap(`file-styles:${key}`, () => this.get(`/files/${encodeURIComponent(key)}/styles`));
  }

  getComponent(key: string): Promise<unknown> {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new Error("Component key is required.");
    }
    return this.get(`/components/${encodeURIComponent(trimmed)}`);
  }

  getStyle(key: string): Promise<unknown> {
    const trimmed = key.trim();
    if (!trimmed) {
      throw new Error("Style key is required.");
    }
    return this.get(`/styles/${encodeURIComponent(trimmed)}`);
  }

  getTeamComponents(team: string, options?: PageOptions): Promise<unknown> {
    const teamId = parseTeamId(team);
    return this.paginateMetaList(`/teams/${encodeURIComponent(teamId)}/components`, "components", options);
  }

  getTeamComponentSets(team: string, options?: PageOptions): Promise<unknown> {
    const teamId = parseTeamId(team);
    return this.paginateMetaList(`/teams/${encodeURIComponent(teamId)}/component_sets`, "component_sets", options);
  }

  getTeamStyles(team: string, options?: PageOptions): Promise<unknown> {
    const teamId = parseTeamId(team);
    return this.paginateMetaList(`/teams/${encodeURIComponent(teamId)}/styles`, "styles", options);
  }

  getLocalVariables(file: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.cache.wrap(`variables-local:${key}`, () =>
      this.get(`/files/${encodeURIComponent(key)}/variables/local`),
    );
  }

  getPublishedVariables(file: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.cache.wrap(`variables-published:${key}`, () =>
      this.get(`/files/${encodeURIComponent(key)}/variables/published`),
    );
  }

  async getVariableDefs(
    file: string,
    options?: {
      nodeId?: string;
      nodeTree?: unknown;
      fallback?: boolean;
      resolveAliases?: boolean;
      mode?: TokenMode;
      maxVariables?: number;
    },
  ): Promise<VariableDefs> {
    const key = parseFileKey(file);
    const fallback = options?.fallback !== false;
    const mode = options?.mode ?? "trim";
    try {
      const local = await this.getLocalVariables(file);
      if (countMappedVariables(local) > 0) {
        return shapeVariableDefs(local, {
          fileKey: key,
          mode,
          maxVariables: options?.maxVariables,
          resolveAliases: options?.resolveAliases,
        });
      }
    } catch (err) {
      if (!(err instanceof FigmaApiError && err.status === 403)) {
        throw err;
      }
      if (!fallback) {
        throw err;
      }
      return this.getDesignTokensFallback(file, {
        nodeId: options?.nodeId,
        nodeTree: options?.nodeTree,
        mode,
        maxVariables: options?.maxVariables,
        warnings: [err.message],
      });
    }

    if (!fallback) {
      return shapeVariableDefs({ meta: { variables: {}, variableCollections: {} } }, { fileKey: key, mode });
    }
    return this.getDesignTokensFallback(file, {
      nodeId: options?.nodeId,
      nodeTree: options?.nodeTree,
      mode,
      maxVariables: options?.maxVariables,
      warnings: ["No local Figma variables in this file (or the map was empty). Using styles/inferred fallback."],
    });
  }

  async getDesignTokensFallback(
    file: string,
    options?: {
      nodeId?: string;
      nodeTree?: unknown;
      mode?: TokenMode;
      maxVariables?: number;
      warnings?: string[];
    },
  ): Promise<VariableDefs> {
    const key = parseFileKey(file);
    const warnings = [...(options?.warnings ?? [])];
    let stylesPayload: unknown = { meta: { styles: [] } };
    try {
      stylesPayload = await this.getFileStyles(file);
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }

    let nodeTree = options?.nodeTree;
    if (!nodeTree && options?.nodeId) {
      try {
        nodeTree = await this.getNodes(file, options.nodeId, { depth: 8 });
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    }

    const styleTokens = tokensFromStyles(stylesPayload, {
      fileKey: key,
      nodeTree,
      mode: options?.mode,
      maxVariables: options?.maxVariables,
    });
    const inferredTokens = nodeTree ? inferTokensFromTree(nodeTree, { maxVariables: 40 }) : [];
    return mergeFallbackDefs({
      fileKey: key,
      styleTokens,
      inferredTokens,
      warnings,
      mode: options?.mode,
    });
  }

  getDevResources(file: string, nodeIds?: string | string[]): Promise<unknown> {
    const key = parseFileKey(file);
    const ids = nodeIds ? normalizeNodeIds(nodeIds).join(",") : undefined;
    return this.get(`/files/${encodeURIComponent(key)}/dev_resources`, { node_ids: ids });
  }

  createDevResources(
    resources: Array<{ file: string; node_id: string; name: string; url: string }>,
  ): Promise<unknown> {
    return this.request("POST", "/dev_resources", {
      json: {
        dev_resources: resources.map((item) => ({
          file_key: parseFileKey(item.file),
          node_id: item.node_id,
          name: item.name,
          url: item.url,
        })),
      },
    });
  }

  updateDevResources(resources: Array<{ id: string; name?: string; url?: string }>): Promise<unknown> {
    return this.request("PUT", "/dev_resources", { json: { dev_resources: resources } });
  }

  deleteDevResource(file: string, devResourceId: string): Promise<unknown> {
    const key = parseFileKey(file);
    return this.request(
      "DELETE",
      `/files/${encodeURIComponent(key)}/dev_resources/${encodeURIComponent(devResourceId)}`,
    );
  }

  async findNodes(
    file: string,
    options: FindNodesOptions & { depth?: number; ids?: string | string[] },
  ): Promise<{ matches: ReturnType<typeof findNodes>; searched_depth: number }> {
    const depth = options.depth ?? 8;
    const tree = options.ids
      ? await this.getNodes(file, options.ids, { depth })
      : await this.getFile(file, { depth });
    return { matches: findNodes(tree, options), searched_depth: depth };
  }

  async extractText(
    file: string,
    options?: { depth?: number; ids?: string | string[]; limit?: number },
  ): Promise<{ texts: ReturnType<typeof extractText>; searched_depth: number }> {
    const depth = options?.depth ?? 8;
    const tree = options?.ids
      ? await this.getNodes(file, options.ids, { depth })
      : await this.getFile(file, { depth });
    return { texts: extractText(tree, { limit: options?.limit }), searched_depth: depth };
  }

  async getDesignContextLite(
    file: string,
    nodeId: string,
    options?: { depth?: number; maxNodes?: number; includeMarkdown?: boolean; includeTokens?: boolean },
  ): Promise<DesignContextLite> {
    const key = parseFileKey(file);
    const depth = options?.depth ?? 6;
    const payload = await this.getNodes(file, nodeId, { depth });
    const ctx = buildDesignContextLite(payload, {
      fileKey: key,
      nodeId: normalizeNodeIds(nodeId)[0]!,
      maxNodes: options?.maxNodes,
      includeMarkdown: options?.includeMarkdown,
      depthFetched: depth,
    });
    if (options?.includeTokens) {
      try {
        const defs = await this.getVariableDefs(file, {
          nodeId,
          nodeTree: payload,
          fallback: true,
          mode: "summary",
          maxVariables: 40,
        });
        ctx.tokens = compactTokenSummary(defs, 32);
      } catch (err) {
        ctx.tokens = {
          source: "inferred",
          variablesAvailable: false,
          tokens: [],
          warnings: [err instanceof Error ? err.message : String(err)],
        };
      }
    }
    return ctx;
  }

  listWebhooks(options?: {
    context?: "team" | "project" | "file";
    contextId?: string;
    planApiId?: string;
    autoPaginate?: boolean;
    maxPages?: number;
  }): Promise<unknown> {
    const query: Query = {
      context: options?.context,
      context_id: options?.contextId ? resolveWebhookContextId(options.context, options.contextId) : undefined,
      plan_api_id: options?.planApiId,
    };
    return this.paginateNextPage("/v2/webhooks", "webhooks", {
      query,
      autoPaginate: options?.autoPaginate,
      maxPages: options?.maxPages,
    });
  }

  getWebhook(webhookId: string): Promise<unknown> {
    return this.get(`/v2/webhooks/${encodeURIComponent(webhookId)}`);
  }

  createWebhook(body: {
    event_type: string;
    context: "team" | "project" | "file";
    context_id: string;
    endpoint: string;
    passcode: string;
    status?: "ACTIVE" | "PAUSED";
    description?: string;
  }): Promise<unknown> {
    return this.request("POST", "/v2/webhooks", {
      json: {
        ...body,
        context_id: resolveWebhookContextId(body.context, body.context_id),
      },
    });
  }

  updateWebhook(
    webhookId: string,
    body: {
      event_type?: string;
      endpoint?: string;
      passcode?: string;
      status?: "ACTIVE" | "PAUSED";
      description?: string;
    },
  ): Promise<unknown> {
    return this.request("PUT", `/v2/webhooks/${encodeURIComponent(webhookId)}`, { json: body });
  }

  deleteWebhook(webhookId: string): Promise<unknown> {
    return this.request("DELETE", `/v2/webhooks/${encodeURIComponent(webhookId)}`);
  }

  async bundleImageFills(
    file: string,
    options?: { imageRefs?: string[]; maxBytes?: number; maxAssets?: number },
  ): Promise<AssetBundle> {
    const payload = await this.getImageFills(file);
    const urls = readUrlMap(payload);
    const allow = options?.imageRefs?.length ? new Set(options.imageRefs) : undefined;
    const selected = Object.entries(urls).filter(([ref]) => !allow || allow.has(ref));
    return this.downloadUrlEntries(selected, options);
  }

  async renderNodesAsDataUri(
    file: string,
    ids: string | string[],
    options?: { format?: ImageFormat; scale?: number; maxBytes?: number; maxAssets?: number },
  ): Promise<AssetBundle> {
    const payload = await this.getImages(file, ids, { format: options?.format, scale: options?.scale });
    return this.downloadUrlEntries(Object.entries(readUrlMap(payload)), options);
  }

  private get(path: string, query?: Query): Promise<unknown> {
    return this.request("GET", path, { query });
  }

  private async downloadUrlEntries(
    entries: Array<[string, string | null]>,
    options?: { maxBytes?: number; maxAssets?: number },
  ): Promise<AssetBundle> {
    const maxBytes = options?.maxBytes ?? DEFAULT_ASSET_MAX_BYTES;
    const maxAssets = options?.maxAssets ?? DEFAULT_ASSET_MAX_ITEMS;
    const assets: Record<string, DownloadedAsset> = {};
    const warnings: string[] = [];
    let downloaded = 0;

    for (const [id, url] of entries) {
      if (!url) {
        assets[id] = { contentType: "", byteLength: 0, skipped: true, reason: "API returned a null URL" };
        warnings.push(`${id}: null URL`);
        continue;
      }
      if (downloaded >= maxAssets) {
        assets[id] = {
          contentType: "",
          byteLength: 0,
          skipped: true,
          reason: `skipped; already at maxAssets ${maxAssets}`,
        };
        warnings.push(`${id}: skipped (maxAssets ${maxAssets})`);
        continue;
      }
      try {
        const asset = await downloadTrustedAsset(url, {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.timeoutMs,
          maxBytes,
        });
        assets[id] = asset;
        if (asset.skipped) {
          warnings.push(`${id}: ${asset.reason}`);
        } else {
          downloaded += 1;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        assets[id] = { contentType: "", byteLength: 0, skipped: true, reason };
        warnings.push(`${id}: ${reason}`);
      }
    }

    return { assets, warnings, maxBytes, maxAssets };
  }

  private async paginateMetaList(
    path: string,
    listKey: string,
    options?: PageOptions,
  ): Promise<unknown> {
    const pageSize = options?.pageSize ?? 100;
    if (options?.autoPaginate === false) {
      return this.get(path, { page_size: pageSize, after: options.after, before: options.before });
    }

    const maxPages = options?.maxPages ?? 20;
    const items: unknown[] = [];
    let after = options?.after;
    let lastBody: unknown = { meta: { [listKey]: [] } };

    for (let page = 0; page < maxPages; page += 1) {
      lastBody = await this.get(path, { page_size: pageSize, after, before: page === 0 ? options?.before : undefined });
      const batch = readMetaList(lastBody, listKey);
      items.push(...batch);
      const next = metaCursorAfter(lastBody);
      if (next === undefined || batch.length === 0 || next === after) {
        break;
      }
      after = next;
    }

    if (!isRecord(lastBody) || !isRecord(lastBody.meta)) {
      return lastBody;
    }
    return {
      ...lastBody,
      meta: {
        ...lastBody.meta,
        [listKey]: items,
      },
      pages_fetched: true,
    };
  }

  private async paginateNextPage(
    path: string,
    listKey: string,
    options?: { query?: Query; autoPaginate?: boolean; maxPages?: number },
  ): Promise<unknown> {
    const first = await this.get(path, options?.query);
    if (options?.autoPaginate === false) {
      return first;
    }

    const items = [...readTopList(first, listKey)];
    let next = paginationNextPage(first);
    const maxPages = options?.maxPages ?? 20;
    let lastBody = first;
    let pages = 1;

    while (next && pages < maxPages) {
      lastBody = await this.request("GET", path, { absoluteUrl: next });
      items.push(...readTopList(lastBody, listKey));
      next = paginationNextPage(lastBody);
      pages += 1;
    }

    if (!isRecord(lastBody)) {
      return lastBody;
    }
    return { ...lastBody, [listKey]: items, pages_fetched: pages };
  }

  private async request(
    method: string,
    path: string,
    options?: { query?: Query; json?: unknown; absoluteUrl?: string },
  ): Promise<unknown> {
    const url = options?.absoluteUrl ? assertFigmaApiUrl(options.absoluteUrl) : apiUrl(path);
    if (!options?.absoluteUrl && options?.query) {
      for (const [name, value] of Object.entries(options.query)) {
        if (value === undefined || value === "") {
          continue;
        }
        url.searchParams.set(name, String(value));
      }
    }

    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        const headers: Record<string, string> = {
          Accept: "application/json",
          "X-Figma-Token": this.token,
        };
        if (options?.json !== undefined) {
          headers["Content-Type"] = "application/json";
        }
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options?.json !== undefined ? JSON.stringify(options.json) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new FigmaApiError(0, `Failed to reach the Figma REST API: ${message}`, { cause });
      }

      if (response.status === 429 && attempt < this.maxRetries) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after")) ?? Math.min(2 ** attempt, 8);
        await this.sleep(Math.min(Math.max(retryAfterSeconds, 0), 60) * 1000);
        attempt += 1;
        continue;
      }

      const body = await readBody(response);
      if (!response.ok) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
        throw new FigmaApiError(
          response.status,
          messageForStatus(response.status, body, retryAfterSeconds, url.pathname),
          {
            retryAfterSeconds,
            body,
          },
        );
      }
      return body;
    }
  }
}

function apiUrl(path: string): URL {
  if (path.startsWith("/v2/") || path.startsWith("/v1/")) {
    return new URL(`${FIGMA_API_ORIGIN}${path}`);
  }
  return new URL(`${FIGMA_API_BASE}${path}`);
}

function resolveWebhookContextId(context: string | undefined, contextId: string): string {
  if (context === "team") {
    return parseTeamId(contextId);
  }
  if (context === "project") {
    return parseProjectId(contextId);
  }
  if (context === "file") {
    return parseFileKey(contextId);
  }
  return contextId.trim();
}

function readMetaList(body: unknown, listKey: string): unknown[] {
  if (!isRecord(body) || !isRecord(body.meta)) {
    return [];
  }
  const list = body.meta[listKey];
  return Array.isArray(list) ? list : [];
}

function readTopList(body: unknown, listKey: string): unknown[] {
  if (!isRecord(body)) {
    return [];
  }
  const list = body[listKey];
  return Array.isArray(list) ? list : [];
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
