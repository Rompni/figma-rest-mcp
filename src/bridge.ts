import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { isWriteBridgeEnabled } from "./config.js";

export const DEFAULT_BRIDGE_PORT = 3845;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DISCONNECTED_MESSAGE =
  "Figma plugin is not connected. Open a Design file in Figma Desktop, run Plugins → Development → figma-rest-mcp Bridge, paste FIGMA_BRIDGE_TOKEN, and click Connect. REST read tools still work without the plugin.";

export const WRITE_OFF_MESSAGE =
  "Desktop write is off (default). Core MCP is REST-only. To opt in: set FIGMA_ENABLE_WRITE_BRIDGE=1 and FIGMA_BRIDGE_TOKEN, restart, then connect the companion plugin. There is no free-form JS eval.";

export type BridgeCommand =
  | { op: "create_frame"; name?: string; width?: number; height?: number; x?: number; y?: number }
  | { op: "set_text"; id: string; characters: string };

const ALLOWED_OPS = new Set(["create_frame", "set_text"]);

export type PluginInfo = {
  fileName?: string;
  fileKey?: string;
  editorType?: string;
  pageName?: string;
  connectedAt: number;
};

export type BridgeJobResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  createdNodeIds?: string[];
  mutatedNodeIds?: string[];
};

export type BridgeStatus = {
  running: boolean;
  host: string;
  port: number;
  authRequired: boolean;
  connected: boolean;
  plugin?: PluginInfo;
  warning?: string;
};

export interface FigmaBridge {
  status(): BridgeStatus;
  runCommand(command: BridgeCommand, options?: { timeoutMs?: number }): Promise<BridgeJobResult>;
  close(): Promise<void>;
}

