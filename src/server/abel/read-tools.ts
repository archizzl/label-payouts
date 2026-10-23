import "server-only";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { plural } from "@/lib/plural";
import { AREAS, bandScope, can, describePermissions, inBandScope } from "@/lib/permissions";
import { type Context, ownBooksOf } from "../context";
import { addTotals, earningsIn, type Totals } from "../earnings";
import { accountExpenses } from "../expenses";
import { labelFunds, nameMaps, ownBand, rulesWhere } from "../data";
import { labelIncome } from "../label-income";
import { loadOpenOrders } from "../merch-orders";
import { owedByBand, owedTotal } from "../owed";
import { periodView } from "../period-view";
import { salesReport } from "../sales-report";
import { type SalesBooks, summarizeSales } from "../sales-browse";
import { abelTool } from "./tool";

/*
 * What Abel can look up. Each mirrors its page: the same books, the same band limits. Results are
 * kept small and readable (money already formatted), and leave out buyers' details.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

const money = (totals: Totals) =>
  [...totals]
    .filter(([, c]) => c !== 0)
    .map(([cur, c]) => formatCents(c, cur))
    .join(", ") || formatCents(0);

/** Bands they may see in this section (all of the account's, or their own). */
async function bandsIn(ctx: Context, area: Parameters<typeof bandScope>[1]) {
  const scope = bandScope(ctx.access, area);
  const rows = await db
    .select({ id: schema.bands.id, name: schema.bands.name, isLabel: schema.bands.isLabel })
    .from(schema.bands)
    .where(eq(schema.bands.orgId, ctx.orgId))
    .orderBy(asc(schema.bands.name));
  return rows.filter((b) => inBandScope(scope, [b.id]));
}

const myAccess = abelTool({
  name: "my_access",
  description: "What the person you're talking to can see and change in this group, and who they are here.",
  params: z.object({}),
  needs: "anyone",
  run: async (ctx) => ({
    name: ctx.user.name,
    group: ctx.org.name,
    groupKind: ctx.org.kind,
    role: ctx.role,
    memberType: ctx.memberType,
    payee: ctx.person?.name ?? null,
    access: ctx.access.admin ? "Everything (admin)" : describePermissions(ctx.access.permissions, ctx.access.bandAreas),
    viewingAs: ctx.viewingAs ? `${ctx.viewingAs.realUser.name} is viewing as ${ctx.viewingAs.name}: nothing can be changed.` : null,
  }),
});

const myEarnings = abelTool({
  name: "my_earnings",
  description:
    "The person's own earnings in this group: what they're owed from finalized payouts, what they've received, what they've earned that's not in a payout yet, and their payouts.",
  params: z.object({}),
  needs: "anyone",
  available: (ctx) => !!ctx.person || !!ctx.managedBy,
  run: async (ctx) => {
    const none = { lines: [], owed: new Map(), received: new Map(), upcoming: [] } as Awaited<ReturnType<typeof earningsIn>>;
    // A band account the label made: the label's books (its band's part) and its own, together, as on /me.
    const m = ctx.managedBy;
    const own = m ? await ownBooksOf(ctx) : null;
    const [a, b] = await Promise.all([
      ctx.person ? earningsIn(m ? m.labelOrgId : ctx.orgId, ctx.person.id, m ? m.bandId : null) : none,
      own?.person ? earningsIn(own.orgId, own.person.id) : none,
    ]);
    const upcoming = (e: typeof a) => new Map(e.upcoming.map((u) => [u.cur, u.line.total]));
    const payouts = [...a.lines.map((l) => ({ ...l, through: m?.labelName ?? null })), ...b.lines.map((l) => ({ ...l, through: null }))]
      .sort((x, y) => y.period.endDate.localeCompare(x.period.endDate))
      .slice(0, 24)
      .map((l) => ({ payout: l.period.name, through: l.through, amount: formatCents(l.cents, l.payout.currency), status: l.payout.status, paidAt: l.payout.paidAt }));
    if (!ctx.person && !own?.person) return { error: `Your account isn't linked to anyone who gets paid in ${ctx.org.name} yet.` };
    return {
      owedFromFinalizedPayouts: money(addTotals(a.owed, b.owed)),
      received: money(addTotals(a.received, b.received)),
      notInAPayoutYet: money(addTotals(upcoming(a), upcoming(b))),
      payouts,
    };
  },
});

