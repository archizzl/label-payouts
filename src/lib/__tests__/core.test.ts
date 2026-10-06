import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBandcampApiReport, parseBandcampCsv, parseBandcampDate } from "../bandcamp-csv";
import { allocate, parseCents } from "../money";
import { cashAppLink, cleanCashtag, cleanVenmoHandle, payMethods, paypalBulkCsv, paypalMeLink, venmoLink } from "../paypal-export";
import { type Catalog, routeSale } from "../routing";
import { computeLedger, roundToTotal, type Deduction, type EngineContext, type EngineSale, formatMatches, type SplitRule, summarize } from "../splits";

const fixture = (name: string) => readFileSync(join(__dirname, "../../../test/fixtures", name));

describe("money", () => {
  it("parses money strings", () => {
    expect(parseCents("$1,234.56")).toBe(123456);
    expect(parseCents("-13.00")).toBe(-1300);
    expect(parseCents("(2.50)")).toBe(-250);
    expect(parseCents("12,50")).toBe(1250);
    expect(parseCents("")).toBe(0);
  });

  it("allocates with exact sums, including negatives", () => {
    for (const total of [100, 101, 1, 0, -101, 99999]) {
      const parts = allocate(total, [
        { key: "a", weight: 1 },
        { key: "b", weight: 1 },
        { key: "c", weight: 1 },
      ]);
      expect(parts.reduce((s, p) => s + p.cents, 0)).toBe(total);
    }
    expect(allocate(100, [{ key: "a", weight: 3333 }, { key: "b", weight: 6667 }])).toEqual([
      { key: "a", cents: 33 },
      { key: "b", cents: 67 },
    ]);
  });
});

describe("bandcamp csv", () => {
  it("parses UTF-8 and UTF-16 identically", () => {
    const a = parseBandcampCsv(new Uint8Array(fixture("label-sample.csv")));
    const b = parseBandcampCsv(new Uint8Array(fixture("label-sample-utf16.csv")));
    expect(a.missingColumns).toEqual([]);
    expect(a.sales.length).toBe(12);
    expect(b.sales).toEqual(a.sales);
  });

  it("normalizes rows, skips payouts, strips buyer PII", () => {
    const { sales, skipped } = parseBandcampCsv(new Uint8Array(fixture("label-sample.csv")));
    expect(skipped.map((s) => s.reason)).toEqual(["Not a sale (payout)"]);
    const first = sales[0];
    expect(first).toMatchObject({ date: "2026-01-03", category: "album", artist: "Glass Harbor", netCents: 850 });
    expect(first.raw["buyer email"]).toBeUndefined();
    expect(first.raw["buyer name"]).toBeUndefined();
    expect(sales.find((s) => s.itemType === "refund")?.netCents).toBe(-1300);
    expect(sales.find((s) => s.itemName === "Logo T-Shirt")?.category).toBe("merch");
    expect(new Set(sales.map((s) => s.dedupeKey)).size).toBe(sales.length);
  });

  it("gives stable dedupe keys across re-parses", () => {
    const a = parseBandcampCsv(new Uint8Array(fixture("label-sample.csv")));
    const b = parseBandcampCsv(new Uint8Array(fixture("label-sample.csv")));
    expect(a.sales.map((s) => s.dedupeKey)).toEqual(b.sales.map((s) => s.dedupeKey));
  });

  it("reports missing required columns", () => {
    const r = parseBandcampCsv("foo,bar\n1,2\n");
    expect(r.missingColumns).toContain("net");
  });

  it("parses date formats", () => {
    expect(parseBandcampDate("1/3/26 10:12am")).toBe("2026-01-03");
    expect(parseBandcampDate("12/31/2025 23:59")).toBe("2025-12-31");
    expect(parseBandcampDate("2026-02-01 08:00:00")).toBe("2026-02-01");
    expect(parseBandcampDate("13 May 2026 23:28:01 GMT")).toBe("2026-05-13");
  });

  it("reads the sales API's rows with the same keys as the CSV", () => {
    const csv = parseBandcampCsv(
      "date,item type,item name,artist,currency,net amount,bandcamp transaction id,package,item url,buyer email\n" +
        "5/13/26 11:28pm,album,Live,Flag Day,USD,0.75,4027003576,digital download,https://x.bandcamp.com/album/live,a@b.c\n",
    );
    const api = parseBandcampApiReport([
      { bandcamp_transaction_item_id: 1, date: "13 May 2026 23:28:01 GMT", item_type: "album", item_name: "Live", artist: "Flag Day", currency: "USD", net_amount: 0.75, bandcamp_transaction_id: 4027003576, package: "digital download", item_url: "https://x.bandcamp.com/album/live", buyer_email: "a@b.c", ship_to_name: "A", sku: null },
      { bandcamp_transaction_item_id: 2, date: "14 May 2026 10:00:00 GMT", item_type: "payout", net_amount: null, bandcamp_transaction_id: "t1" },
    ]);
    expect(api.missingColumns).toEqual([]);
    expect(api.skipped.map((s) => s.reason)).toEqual(["Not a sale (payout)"]);
    expect(api.sales).toHaveLength(1);
    expect(api.sales[0]).toMatchObject({ dedupeKey: csv.sales[0].dedupeKey, date: "2026-05-13", netCents: 75 });
    expect(Object.keys(api.sales[0].raw).filter((k) => k.startsWith("buyer") || k.startsWith("ship to"))).toEqual([]);
  });
});

