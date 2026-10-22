import "server-only";

/** Abel needs a Gemini API key (a Wrangler secret on the live site, .env.development.local locally). */
export const abelConfigured = () => !!process.env.GEMINI_API_KEY;
