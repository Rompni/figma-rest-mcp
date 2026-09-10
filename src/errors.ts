const REST_NOT_MCP =
  "This is a Figma REST API error (api.figma.com), not a seat/tool-call quota from Figma's official MCP.";

export class FigmaApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  readonly body: unknown;

  constructor(
    status: number,
    message: string,
    options?: { retryAfterSeconds?: number; body?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FigmaApiError";
    this.status = status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.body = options?.body;
  }
}

function figmaErrText(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.err === "string" && record.err.length > 0) {
    return record.err;
  }
  if (typeof record.message === "string" && record.message.length > 0) {
    return record.message;
  }
  return undefined;
}

export function messageForStatus(
  status: number,
  body: unknown,
  retryAfterSeconds?: number,
  requestPath?: string,
): string {
  const detail = figmaErrText(body);
  const suffix = detail ? ` Figma said: ${detail}` : "";
  const path = requestPath ?? "";

  switch (status) {
    case 401:
      return (
        "Figma REST API returned 401 Unauthorized. FIGMA_ACCESS_TOKEN is missing, invalid, or expired. " +
        REST_NOT_MCP +
        suffix
      );
    case 403:
      if (path.includes("/v2/webhooks")) {
        return (
          "Figma REST API returned 403 Forbidden for Webhooks v2. The PAT may lack webhooks:read (list/get) " +
          "or webhooks:write (create/update/delete), or this Figma plan does not include webhooks. " +
          REST_NOT_MCP +
          suffix
        );
      }
      if (path.includes("/variables")) {
        return (
          "Figma REST API returned 403 Forbidden for variables. This needs an Enterprise Figma plan and the PAT scope file_variables:read. " +
          "Call get_variable_defs (fallback on by default) or get_design_tokens_fallback for styles/inferred tokens instead. " +
          REST_NOT_MCP +
          suffix
        );
      }
      return (
        "Figma REST API returned 403 Forbidden. The token cannot access this file or lacks the required scopes. " +
        REST_NOT_MCP +
        suffix
      );
    case 429: {
      const wait =
        retryAfterSeconds !== undefined
          ? ` Retry after ${retryAfterSeconds} second(s).`
          : " Wait and retry.";
      return (
        "Figma REST API returned 429 Too Many Requests. This is a REST rate limit on api.figma.com, " +
        "not a seat/tool-call quota from Figma's official MCP." +
        wait +
        suffix
      );
    }
    default:
      return `Figma REST API returned HTTP ${status}.${suffix}`;
  }
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000);
    return delta > 0 ? delta : 0;
  }
  return undefined;
}
