/*
 * `npm run sync-catalog:schedule` / `npm run sync-catalog:unschedule`
 *
 * Runs `npm run sync-catalog` (public Bandcamp pages → the live catalog) every 10 minutes on this
 * Mac, through launchd, while the Mac is on and awake. Output goes to
 * ~/Library/Logs/labelmaker-sync-catalog.log.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LABEL = "ing.labelmaker.sync-catalog";
const EVERY_SECONDS = 10 * 60; // keep in step with CATALOG_SYNC_EVERY_MINUTES (src/server/auto-sync.ts)
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
// This Node, and the project's own tsx: the same as `npm run sync-catalog`, without needing a shell.
const args = [
  process.execPath,
  join(project, "node_modules/tsx/dist/cli.mjs"),
  "--conditions=react-server",
  "--env-file=.env.development.local",
  "scripts/sync-catalog.mts",
];
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
  <key>StartInterval</key><integer>${EVERY_SECONDS}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`,
);
launchctl("bootout", `gui/${uid}/${LABEL}`);
execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plist]);
console.log(`Scheduled: the catalog syncs from this Mac every ${EVERY_SECONDS / 60} minutes (starting now).`);
console.log(`Log: ${log}`);
console.log("Stop with: npm run sync-catalog:unschedule");