const owed = abelTool({
  name: "owed_by_band",
  description: "What the label still owes, band by band: in finalized payouts not paid yet, sales not in a payout yet, receipts to pay back, and money raised to send on.",
  params: z.object({}),
  needs: { area: "payouts" },
  available: (ctx) => !ctx.lens,
  run: async (ctx) => {
    const rows = await owedByBand(ctx.orgId);
    return rows
      .filter((r) => owedTotal(r) !== 0)
      .map((r) => ({
        name: r.name,
        bandId: r.bandId,
        total: formatCents(owedTotal(r), r.currency),
        inFinalizedPayouts: formatCents(r.finalized, r.currency),
        notInAPayoutYet: formatCents(r.unpaid, r.currency),
        receipts: formatCents(r.receipts, r.currency),
        raised: formatCents(r.raised, r.currency),
        people: r.people.slice(0, 10).map((p) => `${p.name}: ${formatCents(p.cents, r.currency)}`),
      }));
  },
});

const listPayouts = abelTool({
  name: "list_payouts",
  description: "Finalized payouts, newest first: name, band (or the whole group), dates, whether they're paid, and the total.",
  params: z.object({ limit: z.number().int().min(1).max(50).optional() }),
  needs: { area: "payouts" },
  run: async (ctx, { limit }) => {
    const [periods, payouts, names] = await Promise.all([
      db.select().from(schema.periods).where(eq(schema.periods.orgId, ctx.orgId)).orderBy(desc(schema.periods.startDate)).limit(limit ?? 12),
      db.select().from(schema.payouts).where(eq(schema.payouts.orgId, ctx.orgId)),
      nameMaps(ctx.orgId),
    ]);
    return periods.map((p) => {
      const lines = payouts.filter((l) => l.periodId === p.id);
      const total: Totals = new Map();
      const unpaid: Totals = new Map();
      for (const l of lines) {
        total.set(l.currency, (total.get(l.currency) ?? 0) + l.amountCents);
        if (l.status === "pending") unpaid.set(l.currency, (unpaid.get(l.currency) ?? 0) + l.amountCents);
      }
      return {
        id: p.id,
        name: p.name,
        band: p.bandId ? (names.band.get(p.bandId) ?? null) : "Whole group",
        from: p.startDate,
        to: p.endDate,
        status: p.status === "paid" ? "paid" : "finalized, not all paid",
        total: money(total),
        stillToPay: money(unpaid),
        link: `/periods/${p.id}`,
      };
    });
  },
});

const payoutDetail = abelTool({
  name: "payout_detail",
  description: "One finalized payout: what each person gets and whether it's paid, and each band's sales and split.",
  params: z.object({ payoutId: z.number().int() }),
  needs: { area: "payouts" },
  run: async (ctx, { payoutId }) => {
    const view = await periodView(ctx.orgId, payoutId);
    if (!view) return { error: "No such payout." };
    return {
      name: view.period.name,
      from: view.period.startDate,
      to: view.period.endDate,
      people: view.lines.map((l) => ({ payoutLineId: l.payoutId, name: l.name, amount: formatCents(l.amountCents, l.currency), status: l.status, paidAt: l.paidAt })),
      bands: view.bands.map((b) => ({
        band: b.bandId ? (view.names.band.get(b.bandId) ?? `Band #${b.bandId}`) : "Not matched to a band",
        sales: b.saleCount,
        net: formatCents(b.netCents, b.currency),
        label: formatCents(b.labelCents, b.currency),
        bandFund: formatCents(b.bandFundCents, b.currency),
        costs: formatCents(b.expenseCents, b.currency),
        people: formatCents(b.peopleCents, b.currency),
      })),
      link: `/periods/${payoutId}`,
    };
  },
});

/**
 * Sales' books as the Sales page has them (ctx: the sales section's, so a band account the label
 * made is in its own books): such an account sees its own and the label's for its band.
 */
function salesBooks(ctx: Context): { books: SalesBooks; onlyBands?: number[] } {
  const m = ctx.managedBy;
  if (m) return { books: { own: ctx.orgId, label: { orgId: m.labelOrgId, bandId: m.bandId } } };
  return { books: ctx.orgId, onlyBands: bandScope(ctx.access, "sales") ?? undefined };
}