describe("routing", () => {
  const catalog: Catalog = {
    bands: [
      { id: 1, name: "Glass Harbor", aliases: [], urlPatterns: ["glassharbor"] },
      { id: 2, name: "Moth Parade", aliases: ["Moth Parade Band"], urlPatterns: [] },
      { id: 3, name: "The Quiet Engines", aliases: [], urlPatterns: ["quietengines.bandcamp.com"] },
    ],
    releases: [
      { id: 10, bandId: 1, title: "Night Swims", url: null },
      { id: 20, bandId: 2, title: "Static Bloom", url: "https://label.bandcamp.com/album/static-bloom" },
    ],
    tracks: [{ id: 100, releaseId: 10, bandId: 1, title: "Undertow", url: null }],
    overrides: [
      { matchKey: "url:label.bandcamp.com/album/split-series-vol-1", bandId: 1, releaseId: null, trackId: null },
    ],
  };
  const sale = (over: Partial<Parameters<typeof routeSale>[0]>) => ({
    itemUrl: "",
    artist: "",
    itemName: "",
    category: "album" as const,
    ...over,
  });

  it("uses remembered overrides first", () => {
    expect(routeSale(sale({ itemUrl: "https://label.bandcamp.com/album/split-series-vol-1/", artist: "Moth Parade" }), catalog))
      .toMatchObject({ bandId: 1, via: "override" });
  });
  it("matches exact catalog URLs", () => {
    expect(routeSale(sale({ itemUrl: "https://label.bandcamp.com/album/static-bloom" }), catalog)).toMatchObject({
      bandId: 2,
      releaseId: 20,
      via: "item_url",
    });
  });
  it("matches band by subdomain then fuzzy title", () => {
    expect(
      routeSale(sale({ itemUrl: "https://glassharbor.bandcamp.com/album/x", itemName: "Night Swims - 12in Vinyl LP", category: "merch" }), catalog),
    ).toMatchObject({ bandId: 1, releaseId: 10, via: "band_url" });
    expect(
      routeSale(sale({ itemUrl: "https://glassharbor.bandcamp.com/track/undertow", itemName: "Undertow", category: "track" }), catalog),
    ).toMatchObject({ bandId: 1, releaseId: 10, trackId: 100 });
    expect(routeSale(sale({ itemUrl: "https://quietengines.bandcamp.com/album/low-sun" }), catalog)).toMatchObject({ bandId: 3 });
  });
  it("falls back to artist name and aliases", () => {
    expect(routeSale(sale({ itemUrl: "https://label.bandcamp.com/track/x", artist: "moth parade band" }), catalog)).toMatchObject({
      bandId: 2,
      via: "artist",
    });
    expect(routeSale(sale({ artist: "Quiet Engines" }), catalog)).toMatchObject({ bandId: 3 });
  });
  it("leaves unknown artists unrouted", () => {
    expect(routeSale(sale({ itemUrl: "https://label.bandcamp.com/album/y", artist: "Nobody" }), catalog).bandId).toBeNull();
  });
});

