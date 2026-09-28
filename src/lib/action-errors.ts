/**
 * Turn an error from calling a server action into something a person can act on. The common case
 * is a page left open while the app was updated or restarted: its server actions no longer exist.
 */
export function describeActionError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/server action|unexpected response|failed to fetch|networkerror|load failed/i.test(msg)) {
    return "Lost contact with the app. It was probably updated or restarted. Reload this page and try again.";
  }
  return msg || "Something went wrong.";
}
