/*
 * The catalog sync on this Mac, kept running by launchd (`npm run sync-catalog:schedule`). It:
 *
 *   - keeps a WebSocket open to the live site (cloudflare/catalog-hub.ts), so "Sync now" starts a
 *     sync here within a second or two;
 *   - every minute, runs the usual check (`sync-catalog --if-due`): everyone every 10 minutes, and
 *     any Sync now it missed while it wasn't connected (the Mac asleep, the network down).
 *
 * One sync at a time: a request that comes in during one runs right after it. Needs Node 22 (for
 * WebSocket). The site and secret come from .deploy.local, as for `npm run sync-catalog`.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const deployLocal = existsSync(join(project, ".deploy.local")) ? readFileSync(join(project, ".deploy.local"), "utf8") : "";
const setting = (name) => process.env[name] ?? deployLocal.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
const site = (setting("LIVE_SITE_URL") ?? "https://labelmaker.ing").replace(/\/$/, "");
const secret = setting("CATALOG_SYNC_SECRET");
const stamp = () => new Date().toISOString();

/** How often the usual check runs, and how often the connection is checked. */
const CHECK_EVERY_MS = 60 * 1000;
const PING_EVERY_MS = 30 * 1000;
/** No answer to a ping for this long: the connection's dead (after sleep, say), so start again. */
const DEAD_AFTER_MS = 75 * 1000;

// ---------- running syncs ----------

let running = false;
/** What to run next: the usual check, and requests sent here (by account). */
let next = { check: false, requests: new Map() };

function run(kind, request) {
  if (kind === "check") next.check = true;
  else next.requests.set(request.orgId, merge(next.requests.get(request.orgId), request));
  if (!running) start();
}

/** Two requests for one account: some bands each, those bands; all of it in either, all of it. */
function merge(a, b) {
  if (!a) return b;
  return { ...b, bandIds: a.bandIds && b.bandIds ? [...new Set([...a.bandIds, ...b.bandIds])] : null };
}

function start() {
  const { check, requests } = next;
  if (!check && !requests.size) return;
  next = { check: false, requests: new Map() };
  running = true;
  const args = [
    join(project, "node_modules/tsx/dist/cli.mjs"),
    "--conditions=react-server",
    "--env-file=.env.development.local",
    "scripts/sync-catalog.mts",
    "--if-due",
    ...[...requests.values()].flatMap((r) => ["--request", JSON.stringify(r)]),
  ];
  const child = spawn(process.execPath, args, { cwd: project, stdio: "inherit" });
  child.on("exit", () => {
    running = false;
    start();
  });
}

// ---------- the connection ----------

let lastHeard = 0;
let retryMs = 1000;

function connect() {
  if (!secret) {
    console.log(`${stamp()}  No CATALOG_SYNC_SECRET in .deploy.local: Sync now waits for the once-a-minute check.`);
    return;
  }
  const ws = new WebSocket(`${site.replace(/^http/, "ws")}/api/catalog-sync/live`);
  let pinger;
  lastHeard = Date.now();
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ auth: secret }));
    pinger = setInterval(() => {
      if (Date.now() - lastHeard > DEAD_AFTER_MS) return ws.close();
      try {
        ws.send("ping");
      } catch {
        ws.close();
      }
    }, PING_EVERY_MS);
  });
  ws.addEventListener("message", (e) => {
    lastHeard = Date.now();
    if (e.data === "pong") return;
    let msg;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type === "ready") {
      retryMs = 1000;
      console.log(`${stamp()}  Connected to ${site}: Sync now starts here straight away.`);
    } else if (msg.type === "sync" && typeof msg.orgId === "string") {
      run("request", { orgId: msg.orgId, at: msg.at, bandIds: msg.bandIds ?? null });
    }
  });
  ws.addEventListener("close", (e) => {
    clearInterval(pinger);
    if (e.code === 1008) console.log(`${stamp()}  The site turned the connection down (check CATALOG_SYNC_SECRET).`);
    // Back off up to a minute between tries (the once-a-minute check carries on meanwhile).
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 60 * 1000);
  });
  ws.addEventListener("error", () => {
    // "close" follows and retries.
  });
}

if (typeof WebSocket === "undefined") {
  console.error(`${stamp()}  This needs Node 22 or newer for WebSocket (this is ${process.version}).`);
  process.exit(1);
}
connect();
run("check");
setInterval(() => run("check"), CHECK_EVERY_MS);