describe("split engine", () => {
  it("rounds payout totals once, so an even split pays everyone within a cent", () => {
    // Five people at 20% each, and 37 sales that each leave cents to round.
    const five = [1, 2, 3, 4, 5];
    const rule = { id: 1, scope: "band_default", bandId: 1, releaseId: null, trackId: null, itemCategory: null, effectiveFrom: "2000-01-01", overridesCatalog: false, shares: five.map((personId) => ({ personId, bps: 2000 })) };
    const sales = Array.from({ length: 37 }, (_, i) => s(i + 1, { bandId: 1, netCents: 333 + i * 7 }));
    const results = computeLedger(sales, { ...ctx, deductions: [], rules: [rule as (typeof ctx.rules)[number]] });
    const perSale = new Map<number, number>();
    for (const r of results) for (const x of r.shares) perSale.set(x.personId, (perSale.get(x.personId) ?? 0) + x.cents);
    const totals = five.map((id) => summarize(results).byCurrency.USD.byPerson.get(id)!.total);
    const everything = results.reduce((a, r) => a + r.netCents, 0);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(everything); // every cent still paid
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
    // Rounding each sale on its own is what used to favour the first person listed.
    expect(Math.max(...perSale.values()) - Math.min(...perSale.values())).toBeGreaterThan(1);
  });

  it("breaks rounding ties differently from payout to payout", () => {
    const exact = new Map([1, 2, 3, 4, 5].map((id) => [id, 10.2]));
    const winners = new Set(Array.from({ length: 20 }, (_, seed) => [...roundToTotal(exact, 51, seed)].find(([, c]) => c === 11)![0]));
    expect(winners.size).toBeGreaterThan(1);
  });

  const rule = (r: Partial<SplitRule> & Pick<SplitRule, "id" | "scope" | "shares">): SplitRule => ({
    bandId: null,
    releaseId: null,
    trackId: null,
    itemCategory: null,
    overridesCatalog: false,
    effectiveFrom: "2000-01-01",
    ...r,
  });
  const deduction = (d: Partial<Deduction> & Pick<Deduction, "id" | "kind">): Deduction => ({
    label: `d${d.id}`,
    percentBps: null,
    amountCents: null,
    currency: null,
    destination: "label",
    bandId: null,
    releaseId: null,
    trackId: null,
    itemCategory: null,
    effectiveFrom: null,
    effectiveTo: null,
    sortOrder: 0,
    ...d,
  });
  const s = (id: number, over: Partial<EngineSale> = {}): EngineSale => ({
    id,
    date: "2026-01-10",
    bandId: 1,
    releaseId: null,
    trackId: null,
    category: "album",
    currency: "USD",
    netCents: 1000,
    ...over,
  });

  // Band 1: people 1,2,3. Band 2: people 3 (in both bands), 4.
  const ctx: EngineContext = {
    rules: [
      rule({ id: 1, scope: "band_default", bandId: 1, shares: [{ personId: 1, bps: 3334 }, { personId: 2, bps: 3333 }, { personId: 3, bps: 3333 }] }),
      rule({ id: 2, scope: "band_default", bandId: 2, shares: [{ personId: 3, bps: 5000 }, { personId: 4, bps: 5000 }] }),
      rule({ id: 3, scope: "release", releaseId: 10, shares: [{ personId: 1, bps: 10000 }] }),
      rule({ id: 4, scope: "release", releaseId: 10, effectiveFrom: "2026-02-01", shares: [{ personId: 2, bps: 10000 }] }),
      rule({ id: 5, scope: "track", trackId: 100, shares: [{ personId: 3, bps: 10000 }] }),
      rule({ id: 6, scope: "band_item_type", bandId: 1, itemCategory: "merch", shares: [{ personId: 1, bps: 5000 }, { personId: 2, bps: 5000 }] }),
    ],
    deductions: [
      deduction({ id: 1, kind: "percent", percentBps: 2000, destination: "label", label: "Label cut" }),
      deduction({ id: 2, kind: "percent", percentBps: 1000, destination: "band_fund", bandId: 1, label: "GH fund", sortOrder: -5 }),
    ],
    releases: [
      { id: 10, albumSplitMode: "band_default", trackIds: [100] },
      { id: 11, albumSplitMode: "average_tracks", trackIds: [100, 101] },
    ],
  };

  it("applies label cut before band deductions, and sums exactly", () => {
    const [r] = computeLedger([s(1, { netCents: 1001 })], ctx);
    expect(r.deductions.map((d) => [d.label, d.cents])).toEqual([
      ["Label cut", 200],
      ["GH fund", 80],
    ]);
    expect(r.ruleSource).toBe("band_default");
    const total = r.deductions.reduce((a, d) => a + d.cents, 0) + r.shares.reduce((a, x) => a + x.cents, 0);
    expect(total).toBe(1001);
  });

  it("uses track → release → item type → band default precedence with effective dates", () => {
    const results = computeLedger(
      [
        s(1, { releaseId: 10, trackId: 100, category: "track" }),
        s(2, { releaseId: 10 }),
        s(3, { releaseId: 10, date: "2026-02-15" }),
        s(4, { category: "merch" }),
        s(5, { releaseId: 10, category: "merch" }),
      ],
      ctx,
    );
    const who = (id: number) => results.find((r) => r.saleId === id)!;
    expect(who(1).ruleSource).toBe("track");
    expect(who(1).shares.map((x) => x.personId)).toEqual([3]);
    expect(who(2).shares.map((x) => x.personId)).toEqual([1]);
    expect(who(3).shares.map((x) => x.personId)).toEqual([2]); // newer release split
    expect(who(4).ruleSource).toBe("band_item_type");
    expect(who(5).ruleSource).toBe("release"); // release split wins unless the merch rule overrides
  });

  it("lets an item-type rule override catalog splits when flagged", () => {
    const c2 = { ...ctx, rules: ctx.rules.map((r) => (r.id === 6 ? { ...r, overridesCatalog: true } : r)) };
    const [r] = computeLedger([s(1, { releaseId: 10, category: "merch" })], c2);
    expect(r.ruleSource).toBe("band_item_type");
  });

  it("averages track splits for albums when configured", () => {
    const [r] = computeLedger([s(1, { releaseId: 11, netCents: 800 })], { ...ctx, deductions: [] });
    // track 100 → person 3 (100%), track 101 → band default (1/3 each) ⇒ p3 = 2/3, p1,p2 = 1/6
    expect(r.ruleSource).toBe("album_average");
    const byPerson = Object.fromEntries(r.shares.map((x) => [x.personId, x.cents]));
    expect(byPerson[3]).toBe(533);
    expect(byPerson[1] + byPerson[2] + byPerson[3]).toBe(800);
  });

  it("recoups fixed costs across sales in date order and skips refunds", () => {
    const c2: EngineContext = {
      ...ctx,
      deductions: [deduction({ id: 9, kind: "fixed", amountCents: 1500, destination: "expense", bandId: 1 })],
    };
    const results = computeLedger(
      [s(2, { date: "2026-01-02" }), s(1, { date: "2026-01-01" }), s(3, { date: "2026-01-03", netCents: -500 }), s(4, { date: "2026-01-04" })],
      c2,
    );
    expect(results.map((r) => r.deductions[0]?.cents ?? 0)).toEqual([1000, 500, 0, 0]);
  });

  it("flags unrouted sales and missing rules", () => {
    const results = computeLedger([s(1, { bandId: null }), s(2, { bandId: 99 })], ctx);
    expect(results.map((r) => r.problem)).toEqual(["unrouted", "no_rule"]);
    expect(results[0].unallocatedCents).toBe(1000);
    expect(results[1].unallocatedCents).toBe(800); // label cut still taken
  });

  describe("withholding a part of each sale (e.g. what fans paid above the price)", () => {
    const extra = (over: Partial<Deduction> = {}) =>
      deduction({ id: 80, kind: "sale_part", salePart: "fan_extra", destination: "band_fund", label: "Tips to the band fund", ...over });
    const sale = (id: number, extraCents: number, over: Partial<EngineSale> = {}) => s(id, { netCents: 1500, parts: { fan_extra: extraCents }, ...over });

    it("takes exactly that part of each sale, then splits the rest", () => {
      const [a, b, none] = computeLedger([sale(1, 500), sale(2, 49), sale(3, 0)], { ...ctx, deductions: [extra()] });
      expect(a.deductions).toEqual([expect.objectContaining({ label: "Tips to the band fund", destination: "band_fund", cents: 500 })]);
      expect(a.shares.reduce((x, y) => x + y.cents, 0)).toBe(1000);
      expect(b.deductions[0].cents).toBe(49);
      expect(none.deductions).toEqual([]);
    });

    it("never takes more than the sale, and a refund reverses it", () => {
      const [tiny, refund] = computeLedger([sale(1, 900, { netCents: 600 }), sale(2, 400, { netCents: -1500 })], { ...ctx, deductions: [extra()] });
      expect(tiny.deductions[0].cents).toBe(600);
      expect(refund.deductions[0].cents).toBe(-400);
    });
  });

  describe("per-item costs (e.g. CD manufacturing)", () => {
    const cdCost = (over: Partial<Deduction> = {}) =>
      deduction({ id: 70, kind: "per_unit", amountCents: 342, currency: "USD", destination: "expense", itemCategory: "merch", formatMatch: "CD", label: "CD manufacturing", ...over });
    const cd = (id: number, over: Partial<EngineSale> = {}) => s(id, { category: "merch", format: "CD Compact Disc (CD)", netCents: 1200, ...over });

    it("takes the fixed amount per item, then splits the profit", () => {
      const [r] = computeLedger([cd(1, { quantity: 2 })], { ...ctx, deductions: [cdCost()] });
      expect(r.deductions).toEqual([expect.objectContaining({ label: "CD manufacturing", cents: 684 })]);
      expect(r.shares.reduce((a, x) => a + x.cents, 0)).toBe(1200 - 684);
    });

    it("only applies to matching formats", () => {
      const [vinyl, digital] = computeLedger(
        [cd(1, { format: "12in Vinyl LP Vinyl LP" }), s(2, { category: "album" })],
        { ...ctx, deductions: [cdCost({ itemCategory: null })] },
      );
      expect(vinyl.deductions).toEqual([]);
      expect(digital.deductions).toEqual([]);
    });

    it("matches any of several words", () => {
      const [r] = computeLedger([cd(1, { format: "Tape Cassette" })], { ...ctx, deductions: [cdCost({ formatMatch: "cassette, tape" })] });
      expect(r.deductions[0].cents).toBe(342);
    });

    it("never takes more than the sale, and a refund reverses it", () => {
      const [cheap, refund] = computeLedger([cd(1, { netCents: 300 }), cd(2, { netCents: -1200 })], { ...ctx, deductions: [cdCost()] });
      expect(cheap.deductions[0].cents).toBe(300);
      expect(cheap.shares.every((x) => x.cents === 0)).toBe(true);
      expect(refund.deductions[0].cents).toBe(-342);
    });

    it("can be paid to a person, added to their payout", () => {
      // Person 9 fronted the CD pressing and is not in the band.
      const [r] = computeLedger([cd(1)], { ...ctx, deductions: [cdCost({ destination: "person", personId: 9 })] });
      const by = Object.fromEntries(r.shares.map((x) => [x.personId, x.cents]));
      expect(by[9]).toBe(342);
      expect(r.shares.reduce((a, x) => a + x.cents, 0)).toBe(1200);
      const sum = summarize([r]).byCurrency.USD;
      expect(sum.byDestination.size).toBe(0); // not double-counted as a deduction
      expect(sum.byPerson.get(9)?.total).toBe(342);
    });

    it("charges each format of a release its own cost (CD $3.42, vinyl $8)", () => {
      const ded = [
        cdCost({ id: 71, label: "Triple Single CD", releaseId: 10, packageId: 501, formatMatch: null }),
        cdCost({ id: 72, label: "Triple Single vinyl", amountCents: 800, releaseId: 10, packageId: 502, formatMatch: null }),
      ];
      const [cdSale, vinylSale, otherRelease] = computeLedger(
        [
          cd(1, { releaseId: 10, packageId: 501 }),
          cd(2, { releaseId: 10, packageId: 502, format: "Vinyl LP", netCents: 2500 }),
          cd(3, { releaseId: 11, packageId: 601 }),
        ],
        { ...ctx, deductions: ded },
      );
      expect(cdSale.deductions.map((d) => [d.label, d.cents])).toEqual([["Triple Single CD", 342]]);
      expect(vinylSale.deductions.map((d) => [d.label, d.cents])).toEqual([["Triple Single vinyl", 800]]);
      expect(otherRelease.deductions).toEqual([]);
    });

    it("comes after the label cut when set on a band", () => {
      const ded = [deduction({ id: 1, kind: "percent", percentBps: 2000, label: "Label cut" }), cdCost({ bandId: 1 })];
      const [r] = computeLedger([cd(1)], { ...ctx, deductions: ded });
      expect(r.deductions.map((d) => [d.label, d.cents])).toEqual([
        ["Label cut", 240],
        ["CD manufacturing", 342],
      ]);
    });
  });

  describe("label releases and compilations", () => {
    // Band 9 is the label itself. Release 90 is a compilation on it with three tracks:
    // 901 by band 1 (on the label), 902 by an outside artist with contact person 50,
    // 903 by an outside artist with no contact yet.
    const comp = (contact903: number | null): EngineContext => ({
      ...ctx,
      deductions: [],
      labelBandIds: new Set([9]),
      releases: [{ id: 90, albumSplitMode: "average_tracks", trackIds: [901, 902, 903] }],
      tracks: new Map([
        [901, { bandId: 1, outside: false, contactPersonId: null }],
        [902, { bandId: null, outside: true, contactPersonId: 50 }],
        [903, { bandId: null, outside: true, contactPersonId: contact903 }],
      ]),
    });

    it("keeps a label release's money for the label when it has no split", () => {
      const [r] = computeLedger([s(1, { bandId: 9, releaseId: 91, netCents: 700 })], { ...ctx, deductions: [], labelBandIds: new Set([9]) });
      expect(r.problem).toBeNull();
      expect(r.ruleSource).toBe("label_keeps");
      expect(r.shares).toEqual([]);
      expect(r.deductions).toEqual([expect.objectContaining({ label: "Label’s share", destination: "label", cents: 700 })]);
      expect(summarize([r]).byCurrency.USD.byDestination.get("label")).toBe(700);
    });

    it("pays an outside artist's contact for their track", () => {
      const [r] = computeLedger([s(1, { bandId: 9, releaseId: 90, trackId: 902, category: "track", netCents: 100 })], comp(51));
      expect(r.ruleSource).toBe("outside_artist");
      expect(r.shares).toEqual([{ personId: 50, cents: 100, exact: 100 }]);
    });

    it("flags an outside artist's track until they have a contact", () => {
      const [r] = computeLedger([s(1, { bandId: 9, releaseId: 90, trackId: 903, category: "track" })], comp(null));
      expect(r.problem).toBe("no_rule");
    });

    it("shares a compilation's album sales across its tracks' artists", () => {
      const [r] = computeLedger([s(1, { bandId: 9, releaseId: 90, netCents: 900 })], comp(51));
      const by = Object.fromEntries(r.shares.map((x) => [x.personId, x.cents]));
      // a third each: track 901 → band 1's default (people 1,2,3), 902 → person 50, 903 → person 51
      expect(by[50]).toBe(300);
      expect(by[51]).toBe(300);
      expect(by[1] + by[2] + by[3]).toBe(300);
      expect(r.shares.reduce((a, x) => a + x.cents, 0)).toBe(900);
    });

    it("flags the whole album until every outside artist has a contact", () => {
      const [r] = computeLedger([s(1, { bandId: 9, releaseId: 90, netCents: 900 })], comp(null));
      expect(r.problem).toBe("no_rule");
      expect(r.unallocatedCents).toBe(900);
    });

    it("lets the label keep a dismissed outside artist's share", () => {
      const c = comp(null);
      c.tracks!.set(903, { bandId: null, outside: true, contactPersonId: null, labelKeeps: true });
      const [track, album] = computeLedger(
        [s(1, { bandId: 9, releaseId: 90, trackId: 903, category: "track", netCents: 100 }), s(2, { bandId: 9, releaseId: 90, netCents: 900 })],
        c,
      );
      expect(track.problem).toBeNull();
      expect(track.deductions).toEqual([expect.objectContaining({ label: "Label’s share", cents: 100 })]);
      expect(album.problem).toBeNull();
      expect(album.deductions).toEqual([expect.objectContaining({ label: "Label’s share", cents: 300 })]);
      expect(album.shares.reduce((a, x) => a + x.cents, 0)).toBe(600);
    });

    it("gives the label its own tracks' share on a label compilation", () => {
      const c = comp(51);
      c.releases = [{ id: 90, albumSplitMode: "average_tracks", trackIds: [901, 904] }];
      const [r] = computeLedger([s(1, { bandId: 9, releaseId: 90, netCents: 1000 })], c);
      expect(r.deductions).toEqual([expect.objectContaining({ label: "Label’s share", cents: 500 })]);
      expect(r.shares.reduce((a, x) => a + x.cents, 0)).toBe(500);
    });
  });

  describe("label-wide default", () => {
    // Band 3 has no default split of its own; members 5, 6, 7. Person 9 is a producer on everything.
    const label = (shares: SplitRule["shares"], effectiveFrom = "2000-01-01", id = 50) =>
      rule({ id, scope: "label_default", shares, effectiveFrom });
    const members = new Map([
      [1, [1, 2, 3]],
      [3, [5, 6, 7]],
    ]);

    it("splits evenly between current members when a band has no default", () => {
      const [r] = computeLedger([s(1, { bandId: 3, netCents: 900 })], { ...ctx, deductions: [], rules: [...ctx.rules, label([])], members });
      expect(r.ruleSource).toBe("label_default");
      expect(r.shares).toEqual([
        { personId: 5, cents: 300, exact: 300 },
        { personId: 6, cents: 300, exact: 300 },
        { personId: 7, cents: 300, exact: 300 },
      ]);
    });

    it("takes carve-outs first, and a carved-out member also gets their even share", () => {
      const [r] = computeLedger([s(1, { bandId: 3, netCents: 1000 })], {
        ...ctx,
        deductions: [],
        rules: [...ctx.rules, label([{ personId: 9, bps: 1000 }, { personId: 5, bps: 1000 }])],
        members,
      });
      const by = Object.fromEntries(r.shares.map((x) => [x.personId, x.cents]));
      // 20% carved out, 80% / 3 each ≈ 266.67
      expect(by[9]).toBe(100);
      expect(by[5]).toBe(100 + 267);
      expect(by[6] + by[7]).toBe(533);
      expect(r.shares.reduce((a, x) => a + x.cents, 0)).toBe(1000);
    });

    it("never overrides a band's own default split", () => {
      const [r] = computeLedger([s(1, { bandId: 1 })], { ...ctx, deductions: [], rules: [...ctx.rules, label([])], members });
      expect(r.ruleSource).toBe("band_default");
    });

    it("respects effective dates", () => {
      const rules = [...ctx.rules, label([], "2026-02-01")];
      const [before, after] = computeLedger(
        [s(1, { bandId: 3, date: "2026-01-15" }), s(2, { bandId: 3, date: "2026-02-15" })],
        { ...ctx, deductions: [], rules, members },
      );
      expect(before.problem).toBe("no_rule");
      expect(after.ruleSource).toBe("label_default");
    });

    it("flags the sale when the band has no members to share the rest", () => {
      const [r] = computeLedger([s(1, { bandId: 3 })], { ...ctx, deductions: [], rules: [...ctx.rules, label([])], members: new Map() });
      expect(r.problem).toBe("no_rule");
    });

    it("is used by 'average of tracks' for tracks without a split", () => {
      const rules = [...ctx.rules, label([])];
      const releases = [{ id: 30, albumSplitMode: "average_tracks" as const, trackIds: [301, 302] }];
      rules.push(rule({ id: 60, scope: "track", trackId: 301, shares: [{ personId: 5, bps: 10000 }] }));
      const [r] = computeLedger([s(1, { bandId: 3, releaseId: 30, netCents: 600 })], { ...ctx, deductions: [], rules, releases, members });
      const by = Object.fromEntries(r.shares.map((x) => [x.personId, x.cents]));
      // track 301 → person 5; track 302 → even thirds ⇒ 5 gets 1/2 + 1/6 = 2/3
      expect(by[5]).toBe(400);
      expect(by[6] + by[7]).toBe(200);
    });
  });

  it("combines a person's earnings across bands", () => {
    const results = computeLedger([s(1, { bandId: 1, netCents: 900 }), s(2, { bandId: 2, netCents: 1000 })], { ...ctx, deductions: [] });
    const sum = summarize(results).byCurrency.USD;
    const p3 = sum.byPerson.get(3)!;
    expect(p3.total).toBe(300 + 500);
    expect([...p3.byBand.entries()]).toEqual([
      [1, 300],
      [2, 500],
    ]);
    const people = [...sum.byPerson.values()].reduce((a, p) => a + p.total, 0);
    expect(people).toBe(1900);
  });
});

