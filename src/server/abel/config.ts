import "server-only";

/*
 * Which AI service Abel runs on. A key for one turns Abel on (a Wrangler secret on the live site,
 * .env.development.local locally). Kept apart from agent.ts, so pages can check without loading ADK.
 */

/** Each AI service Abel can run on: its key, and its default model(s) (ABEL_MODEL to change them). */
export const PROVIDERS = {
  /** Gemini, falling back to Claude when Gemini is busy (ABEL_MODEL: a comma-separated list, tried in order). */
  openrouter: { key: "OPENROUTER_API_KEY", models: ["google/gemini-3.8-flash", "anthropic/claude-haiku-5.5"] },
  deepseek: { key: "DEEPSEEK_API_KEY", models: ["deepseek-flash"] },
  /** Google keeps older models from new projects, so this moves on now and then. */
  gemini: { key: "GEMINI_API_KEY", models: ["gemini-3.8-flash"] },
} as const;

export type Provider = keyof typeof PROVIDERS;

/** The service Abel uses: ABEL_PROVIDER, else the first with a key (in the order above). Null: none set up. */
export function abelProvider(env: Record<string, string | undefined> = process.env): Provider | null {
  const chosen = env.ABEL_PROVIDER as Provider | undefined;
  if (chosen && chosen in PROVIDERS) return env[PROVIDERS[chosen].key] ? chosen : null;
  return (Object.keys(PROVIDERS) as Provider[]).find((p) => env[PROVIDERS[p].key]) ?? null;
}

/** Whether Abel has an AI service to run on. */
export const abelConfigured = () => abelProvider() !== null;
