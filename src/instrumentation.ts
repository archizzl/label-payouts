/**
 * Runs once when the server starts, before it handles requests. Locally: bring the database schema
 * up to date. On Cloudflare (no migration files to read; `npm run db:migrate` runs them before each
 * deploy): refuse to run without the settings a public site needs.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { onCloudflare, ready } = await import("./db");
  if (!onCloudflare) return ready;
  const missing = ["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "BETTER_AUTH_URL", "CRON_SECRET"].filter((k) => !process.env[k]);
  if (missing.length || process.env.BETTER_AUTH_URL?.includes("REPLACE_WITH")) {
    throw new Error(`The site isn't set up yet: missing ${missing.join(", ") || "BETTER_AUTH_URL (still a placeholder)"}. See DEPLOY.md.`);
  }
}