describe("format matching", () => {
  it("matches whole words, case-insensitively", () => {
    expect(formatMatches("CD", "Compact Disc (CD)")).toBe(true);
    expect(formatMatches("cd", "CD")).toBe(true);
    expect(formatMatches("CD", "CDR Bundle")).toBe(false);
    expect(formatMatches("vinyl, lp", "12in Vinyl LP")).toBe(true);
    expect(formatMatches("CD", "")).toBe(false);
  });
});

describe("paypal export", () => {
  it("builds paypal.me links", () => {
    expect(paypalMeLink("https://paypal.me/sam_d", 1234, "usd")).toBe("https://paypal.me/sam_d/12.34USD");
    expect(paypalMeLink("@sam", 5, "EUR")).toBe("https://paypal.me/sam/0.05EUR");
  });
  it("builds bulk CSV rows without a header, skipping unpayable lines", () => {
    const csv = paypalBulkCsv([
      { personName: "A", email: "a@x.com", paypalMe: null, currency: "USD", amountCents: 1050, note: "Payout, Jan", referenceId: "P1-1" },
      { personName: "B", email: null, paypalMe: "b", currency: "USD", amountCents: 500, note: "n", referenceId: "P1-2" },
      { personName: "C", email: "c@x.com", paypalMe: null, currency: "USD", amountCents: 0, note: "n", referenceId: "P1-3" },
    ]);
    expect(csv).toBe('a@x.com,10.50,USD,P1-1,"Payout, Jan",PayPal\r\n');
  });
});

