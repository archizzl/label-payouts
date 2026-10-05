import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

process.env.APP_ENCRYPTION_KEY ??= "test-key";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let api: typeof import("../bandcamp-api");
let secrets: typeof import("../secrets");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  api = await import("../bandcamp-api");
  secrets = await import("../secrets");
});
afterEach(() => vi.unstubAllGlobals());

const creds = { clientId: "2653", clientSecret: "s3cret" };
const memory = () => (globalThis as unknown as { bandcampTokens: Map<string, unknown> }).bandcampTokens;

/** Bandcamp's token endpoint, simulated: replies in order, and records what was asked. */
function fakeBandcamp(replies: object[]) {
  const asked: Record<string, string>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: URLSearchParams }) => {
      asked.push(Object.fromEntries(init.body));
      const reply = replies.shift() ?? { error: "unexpected" };
      return new Response(JSON.stringify(reply), { status: "access_token" in reply ? 200 : 400 });
    }),
  );
  return asked;
}

async function account() {
  const orgId = await newAccount();
  await db.insert(schema.accountSettings).values({ orgId, bandcampClientId: creds.clientId, bandcampClientSecret: secrets.encryptSecret(creds.clientSecret) });
  return orgId;
}
const saved = async (orgId: string) => (await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId)))[0];

describe("the Bandcamp sign-in", () => {
  it("signs in once, then reuses the saved sign-in after a restart", async () => {
    const orgId = await account();
    const asked = fakeBandcamp([{ access_token: "A", refresh_token: "R", expires_in: 3600 }]);
    expect(await api.accessToken(orgId, creds)).toBe("A");
    expect(asked.map((a) => a.grant_type)).toEqual(["client_credentials"]);
    const s = await saved(orgId);
    expect(secrets.decryptSecret(s.bandcampRefreshToken!)).toBe("R"); // kept, encrypted
    expect(s.bandcampAccessToken).toMatch(/^v1:/); // encrypted, never stored in the clear
    expect(secrets.decryptSecret(s.bandcampAccessToken!)).toBe("A");

    memory().clear(); // a restart: nothing in memory
    expect(await api.accessToken(orgId, creds)).toBe("A");
    expect(asked).toHaveLength(1); // no new sign-in
  });

  it("renews with the refresh token when the access runs out, instead of signing in again", async () => {
    const orgId = await account();
    const asked = fakeBandcamp([
      { access_token: "A", refresh_token: "R", expires_in: 3600 },
      { access_token: "B", refresh_token: "R2", expires_in: 3600 },
    ]);
    await api.accessToken(orgId, creds);
    memory().clear();
    await db.update(schema.accountSettings).set({ bandcampTokenExpiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.accountSettings.orgId, orgId));
    expect(await api.accessToken(orgId, creds)).toBe("B");
    expect(asked[1]).toMatchObject({ grant_type: "refresh_token", refresh_token: "R" });
    expect(secrets.decryptSecret((await saved(orgId)).bandcampRefreshToken!)).toBe("R2");
  });

  it("keeps using a sign-in this server already had in memory from before", async () => {
    const orgId = await account();
    const asked = fakeBandcamp([]);
    memory().set(creds.clientId, { accessToken: "OLD", expiresAt: Date.now() + 30 * 60_000 });
    expect(await api.accessToken(orgId, creds)).toBe("OLD");
    expect(asked).toHaveLength(0);
    expect(secrets.decryptSecret((await saved(orgId)).bandcampAccessToken!)).toBe("OLD");
  });

  it("explains when Bandcamp refuses because the client is signed in elsewhere", async () => {
    const orgId = await account();
    memory().clear();
    fakeBandcamp([{ error: "duplicate_grant", error_description: "You have already connected from one location" }]);
    await expect(api.accessToken(orgId, creds)).rejects.toThrow(/already signed in somewhere else/);
  });
});
