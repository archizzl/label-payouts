import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let importLocalBooks: typeof import("../import-local").importLocalBooks;
let data: typeof import("../data");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  ({ importLocalBooks } = await import("../import-local"));
  data = await import("../data");
});

/** An old local-app database (same schema as the SQLite app had), with a little of everything. */
function oldDatabase() {
  const file = join(mkdtempSync(join(tmpdir(), "label-payouts-old-")), "label.db");
  const sqlite = new Database(file);
  migrate(drizzle(sqlite), { migrationsFolder: resolve(import.meta.dirname, "../../../test/fixtures/sqlite-migrations") });
  sqlite.exec(`
    INSERT INTO bands (id, name, url_patterns) VALUES (5, 'Flag Day', '["flagdayband"]'), (9, 'Sweetums', '[]');
    INSERT INTO people (id, name, email, holds_label_account) VALUES (3, 'Archie', 'archie@example.com', 1), (4, 'Billy', 'billy@example.com', 0);
    INSERT INTO band_memberships (band_id, person_id, roles) VALUES (5, 3, '["vocals"]'), (5, 4, '["trumpet"]');
    INSERT INTO releases (id, band_id, title, tags, packages, bandcamp_id) VALUES (7, 5, 'Triple Single', '[]', '[]', 2437477044);
    INSERT INTO split_rules (id, scope, band_id) VALUES (2, 'band_default', 5);
    INSERT INTO split_shares (rule_id, person_id, bps) VALUES (2, 3, 5000), (2, 4, 5000);
    INSERT INTO deductions (label, kind, percent_bps, destination, band_id) VALUES ('Band fund', 'percent', 1000, 'band_fund', 5);
    INSERT INTO imports (id, filename, row_count, added_count, duplicate_count) VALUES (1, 'x.csv', 2, 2, 0);
    INSERT INTO sales (id, import_id, dedupe_key, date, item_type, category, item_name, artist, item_url, package_name, currency, net_cents, transaction_id, routing_key, band_id, release_id, raw)
      VALUES (1, 1, 'k1', '2026-01-05', 'album', 'album', 'Triple Single', 'Flag Day', '', '', 'USD', 1000, 't1', 'r', 5, 7, '{}'),
             (2, 1, 'k2', '2026-02-05', 'album', 'album', 'Triple Single', 'Flag Day', '', '', 'USD', 2000, 't2', 'r', 5, 7, '{}');
    INSERT INTO periods (id, name, band_id, start_date, end_date, status, snapshot)
      VALUES (1, 'Jan', 5, '2026-01-01', '2026-01-31', 'paid', '{"saleCount":1,"currencies":[{"currency":"USD","grossCents":1000,"byBand":[{"bandId":5,"cents":1000}],"byDestination":[{"key":"band_fund:5","cents":100}],"unallocated":0,"problems":{"unrouted":0,"noRule":0}}]}');
    INSERT INTO payouts (period_id, person_id, currency, amount_cents, by_band, status) VALUES (1, 3, 'USD', 450, '{"5":450}', 'kept'), (1, 4, 'USD', 450, '{"5":450}', 'paid');
  `);
  sqlite.close();
  return file;
}

describe("bringing over the old local app's books", () => {
  it("copies everything into the account, renumbering ids and every reference to them", async () => {
    // Another account already has a band, so the new ids can't match the old ones.
    const other = await newAccount("Someone else");
    await db.insert(schema.bands).values({ orgId: other, name: "Their band" });
    const orgId = await newAccount("Reaction Future Records");

    const counts = await importLocalBooks(oldDatabase(), orgId);
    expect(counts).toMatchObject({ bands: 2, people: 2, sales: 2, periods: 1, payouts: 2 });

    const bands = await db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId));
    const flag = bands.find((b) => b.name === "Flag Day")!;
    expect(flag.id).not.toBe(5);
    expect(flag.urlPatterns).toEqual(["flagdayband"]);
    // Bandcamp ids are bigger than 32 bits.
    const [release] = await db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId));
    expect(release.bandcampId).toBe(2437477044);

    // The same money comes out of the same rules.
    const { summary } = await data.computeAllTime(orgId);
    expect(summary.byCurrency.USD.grossCents).toBe(3000);
    expect(summary.byCurrency.USD.byBand.get(flag.id)).toBe(3000);
    expect(summary.byCurrency.USD.byDestination.get(`band_fund:${flag.id}`)).toBe(300);

    // Payout history points at the new band and people, and January is still marked paid.
    const [period] = await db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId));
    expect(period.bandId).toBe(flag.id);
    expect(period.snapshot!.currencies[0].byBand[0].bandId).toBe(flag.id);
    expect(period.snapshot!.currencies[0].byDestination[0].key).toBe(`band_fund:${flag.id}`);
    const payouts = await db.select().from(schema.payouts).where(eq(schema.payouts.orgId, orgId));
    expect(payouts.map((p) => p.byBand)).toEqual([{ [flag.id]: 450 }, { [flag.id]: 450 }]);
    expect(payouts.map((p) => p.status).sort()).toEqual(["kept", "paid"]);
    const feb = await data.computePayoutPeriod(orgId, { id: 0, startDate: "2026-01-01", endDate: "2026-12-31", bandId: null });
    expect(feb.results).toHaveLength(1); // only February is left to pay

    // Nothing leaked into the other account.
    expect((await data.computeAllTime(other)).results).toEqual([]);
  });
});
