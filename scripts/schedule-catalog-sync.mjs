/*
 * `npm run sync-catalog:schedule` / `npm run sync-catalog:unschedule`
 *
 * Runs `npm run sync-catalog` (public Bandcamp pages → the live catalog) on this Mac, while it's on
 * and awake: every 10 minutes, and straight away on "Sync now". launchd keeps
 * scripts/catalog-watcher.mjs running (it stays connected to the site for Sync now) and restarts it
 * if it stops. Output goes to ~/Library/Logs/labelmaker-sync-catalog.log.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { node22Path } from "./node22.mjs";

const LABEL = "ing.labelmaker.sync-catalog";
const plist = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const log = join(homedir(), "Library/Logs/labelmaker-sync-catalog.log");
const project = resolve(import.meta.dirname, "..");
const uid = process.getuid();
const launchctl = (...args) => {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch {
    // not loaded yet / already gone
  }
};

if (process.argv.includes("--remove")) {
  launchctl("bootout", `gui/${uid}/${LABEL}`);
  if (existsSync(plist)) unlinkSync(plist);
  console.log("Stopped: the catalog no longer syncs from this Mac.");
  process.exit(0);
}

if (!existsSync(join(project, ".deploy.local"))) {
  console.error("Needs .deploy.local (the live database's address) in this folder first.");
  process.exit(1);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
// Node 22 (the watcher needs its WebSocket), without needing a shell.
const node = node22Path();
if (!node) {
  console.error(`The catalog sync needs Node 22 or newer (this is ${process.version}). Install it with: nvm install 22`);
  process.exit(1);
}
const args = [node, join(project, "scripts/catalog-watcher.mjs")];
mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${esc(project)}</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`,
);
launchctl("bootout", `gui/${uid}/${LABEL}`);
execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plist]);
console.log("Scheduled: the catalog syncs from this Mac every 10 minutes, and straight away on “Sync now” on the live site.");
console.log(`Log: ${log}`);
console.log("Stop with: npm run sync-catalog:unschedule");
