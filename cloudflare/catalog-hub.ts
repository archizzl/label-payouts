/*
 * Where "Sync now" reaches the Mac that runs the catalog sync (scripts/catalog-watcher.mjs) straight
 * away. The Mac keeps a WebSocket open to this Durable Object; pressing Sync now (requestCatalogSync
 * in src/server/catalog-requests.ts) sends the request down it. One instance, named "mac".
 *
 * The socket hibernates between messages (Cloudflare's WebSocket hibernation), so a quiet connection
 * costs next to nothing, and the Mac's keep-alive pings are answered without waking it. A socket
 * proves it's the Mac with its first message, {"auth": CATALOG_SYNC_SECRET}; until then it gets
 * nothing, and a wrong secret closes it.
 */

/** The bits of the Workers runtime used here (there's no @cloudflare/workers-types in this project). */
type HubSocket = WebSocket & { serializeAttachment(value: unknown): void; deserializeAttachment(): unknown };
type HubState = {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): HubSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
};
declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };
declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown };

type Env = { CATALOG_SYNC_SECRET?: string };

/** Compared in constant time, so the secret can't be guessed a character at a time. */
function sameSecret(given: unknown, secret: string | undefined) {
  if (typeof given !== "string" || !secret || given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export class CatalogHub {
  constructor(
    private state: HubState,
    private env: Env,
  ) {
    // The Mac's keep-alive, answered without waking the object.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    // The Mac connecting.
    if (pathname === "/api/catalog-sync/live") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    // A Sync now (from the app, through its binding): to every Mac that's connected.
    if (pathname === "/notify" && request.method === "POST") {
      const message = await request.text();
      const macs = this.state.getWebSockets().filter((ws) => (ws.deserializeAttachment() as { mac?: boolean } | null)?.mac);
      for (const ws of macs) {
        try {
          ws.send(message);
        } catch {
          // Gone: it reconnects on its own.
        }
      }
      return Response.json({ macs: macs.length });
    }
    return new Response("Not found", { status: 404 });
  }

  /** The first message proves it's the Mac. */
  async webSocketMessage(ws: HubSocket, message: string | ArrayBuffer) {
    if ((ws.deserializeAttachment() as { mac?: boolean } | null)?.mac) return;
    let auth: unknown;
    try {
      auth = (JSON.parse(String(message)) as { auth?: unknown }).auth;
    } catch {
      // not JSON
    }
    if (!sameSecret(auth, this.env.CATALOG_SYNC_SECRET)) {
      ws.close(1008, "Not allowed");
      return;
    }
    ws.serializeAttachment({ mac: true });
    ws.send(JSON.stringify({ type: "ready" }));
  }

  async webSocketClose(ws: HubSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}