describe("payment links", () => {
  it("tidies usernames pasted in any form", () => {
    expect(cleanVenmoHandle("@sam-drums")).toBe("sam-drums");
    expect(cleanVenmoHandle("https://venmo.com/u/sam-drums")).toBe("sam-drums");
    expect(cleanCashtag("$samdrums")).toBe("samdrums");
    expect(cleanCashtag("https://cash.app/$samdrums")).toBe("samdrums");
  });

  it("fills in the amount (and a note for Venmo)", () => {
    expect(venmoLink("@sam", 5120, "USD", "Flag Day payout")).toBe("https://venmo.com/?txn=pay&recipients=sam&amount=51.20&note=Flag+Day+payout");
    expect(cashAppLink("$sam", 5120, "USD")).toBe("https://cash.app/$sam/51.20");
    // Venmo is dollars only; Cash App does dollars and pounds.
    expect(venmoLink("sam", 5120, "EUR", "")).toBeNull();
    expect(cashAppLink("sam", 5120, "EUR")).toBeNull();
  });

  it("lists PayPal.me first, then Venmo, then Cash App", () => {
    const m = payMethods({ paypalMe: "sam", venmo: "sam", cashtag: "sam" }, 5120, "USD", "note");
    expect(m.map((x) => x.kind)).toEqual(["paypal_me", "venmo", "cash_app"]);
    expect(m[0].url).toBe(paypalMeLink("sam", 5120, "USD"));
    expect(payMethods({ paypalMe: null, venmo: null, cashtag: null }, 5120, "USD", "")).toEqual([]);
  });
});
