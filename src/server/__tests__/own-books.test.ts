import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

process.env.APP_ENCRYPTION_KEY ??= "test-key";

// Who's signed in, for the Settings action: the band account's shared login.
let signedIn: { orgId: string; managedBy: { labelOrgId: string; labelName: string; ownBooks: boolean } | null } = { orgId: "", managedBy: null };
vi.mock("../context", () => ({
  requireAdmin: async () => signedIn,
  accountContext: async () => signedIn,
  realContext: async () => signedIn,
  getSession: async () => null,
  accountsFor: async () => [],
  BOOKS_COOKIE: "lm_books",
  VIEW_AS_COOKIE: "lm_view_as",
  ownBooksValue: (id: string) => `${id}|own`,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => {}, delete: () => {}, get: () => undefined }), headers: async () => new Headers() }));

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let own: typeof import("../own-books");
let ba: typeof import("../band-accounts");
let people: typeof import("../people");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  own = await import("../own-books");
  ba = await import("../band-accounts");
  people = await import("../people");
});

async function login(name: string) {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  return id;
}

/** A label with one band, two members (one with their own login on the band's account), and that account. */
async function setup() {
  const labelOrgId = await newAccount("Label");
  const [band] = await db.insert(schema.bands).values({ orgId: labelOrgId, name: "Glass Harbor" }).returning();
  const [ana, ben] = await db
    .insert(schema.people)
    .values([
      { orgId: labelOrgId, name: "Ana", email: "ana@example.test", paypalMe: "ana" },
      { orgId: labelOrgId, name: "Ben", venmo: "ben" },
    ])
    .returning();
  await db.insert(schema.bandMemberships).values([
    { orgId: labelOrgId, bandId: band.id, personId: ana.id, roles: ["drums"] },
    { orgId: labelOrgId, bandId: band.id, personId: ben.id, roles: [] },
  ]);
  await ba.ensureBandAccounts(labelOrgId);
  const bandOrgId = (await ba.subAccountFor(labelOrgId, band.id))!.org.id;
  const anaLogin = await login("Ana");
  await db.insert(schema.bandLoginPeople).values({ orgId: bandOrgId, userId: anaLogin, personId: ana.id });
  return { labelOrgId, band, ana, ben, bandOrgId, anaLogin };
}

const ownPeople = (bandOrgId: string) => db.select().from(schema.people).where(eq(schema.people.orgId, bandOrgId));
const ownMemberships = (bandOrgId: string) => db.select().from(schema.bandMemberships).where(eq(schema.bandMemberships.orgId, bandOrgId));