const salesSummary = abelTool({
  name: "sales_summary",
  description:
    "Sales totals for a date range, optionally for one band or matching some text (an item, artist or package): count, units, net, refunds, and the top items, bands, countries, sources and months.",
  params: z.object({
    from: date.optional(),
    to: date.optional(),
    bandId: z.number().int().optional(),
    search: z.string().max(100).optional(),
  }),
  needs: { area: "sales" },
  run: async (ctx, { from, to, bandId, search }) => {
    const { books, onlyBands } = salesBooks(ctx);
    if (bandId && onlyBands && !onlyBands.includes(bandId)) return { error: "That isn't one of your bands." };
    const s = await summarizeSales(books, { from, to, band: ctx.managedBy ? undefined : bandId, q: search, onlyBands, sort: "date", dir: "desc", page: 1, per: 10 });
    // The breakdowns are in the main currency (the one with the most sales).
    // (Spellings that differ only in capitals or spacing, like "Flags of the World" and "Flags Of The World", are one item.)
    const top = (rows: { key: string; net: number; units: number }[]) => {
      const merged = new Map<string, { key: string; net: number; units: number; best: number }>();
      for (const r of rows) {
        const k = r.key.toLowerCase().replace(/\s+/g, " ").trim();
        const m = merged.get(k);
        if (!m) merged.set(k, { ...r, best: r.units });
        else {
          // Named by the spelling with the most units.
          if (r.units > m.best) Object.assign(m, { key: r.key, best: r.units });
          m.net += r.net;
          m.units += r.units;
        }
      }
      return [...merged.values()].sort((a, b) => b.net - a.net).map((r) => `${r.key}: ${formatCents(r.net, s.main)} (${plural(r.units, "unit")})`);
    };
    return {
      totals: s.totals.map((t) => ({
        currency: t.currency,
        sales: t.sales,
        units: t.units,
        net: formatCents(t.net, t.currency),
        refunds: t.refunds,
        refunded: formatCents(t.refundCents, t.currency),
        first: t.first,
        last: t.last,
      })),
      breakdownCurrency: s.main,
      byMonth: s.byMonth.slice(-12).map((r) => `${r.month}: ${formatCents(r.net, s.main)}`),
      byItem: top(s.byItem),
      byBand: top(s.byBand),
      byCountry: top(s.byCountry),
      bySource: top(s.bySource),
      byType: top(s.byType),
    };
  },
});

const salesBreakdown = abelTool({
  name: "sales_report",
  description:
    "Where the money from sales went for a band or release over a date range: gross, Bandcamp's share, fees, tax, shipping, net, and how net was split (label, band fund, costs, people), with the best-selling items and formats.",
  params: z.object({ bandId: z.number().int().optional(), releaseId: z.number().int().optional(), from: date.optional(), to: date.optional() }),
  needs: { area: "sales" },
  run: async (ctx, scope) => {
    const limit = bandScope(ctx.access, "sales");
    const m = ctx.managedBy;
    if (!m && limit && !scope.bandId) return { error: "Choose one of your bands." };
    if (!m && limit && scope.bandId && !limit.includes(scope.bandId)) return { error: "That isn't one of your bands." };
    const band = m ? await ownBand(ctx.orgId) : null;
    const books = m ? [...(band ? [{ orgId: ctx.orgId, bandId: band.id }] : []), { orgId: m.labelOrgId, bandId: m.bandId }] : ctx.orgId;
    const r = await salesReport(books, m ? { from: scope.from, to: scope.to } : scope);
    if (!r.currency) return { sales: 0 };
    const f = (c: number) => formatCents(c, r.currency!);
    return {
      currency: r.currency,
      otherCurrencies: r.otherCurrencies.map((o) => formatCents(o.net, o.currency)),
      sales: r.saleCount,
      units: r.units,
      gross: f(r.gross),
      bandcampShare: f(r.bandcampShare),
      paymentFees: f(r.processorFee),
      tax: f(r.marketplaceTax),
      shipping: f(r.shipping),
      net: f(r.net),
      toLabel: f(r.label),
      toBandFund: f(r.bandFund),
      toCosts: f(r.costs),
      toPeople: f(r.toPeople),
      notSplitYet: f(r.unallocated),
      items: r.items.slice(0, 10).map((i) => `${i.title}: ${f(i.net)} net, ${i.units} units`),
      byFormat: r.byFormat.slice(0, 8).map((x) => `${x.key}: ${f(x.net)}`),
    };
  },
});

