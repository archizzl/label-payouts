/** The app as OpenNext builds it (.open-next/worker.js, aliased in wrangler.jsonc). */
declare module "open-next-worker" {
  const handler: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
  export default handler;
}
