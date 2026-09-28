/** Runs once when the server starts, before it handles requests: bring the database schema up to date. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ready } = await import("./db");
    await ready;
  }
}