const funds = abelTool({
  name: "label_funds",
  description:
    "The label's own money, as the Funds page has it: what came in (its cut and other withholdings, its own share of label releases, and the shipping fans paid, which stays with the label for postage), by source and by band; what it sent on and spent; and what's left in its account. With the money it sent on (and their ids).",
  params: z.object({}),
  needs: { area: "funds" },
  available: (ctx) => !ctx.lens,
  run: async (ctx) => {
    // The Funds page's own numbers (labelIncome), so Abel and the page always agree.
    const [inc, f] = await Promise.all([labelIncome(ctx.orgId), labelFunds(ctx.orgId)]);
    const ranked = (m: Map<string, Totals>) =>
      [...m]
        .map(([name, t]) => ({ name, total: t }))
        .sort((a, b) => Math.abs([...b.total.values()][0] ?? 0) - Math.abs([...a.total.values()][0] ?? 0))
        .map(({ name, total }) => `${name}: ${money(total)}`);
    return {
      leftInAccount: money(inc.balance),
      cameIn: money(inc.income),
      sentOn: money(inc.sent),
      spent: money(inc.spent),
      cameInBySource: ranked(inc.bySource),
      cameInByBand: ranked(inc.byBand),
      ...(inc.holderName && [...inc.holderShare.values()].some((c) => c) ? { accountHolderOwnShare: `${inc.holderName}: ${money(inc.holderShare)} of their own pay sits in the same account` } : {}),
      sendOuts: f.transfers.slice(0, 30).map((t) => ({ id: t.id, date: t.date, amount: formatCents(t.amountCents, t.currency), to: t.recipient, source: t.source, note: t.note })),
      link: "/funds",
    };
  },
});

const listBands = abelTool({
  name: "list_bands",
  description: "The group's bands (with their ids) and, with withMembers, their members (with membership and person ids).",
  params: z.object({ withMembers: z.boolean().optional() }),
  needs: { area: "roster" },
  run: async (ctx, { withMembers }) => {
    const bands = (await bandsIn(ctx, "roster")).filter((b) => !b.isLabel);
    if (!withMembers) return bands.map((b) => ({ id: b.id, name: b.name }));
    const members = await db
      .select({
        membershipId: schema.bandMemberships.id,
        personId: schema.people.id,
        bandId: schema.bandMemberships.bandId,
        name: schema.people.name,
        roles: schema.bandMemberships.roles,
        active: schema.bandMemberships.active,
      })
      .from(schema.bandMemberships)
      .innerJoin(schema.people, eq(schema.people.id, schema.bandMemberships.personId))
      .where(eq(schema.bandMemberships.orgId, ctx.orgId));
    return bands.map((b) => ({
      id: b.id,
      name: b.name,
      members: members
        .filter((m) => m.bandId === b.id)
        .map((m) => ({ membershipId: m.membershipId, personId: m.personId, name: m.name, roles: m.roles, former: !m.active })),
    }));
  },
});

const people = abelTool({
  name: "list_people",
  description: "People in the group who get paid (payees), with their ids, for splits.",
  params: z.object({ bandId: z.number().int().optional() }),
  needs: { area: "roster" },
  run: async (ctx, { bandId }) => {
    const scope = bandScope(ctx.access, "roster");
    if (bandId && !inBandScope(scope, [bandId])) return { error: "That isn't one of your bands." };
    if (!bandId && scope) return { error: "Choose one of your bands." };
    if (bandId) {
      const rows = await db
        .select({ id: schema.people.id, name: schema.people.name, active: schema.bandMemberships.active })
        .from(schema.bandMemberships)
        .innerJoin(schema.people, eq(schema.people.id, schema.bandMemberships.personId))
        .where(and(eq(schema.bandMemberships.orgId, ctx.orgId), eq(schema.bandMemberships.bandId, bandId)));
      return rows;
    }
    return db.select({ id: schema.people.id, name: schema.people.name }).from(schema.people).where(eq(schema.people.orgId, ctx.orgId)).orderBy(asc(schema.people.name));
  },
});

