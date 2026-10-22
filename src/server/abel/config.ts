import "server-only";

/**
 * Abel needs an OpenRouter or a Gemini API key (a Wrangler secret on the live site,
 * .env.development.local locally). With both, it uses OpenRouter.
 */
export const abelConfigured = () => !!(process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY);