type PendingJob = {
  id: string;
  resolve: (value: BridgeJobResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const host = address.replace(/^::ffff:/, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function tokenFromRequest(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const custom = req.headers["x-figma-bridge-token"];
  if (typeof custom === "string") {
    return custom.trim();
  }
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    return url.searchParams.get("token")?.trim() ?? "";
  } catch {
    return "";
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export class FigmaBridgeServer implements FigmaBridge {
  private http?: HttpServer;
  private wss?: WebSocketServer;
  private plugin?: WebSocket;
  private pluginInfo?: PluginInfo;
  private pending?: PendingJob;
  private readonly token: string;
  readonly host: string;
  private boundPort: number;

  constructor(options: { token: string; host?: string; port?: number }) {
    const token = options.token.trim();
    if (!token) {
      throw new Error("FIGMA_BRIDGE_TOKEN is empty.");
    }
    this.token = token;
    this.host = options.host ?? DEFAULT_BRIDGE_HOST;
    this.boundPort = options.port ?? DEFAULT_BRIDGE_PORT;
  }

  get port(): number {
    return this.boundPort;
  }

  async listen(): Promise<this> {
    if (this.host !== "127.0.0.1" && this.host !== "localhost" && this.host !== "::1") {
      throw new Error(`Bridge must bind to localhost, got ${this.host}`);
    }

    const server = createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        socket.destroy();
        return;
      }
      if (tokenFromRequest(req) !== this.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/plugin" && url.pathname !== "/") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    wss.on("connection", (ws) => this.onPluginSocket(ws));

    await new Promise<void>((resolve, reject) => {
      server.listen(this.boundPort, this.host, () => resolve());
      server.once("error", reject);
    });

    const address = server.address();
    if (address && typeof address === "object") {
      this.boundPort = address.port;
    }

    this.http = server;
    this.wss = wss;
    return this;
  }

  status(): BridgeStatus {
    const connected = Boolean(this.plugin && this.plugin.readyState === WebSocket.OPEN);
    return {
      running: Boolean(this.http?.listening),
      host: this.host,
      port: this.boundPort,
      authRequired: true,
      connected,
      plugin: connected ? this.pluginInfo : undefined,
      warning: connected
        ? "Desktop write uses allowlisted Plugin API commands only (create_frame, set_text). No free-form JS."
        : DISCONNECTED_MESSAGE,
    };
  }

  async runCommand(command: BridgeCommand, options?: { timeoutMs?: number }): Promise<BridgeJobResult> {
    if (!ALLOWED_OPS.has(command.op)) {
      throw new Error(`Unknown write command "${String((command as { op?: string }).op)}". Allowlisted: create_frame, set_text.`);
    }
    if (!this.plugin || this.plugin.readyState !== WebSocket.OPEN) {
      throw new Error(DISCONNECTED_MESSAGE);
    }
    if (this.pending) {
      throw new Error("A canvas write job is already running. Retry after it finishes.");
    }
    const timeoutMs = options?.timeoutMs ?? 25_000;
    const id = randomUUID();
    const socket = this.plugin;

    return new Promise<BridgeJobResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id === id) {
          this.pending = undefined;
        }
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for the Figma plugin to run the command.`));
      }, timeoutMs);
      this.pending = { id, resolve, reject, timer };
      socket.send(JSON.stringify({ type: "command", id, command }));
    });
  }

  async close(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("Bridge closed."));
      this.pending = undefined;
    }
    this.plugin?.close();
    this.plugin = undefined;
    this.pluginInfo = undefined;
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
      if (!this.wss) {
        resolve();
      }
    });
    await new Promise<void>((resolve, reject) => {
      if (!this.http) {
        resolve();
        return;
      }
      this.http.close((err) => (err ? reject(err) : resolve()));
    });
    this.http = undefined;
    this.wss = undefined;
  }

  private onPluginSocket(ws: WebSocket): void {
    if (this.plugin && this.plugin !== ws) {
      this.plugin.close();
    }
    this.plugin = ws;

    ws.on("message", (raw) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (payload.type === "hello") {
        if (typeof payload.token === "string" && payload.token !== this.token) {
          ws.send(JSON.stringify({ type: "error", error: "Invalid FIGMA_BRIDGE_TOKEN." }));
          ws.close();
          return;
        }
        this.pluginInfo = {
          fileName: typeof payload.fileName === "string" ? payload.fileName : undefined,
          fileKey: typeof payload.fileKey === "string" ? payload.fileKey : undefined,
          editorType: typeof payload.editorType === "string" ? payload.editorType : undefined,
          pageName: typeof payload.pageName === "string" ? payload.pageName : undefined,
          connectedAt: Date.now(),
        };
        ws.send(JSON.stringify({ type: "hello_ok" }));
        return;
      }
      if (payload.type === "result" && typeof payload.id === "string" && this.pending?.id === payload.id) {
        clearTimeout(this.pending.timer);
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve({
          ok: payload.ok === true,
          result: payload.result,
          error: typeof payload.error === "string" ? payload.error : undefined,
          createdNodeIds: Array.isArray(payload.createdNodeIds)
            ? payload.createdNodeIds.filter((item): item is string => typeof item === "string")
            : undefined,
          mutatedNodeIds: Array.isArray(payload.mutatedNodeIds)
            ? payload.mutatedNodeIds.filter((item): item is string => typeof item === "string")
            : undefined,
        });
      }
    });

    ws.on("close", () => {
      if (this.plugin === ws) {
        this.plugin = undefined;
        this.pluginInfo = undefined;
        if (this.pending) {
          clearTimeout(this.pending.timer);
          this.pending.reject(new Error("Figma plugin disconnected while a job was running."));
          this.pending = undefined;
        }
      }
    });
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      json(res, 403, { error: "Bridge only accepts localhost connections." });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" && req.method === "GET") {
      json(res, 200, {
        service: "figma-rest-mcp-bridge",
        auth: "required",
        hint: "Plugin UI connects via ws://127.0.0.1/plugin?token=…",
      });
      return;
    }
    if (tokenFromRequest(req) !== this.token) {
      json(res, 401, { error: "Missing or invalid FIGMA_BRIDGE_TOKEN." });
      return;
    }
    if (url.pathname === "/status" && req.method === "GET") {
      json(res, 200, this.status());
      return;
    }
    json(res, 404, { error: "Not found." });
  }
}

export async function listenBridge(options: { token: string; host?: string; port?: number }): Promise<FigmaBridgeServer> {
  const server = new FigmaBridgeServer(options);
  return server.listen();
}

export function startBridgeFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<FigmaBridgeServer> {
  if (!isWriteBridgeEnabled(env)) {
    throw new Error(WRITE_OFF_MESSAGE);
  }
  const token = env.FIGMA_BRIDGE_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "FIGMA_ENABLE_WRITE_BRIDGE is set but FIGMA_BRIDGE_TOKEN is missing. Generate a long random token and paste the same value in the plugin UI.",
    );
  }
  const port = env.FIGMA_BRIDGE_PORT ? Number(env.FIGMA_BRIDGE_PORT) : DEFAULT_BRIDGE_PORT;
  return listenBridge({ token, port, host: DEFAULT_BRIDGE_HOST }).then((bridge) => {
    console.error(
      `figma-rest-mcp: canvas bridge on ${bridge.host}:${bridge.port} (structured commands; localhost only).`,
    );
    return bridge;
  });
}

export class DisabledBridge implements FigmaBridge {
  status(): BridgeStatus {
    return {
      running: false,
      host: DEFAULT_BRIDGE_HOST,
      port: DEFAULT_BRIDGE_PORT,
      authRequired: true,
      connected: false,
      warning: WRITE_OFF_MESSAGE,
    };
  }

  runCommand(): Promise<BridgeJobResult> {
    return Promise.reject(new Error(this.status().warning));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