const catalog = abelTool({
  name: "catalog",
  description: "Releases and merch in the catalog (with ids), optionally for one band, newest first.",
  params: z.object({ bandId: z.number().int().optional(), search: z.string().max(100).optional() }),
  needs: { area: "catalog" },
  run: async (ctx, { bandId, search }) => {
    const scope = bandScope(ctx.access, "catalog");
    const [rows, names] = await Promise.all([
      db.select().from(schema.releases).where(eq(schema.releases.orgId, ctx.orgId)).orderBy(desc(schema.releases.releaseDate), asc(schema.releases.title)),
      nameMaps(ctx.orgId),
    ]);
    const q = search?.toLowerCase();
    return rows
      .filter((r) => inBandScope(scope, [r.bandId]) && (!bandId || r.bandId === bandId) && (!q || r.title.toLowerCase().includes(q)))
      .slice(0, 40)
      .map((r) => ({
        id: r.id,
        title: r.title,
        band: names.band.get(r.bandId) ?? null,
        kind: r.kind,
        released: r.releaseDate,
        formats: r.packages.map((p) => p.title),
      }));
  },
});

const orders = abelTool({
  name: "open_orders",
  description: "Open merch orders waiting to ship, oldest first: order id, date, days waiting, buyer's first name, country, items, and whether it's a pre-order.",
  params: z.object({ bandId: z.number().int().optional() }),
  needs: { area: "orders" },
  run: async (ctx, { bandId }) => {
    const scope = bandScope(ctx.access, "orders");
    const open = await loadOpenOrders(ctx.orgId);
    if (open.status === "no-api") return { error: "Bandcamp's API isn't set up for this group (Settings)." };
    if (open.status === "error") return { error: open.message };
    const list = open.orders.filter((o) => inBandScope(scope, o.bandIds) && (!bandId || o.bandIds.includes(bandId)));
    return {
      count: list.length,
      orders: list.slice(0, 30).map((o) => ({
        orderId: o.paymentId,
        date: o.date,
        daysWaiting: o.daysWaiting,
        buyer: o.buyer.name.split(" ")[0] || null,
        country: o.country,
        items: o.lines.map((l) => `${l.quantity} × ${l.name}${l.option ? ` (${l.option})` : ""}`),
        preorderUntil: o.preorderUntil,
        paymentFailed: o.failed,
        canMarkShipped: can(ctx.access, "orders", "edit") && (scope === null || o.lines.every((l) => l.bandId !== null && scope.includes(l.bandId))),
      })),
    };
  },
});

const inventory = abelTool({
  name: "inventory",
  description: "Merch, formats and supplies on hand (with ids), optionally for one band or matching a name.",
  params: z.object({ bandId: z.number().int().optional(), search: z.string().max(100).optional() }),
  needs: { area: "inventory" },
  run: async (ctx, { bandId, search }) => {
    const scope = bandScope(ctx.access, "inventory");
    const [items, names] = await Promise.all([
      db
        .select()
        .from(schema.inventoryItems)
        .where(and(eq(schema.inventoryItems.orgId, ctx.orgId), eq(schema.inventoryItems.archived, false)))
        .orderBy(asc(schema.inventoryItems.name), asc(schema.inventoryItems.option)),
      nameMaps(ctx.orgId),
    ]);
    const q = search?.toLowerCase();
    return items
      .filter((i) => (!scope || (i.bandId !== null && scope.includes(i.bandId))) && (!bandId || i.bandId === bandId) && (!q || i.name.toLowerCase().includes(q)))
      .slice(0, 60)
      .map((i) => ({ id: i.id, name: i.name, option: i.option, band: i.bandId ? (names.band.get(i.bandId) ?? null) : null, onHand: i.onHand }));
  },
});

const receipts = abelTool({
  name: "receipts",
  description:
    "Receipts (expenses), newest first: date, what for, amount, who paid, status (pending: waiting for review, approved, rejected), whether it's been paid back, and its files.",
  params: z.object({ bandId: z.number().int().optional(), status: z.enum(["pending", "approved", "rejected"]).optional() }),
  needs: { area: "receipts" },
  available: (ctx) => !ctx.lens,
  run: async (ctx, { bandId, status }) => {
    const scope = bandScope(ctx.access, "receipts");
    if (bandId && !inBandScope(scope, [bandId])) return { error: "That isn't one of your bands." };
    const [rows, names, files] = await Promise.all([
      accountExpenses(ctx.orgId, bandId ? { bandId } : undefined),
      nameMaps(ctx.orgId),
      db.select({ id: schema.expenseFiles.id, expenseId: schema.expenseFiles.expenseId, name: schema.expenseFiles.filename }).from(schema.expenseFiles).where(eq(schema.expenseFiles.orgId, ctx.orgId)),
    ]);
    return rows
      .filter((e) => (!scope || (e.bandId !== null && scope.includes(e.bandId))) && (!status || e.status === status))
      .slice(0, 30)
      .map((e) => ({
        id: e.id,
        date: e.date,
        description: e.description,
        amount: formatCents(e.amountCents, e.currency),
        band: e.bandId ? (names.band.get(e.bandId) ?? null) : null,
        paidBy: e.paidBy === "person" ? (e.paidByPersonId ? (names.person.get(e.paidByPersonId) ?? "someone") : "someone") : "the label",
        status: e.status,
        paidBack: e.reimbursedAt,
        recoupedFromSales: e.recoup,
        files: files.filter((f) => f.expenseId === e.id).map((f) => ({ id: f.id, name: f.name })),
      }));
  },
});