describe("a label-made band account's own books", () => {
  it("turning on makes the band and its members there, linked to the label's, once", async () => {
    const { bandOrgId, ana, ben, anaLogin } = await setup();
    expect((await ba.managingLabel(bandOrgId))?.ownBooks).toBe(false);

    await own.setOwnBooks(bandOrgId, true);
    await own.syncOwnPeople(bandOrgId);

    expect((await ba.managingLabel(bandOrgId))?.ownBooks).toBe(true);
    const [ownBand] = await db.select().from(schema.bands).where(eq(schema.bands.orgId, bandOrgId));
    expect(ownBand.name).toBe("Glass Harbor");
    const mine = await ownPeople(bandOrgId);
    expect(mine).toHaveLength(2);
    const ownAna = mine.find((p) => p.labelPersonId === ana.id)!;
    expect(ownAna).toMatchObject({ name: "Ana", email: "ana@example.test", paypalMe: "ana", userId: anaLogin });
    expect(mine.find((p) => p.labelPersonId === ben.id)).toMatchObject({ name: "Ben", venmo: "ben", userId: null });
    const memberships = await ownMemberships(bandOrgId);
    expect(memberships).toHaveLength(2);
    expect(memberships.every((m) => m.bandId === ownBand.id && m.active)).toBe(true);
    expect(memberships.find((m) => m.personId === ownAna.id)?.roles).toEqual(["drums"]);
  });

  it("follows who's in the band in the label's books, keeping people who left", async () => {
    const { labelOrgId, band, ben, bandOrgId } = await setup();
    await own.setOwnBooks(bandOrgId, true);
    await db
      .update(schema.bandMemberships)
      .set({ active: false })
      .where(and(eq(schema.bandMemberships.orgId, labelOrgId), eq(schema.bandMemberships.personId, ben.id)));
    const [cy] = await db.insert(schema.people).values({ orgId: labelOrgId, name: "Cy" }).returning();
    await db.insert(schema.bandMemberships).values({ orgId: labelOrgId, bandId: band.id, personId: cy.id });

    await own.syncOwnPeopleForBand(labelOrgId, band.id);

    const mine = await ownPeople(bandOrgId);
    expect(mine.map((p) => p.name).sort()).toEqual(["Ana", "Ben", "Cy"]);
    const memberships = await ownMemberships(bandOrgId);
    const active = (name: string) => memberships.find((m) => m.personId === mine.find((p) => p.name === name)!.id)?.active;
    expect(active("Ben")).toBe(false);
    expect(active("Cy")).toBe(true);
  });

  it("turning off keeps everything and stops following", async () => {
    const { labelOrgId, band, bandOrgId } = await setup();
    await own.setOwnBooks(bandOrgId, true);
    await own.setOwnBooks(bandOrgId, false);
    const [dee] = await db.insert(schema.people).values({ orgId: labelOrgId, name: "Dee" }).returning();
    await db.insert(schema.bandMemberships).values({ orgId: labelOrgId, bandId: band.id, personId: dee.id });
    await own.syncOwnPeople(bandOrgId);
    expect(await ownPeople(bandOrgId)).toHaveLength(2);
    expect(await db.select().from(schema.bands).where(eq(schema.bands.orgId, bandOrgId))).toHaveLength(1);
    // On again: the same band, not a second one, and Dee joins.
    await own.setOwnBooks(bandOrgId, true);
    expect(await db.select().from(schema.bands).where(eq(schema.bands.orgId, bandOrgId))).toHaveLength(1);
    expect(await ownPeople(bandOrgId)).toHaveLength(3);
  });

  it("keeps each person's details the same in both books", async () => {
    const { ana, ben, bandOrgId, anaLogin } = await setup();
    await own.setOwnBooks(bandOrgId, true);
    const ownBen = (await ownPeople(bandOrgId)).find((p) => p.labelPersonId === ben.id)!;

    // Ana changes her details on Account: both her records follow.
    await people.applyMyDetails(anaLogin, { paypalMe: "ana-new" });
    const both = await db.select().from(schema.people).where(eq(schema.people.paypalMe, "ana-new"));
    expect(both.map((p) => p.id).sort()).toEqual([ana.id, (await ownPeople(bandOrgId)).find((p) => p.labelPersonId === ana.id)!.id].sort());

    // The label edits Ben: his own-books record follows, and the other way round.
    await own.shareDetails(ben.id, { name: "Benjamin", cashtag: "benj" });
    expect((await db.select().from(schema.people).where(eq(schema.people.id, ownBen.id)))[0]).toMatchObject({ name: "Benjamin", cashtag: "benj" });
    await own.shareDetails(ownBen.id, { email: "ben@example.test" });
    expect((await db.select().from(schema.people).where(eq(schema.people.id, ben.id)))[0].email).toBe("ben@example.test");
  });

  it("isn't synced with Bandcamp while own books are off", async () => {
    const { bandOrgId } = await setup();
    await db.update(schema.accountSettings).set({ bandcampUrl: "glassharbor.bandcamp.com" }).where(eq(schema.accountSettings.orgId, bandOrgId));
    const sync = await import("../auto-sync");
    expect(await sync.syncAccount(bandOrgId, { force: true })).toMatchObject({ ran: false, summary: "Own books are off." });
  });

  it("can't use the label's Bandcamp API access", async () => {
    const { labelOrgId, bandOrgId } = await setup();
    await db.insert(schema.accountSettings).values({ orgId: labelOrgId, bandcampClientId: "label-client" });
    const actions = await import("../account-actions");
    const form = (clientId: string) => {
      const fd = new FormData();
      fd.set("bandcampUrl", "glassharbor.bandcamp.com");
      fd.set("bandcampClientId", clientId);
      return fd;
    };

    signedIn = { orgId: bandOrgId, managedBy: { labelOrgId, labelName: "Label", ownBooks: true } };
    expect((await actions.saveAccountSettings(null, form("label-client")))?.error).toMatch(/Label’s Bandcamp API access/);
    expect(await actions.saveAccountSettings(null, form("band-client"))).toEqual({ ok: "Saved" });
    const [saved] = await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, bandOrgId));
    expect(saved.bandcampClientId).toBe("band-client");
  });

  it("warns when the label's Bandcamp API access reaches the same Bandcamp band", async () => {
    const { labelOrgId, bandOrgId } = await setup();
    await own.setOwnBooks(bandOrgId, true);
    const reached = (orgId: string, bands: { id: number; name: string }[]) =>
      db.insert(schema.accountSettings).values({ orgId, bandcampBands: bands }).onConflictDoUpdate({ target: schema.accountSettings.orgId, set: { bandcampBands: bands } });

    expect(await own.bothBooksWarning(bandOrgId)).toBeNull(); // nothing checked yet
    await reached(labelOrgId, [
      { id: 1, name: "Label" },
      { id: 2, name: "Other Band" },
    ]);
    await reached(bandOrgId, [{ id: 3, name: "Glass Harbor" }]);
    expect(await own.bothBooksWarning(bandOrgId)).toBeNull();

    await reached(labelOrgId, [
      { id: 1, name: "Label" },
      { id: 3, name: "Glass Harbor" },
    ]);
    expect(await own.bothBooksWarning(bandOrgId)).toBe(
      "Label’s Bandcamp API access also reaches Glass Harbor, so its sales could come into both books and be paid out twice.",
    );
    // Only for a band account's own books.
    expect(await own.bothBooksWarning(labelOrgId)).toBeNull();
  });

  it("Test connection notes the Bandcamp bands reached, and warns about the overlap", async () => {
    const { labelOrgId, bandOrgId } = await setup();
    await own.setOwnBooks(bandOrgId, true);
    const secrets = await import("../secrets");
    await db
      .update(schema.accountSettings)
      .set({ bandcampClientId: `band-${bandOrgId}`, bandcampClientSecret: secrets.encryptSecret("s") })
      .where(eq(schema.accountSettings.orgId, bandOrgId));
    await db.insert(schema.accountSettings).values({ orgId: labelOrgId, bandcampBands: [{ id: 1, name: "Label" }, { id: 3, name: "Glass Harbor" }] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth_token")) return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600 }));
        return new Response(JSON.stringify({ bands: [{ band_id: 3, name: "Glass Harbor", subdomain: "glassharbor" }] }));
      }),
    );
    const actions = await import("../account-actions");
    signedIn = { orgId: bandOrgId, managedBy: { labelOrgId, labelName: "Label", ownBooks: true } };
    expect(await actions.testBandcampConnection()).toEqual({
      error: "Connected to Glass Harbor. Label’s Bandcamp API access also reaches Glass Harbor, so its sales could come into both books and be paid out twice.",
    });
    vi.unstubAllGlobals();
  });

  it("its Bandcamp sales sync leaves out sales the label's books already have", async () => {
    const { labelOrgId, bandOrgId } = await setup();
    await own.setOwnBooks(bandOrgId, true);
    const secrets = await import("../secrets");
    const creds = { bandcampClientSecret: secrets.encryptSecret("s") };
    await db.update(schema.accountSettings).set({ bandcampClientId: `band-${bandOrgId}`, ...creds }).where(eq(schema.accountSettings.orgId, bandOrgId));
    await db
      .insert(schema.accountSettings)
      .values({ orgId: labelOrgId, bandcampClientId: `label-${labelOrgId}`, ...creds })
      .onConflictDoUpdate({ target: schema.accountSettings.orgId, set: { bandcampClientId: `label-${labelOrgId}`, ...creds } });
    const sale = (id: number, name: string) => ({
      bandcamp_transaction_item_id: id,
      bandcamp_transaction_id: 4000 + id,
      date: "13 May 2026 23:28:01 GMT",
      item_type: "album",
      item_name: name,
      artist: "Glass Harbor",
      currency: "USD",
      net_amount: 7.5,
      package: "digital download",
      item_url: `https://glassharbor.bandcamp.com/album/${id}`,
    });
    let report = [sale(1, "Through the label")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth_token")) return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600 }));
        if (url.includes("my_bands")) return new Response(JSON.stringify({ bands: [{ band_id: 3, name: "Glass Harbor", subdomain: "glassharbor" }] }));
        return new Response(JSON.stringify({ report }));
      }),
    );
    const sync = await import("../sync");
    expect((await sync.runSalesSync(labelOrgId)).added).toBe(1);

    report = [sale(1, "Through the label"), sale(2, "Only its own")];
    const result = await sync.runSalesSync(bandOrgId);
    expect(result.added).toBe(1);
    expect(result.inLabelBooks).toEqual({ count: 1, labelName: "Label" });
    const mine = await db.select({ itemName: schema.sales.itemName }).from(schema.sales).where(eq(schema.sales.orgId, bandOrgId));
    expect(mine).toEqual([{ itemName: "Only its own" }]);
    // The label's own sync leaves nothing out.
    expect((await sync.runSalesSync(labelOrgId)).inLabelBooks.count).toBe(0);
    vi.unstubAllGlobals();
  });
});