const splits = abelTool({
  name: "splits",
  description: "How a band's money is split: its default split and any for item types, releases or tracks, with each person's share and when it starts.",
  params: z.object({ bandId: z.number().int() }),
  needs: { area: "rules" },
  run: async (ctx, { bandId }) => {
    const [rules, names] = await Promise.all([
      rulesWhere(ctx.orgId, or(eq(schema.splitRules.bandId, bandId), eq(schema.splitRules.scope, "label_default"))!),
      nameMaps(ctx.orgId),
    ]);
    return rules.map((r) => ({
      id: r.id,
      for:
        r.scope === "label_default"
          ? "Label default"
          : r.scope === "band_default"
            ? "Band default"
            : r.scope === "band_item_type"
              ? `All ${r.itemCategory}`
              : r.scope === "release"
                ? `Release: ${names.release.get(r.releaseId!) ?? r.releaseId}`
                : `Track: ${names.track.get(r.trackId!) ?? r.trackId}`,
      from: r.effectiveFrom,
      shares: r.shares.map((s) => `${names.person.get(s.personId) ?? `#${s.personId}`}: ${(s.bps / 100).toFixed(2)}%`),
    }));
  },
});

/** Where things are in the app, so Abel can point to the page rather than explain it. */
const PAGES = [
  { path: "/me", what: "My earnings: your own payouts, what's owed to you and what you've earned since the last payout." },
  { path: "/", what: "Dashboard: who's owed what, recent sales, charts.", area: "dashboard" },
  { path: "/sales", what: "Sales: every sale, filterable, with totals.", area: "sales" },
  { path: "/sales/add", what: "Add a sale by hand (a show, merch sold in person)." },
  { path: "/sales/import", what: "Import a Bandcamp sales export.", area: "sales" },
  { path: "/orders", what: "Open merch orders, and marking them shipped.", area: "orders" },
  { path: "/inventory", what: "Stock on hand.", area: "inventory" },
  { path: "/periods", what: "Payouts: making a payout and marking people paid.", area: "payouts" },
  { path: "/funds", what: "Label funds: what the label holds and has sent on.", area: "funds" },
  { path: "/rules", what: "Rules: splits and deductions.", area: "rules" },
  { path: "/receipts", what: "Receipts: sending one in, approving and paying back.", area: "receipts" },
  { path: "/catalog", what: "Catalog: releases, tracks and merch.", area: "catalog" },
  { path: "/directory", what: "Directory: bands, their people, and who can sign in.", area: "roster" },
  { path: "/settings", what: "Settings: the group's Bandcamp connection, member types, who can sign in.", admin: true },
  { path: "/account", what: "Account: your name, email, password and photo." },
] as const satisfies { path: string; what: string; area?: (typeof AREAS)[number]["key"]; admin?: boolean }[];

/** The pages this person can open (also in Abel's instructions, so he links to real ones). */
export const pagesFor = (ctx: Context) =>
  PAGES.filter((p) => ("admin" in p ? ctx.isAdmin : "area" in p ? can(ctx.access, p.area) || ctx.lens : true)).map((p) => ({ link: p.path, what: p.what }));

const whereIs = abelTool({
  name: "where_is",
  description: "The app's pages this person can open, with their links. Use it to point people to the right page.",
  params: z.object({}),
  needs: "anyone",
  run: async (ctx) => pagesFor(ctx),
});

export const READ_TOOLS = [myAccess, myEarnings, whereIs, owed, listPayouts, payoutDetail, salesSummary, salesBreakdown, funds, listBands, people, catalog, orders, inventory, receipts, splits];
