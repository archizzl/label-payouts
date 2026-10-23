import "server-only";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { nameScore } from "@/lib/name-match";
import { bandScope, can, inBandScope } from "@/lib/permissions";
import type { Context } from "../context";
import { nameMaps, rulesWhere } from "../data";
import { earningsIn } from "../earnings";
import { projectsEnabled } from "../features";
import { salesReport } from "../sales-report";
import { abelTool, isAccountAdmin } from "./tool";

/*
 * Finding things by name, whatever they are, and the whole story of a release or a person. Someone
 * says "the Young Jethros" without saying it's an album: find looks in every kind of thing they can
 * see (forgiving about "the", spacing and typos), so Abel doesn't guess the kind and look in the
 * wrong place.
 */

type Hit = { type: string; id: number; name: string; detail?: string; score: number };

const find = abelTool({
  name: "find",
  description:
    "Find anything by name: bands, releases (albums, singles, merch), tracks, people, deductions, inventory items and projects. Use it whenever someone names something and you don't already have its id, before deciding what kind of thing it is. Forgiving about case, \"the\", spacing and small typos.",
  params: z.object({ name: z.string().min(1).max(200) }),
  needs: "anyone",
  run: async (ctx, { name }) => {
    const hits: Hit[] = [];
    const add = (type: string, id: number, label: string, detail?: string, also: string[] = []) => {
      const score = Math.max(nameScore(name, label), ...also.map((a) => nameScore(name, a) - 5));
      if (score > 0) hits.push({ type, id, name: label, ...(detail ? { detail } : {}), score });
    };
    const sees = (area: Parameters<typeof can>[1]) => ctx.access.admin || can(ctx.access, area);
    const names = await nameMaps(ctx.orgId);

    if (sees("roster") || sees("catalog") || sees("sales")) {
      const scope = bandScope(ctx.access, sees("roster") ? "roster" : sees("catalog") ? "catalog" : "sales");
      const bands = await db.select().from(schema.bands).where(eq(schema.bands.orgId, ctx.orgId));
      for (const b of bands) if (!b.isLabel && inBandScope(scope, [b.id])) add("band", b.id, b.name, undefined, b.aliases);
    }
    if (sees("catalog")) {
      const scope = bandScope(ctx.access, "catalog");
      const [releases, tracks] = await Promise.all([
        db.select().from(schema.releases).where(eq(schema.releases.orgId, ctx.orgId)),
        db.select().from(schema.tracks).where(eq(schema.tracks.orgId, ctx.orgId)),
      ]);
      const releaseBand = new Map(releases.map((r) => [r.id, r.bandId]));
      for (const r of releases) {
        if (!inBandScope(scope, [r.bandId])) continue;
        add("release", r.id, r.title, `${r.kind} by ${names.band.get(r.bandId) ?? "?"}`);
      }
      for (const t of tracks) {
        if (!inBandScope(scope, [t.bandId ?? releaseBand.get(t.releaseId) ?? null])) continue;
        add("track", t.id, t.title, `on ${names.release.get(t.releaseId) ?? "?"}`);
      }
    }
    if (sees("roster")) {
      const scope = bandScope(ctx.access, "roster");
      const people = await db.select({ id: schema.people.id, name: schema.people.name }).from(schema.people).where(eq(schema.people.orgId, ctx.orgId));
      const inBands = scope
        ? new Set(
            (
              await db
                .select({ personId: schema.bandMemberships.personId })
                .from(schema.bandMemberships)
                .where(and(eq(schema.bandMemberships.orgId, ctx.orgId), inArray(schema.bandMemberships.bandId, scope.length ? scope : [-1])))
            ).map((m) => m.personId),
          )
        : null;
      for (const p of people) if (!inBands || inBands.has(p.id)) add("person", p.id, p.name);
    } else if (ctx.person) add("person", ctx.person.id, ctx.person.name, "you");
    if (sees("rules")) {
      const deductions = await db.select().from(schema.deductions).where(eq(schema.deductions.orgId, ctx.orgId));
      for (const d of deductions) add("deduction", d.id, d.label, d.bandId ? `for ${names.band.get(d.bandId) ?? "?"}` : "for every band");
    }
    if (sees("inventory")) {
      const scope = bandScope(ctx.access, "inventory");
      const items = await db
        .select()
        .from(schema.inventoryItems)
        .where(and(eq(schema.inventoryItems.orgId, ctx.orgId), eq(schema.inventoryItems.archived, false)));
      for (const i of items) if (!scope || (i.bandId !== null && scope.includes(i.bandId))) add("inventory item", i.id, i.option ? `${i.name} (${i.option})` : i.name);
    }
    if (isAccountAdmin(ctx) && (await projectsEnabled())) {
      const projects = await db.select().from(schema.projects).where(eq(schema.projects.orgId, ctx.orgId));
      for (const p of projects) add("project", p.id, p.name);
    }
    hits.sort((a, b) => b.score - a.score);
    const best = hits[0]?.score ?? 0;
    // The close ones: an exact match hides the merely similar.
    const shown = hits.filter((h) => h.score >= Math.min(best, 70) || h.score >= best - 15).slice(0, 12);
    if (!shown.length) return { found: [], note: `Nothing named like "${name}" that you can see.` };
    return { found: shown.map(({ score, ...h }) => ({ ...h, match: score >= 95 ? "exact" : score >= 65 ? "close" : "partial" })) };
  },
});

const releaseDetail = abelTool({
  name: "release_detail",
  description:
    "Everything about one release (album, single or merch): its band, date and Bandcamp address, its tracks (with ids), its formats (with package ids, for item costs and inventory), the deductions and splits that apply to it, and what it has sold.",
  params: z.object({ releaseId: z.number().int() }),
  needs: { area: "catalog" },
  run: async (ctx, { releaseId }) => {
    const [release] = await db.select().from(schema.releases).where(and(eq(schema.releases.orgId, ctx.orgId), eq(schema.releases.id, releaseId)));
    if (!release || !inBandScope(bandScope(ctx.access, "catalog"), [release.bandId])) {
      return { error: "No such release that you can see. (A band's id isn't a release's: find gives each thing's type and id.)" };
    }
    const names = await nameMaps(ctx.orgId);
    const tracks = await db.select().from(schema.tracks).where(eq(schema.tracks.releaseId, release.id)).orderBy(asc(schema.tracks.position));
    const out: Record<string, unknown> = {
      id: release.id,
      title: release.title,
      band: names.band.get(release.bandId) ?? null,
      bandId: release.bandId,
      kind: release.kind,
      released: release.releaseDate,
      catalogNumber: release.catalogNumber,
      bandcamp: release.url,
      albumSplitMode: release.albumSplitMode,
      tracks: tracks.map((t) => ({ id: t.id, position: t.position, title: t.title, ...(t.bandId && t.bandId !== release.bandId ? { band: names.band.get(t.bandId) } : {}) })),
      formats: release.packages.map((p) => ({ packageId: p.bandcampId, title: p.title, type: p.typeName, price: p.price !== null ? `${p.price} ${p.currency ?? ""}`.trim() : null })),
      link: `/catalog/${release.id}`,
    };
    if (can(ctx.access, "rules")) {
      const [deductions, splits] = await Promise.all([
        db
          .select()
          .from(schema.deductions)
          .where(
            and(
              eq(schema.deductions.orgId, ctx.orgId),
              or(eq(schema.deductions.releaseId, release.id), and(eq(schema.deductions.bandId, release.bandId), isNull(schema.deductions.releaseId)), isNull(schema.deductions.bandId)),
            ),
          ),
        rulesWhere(ctx.orgId, or(eq(schema.splitRules.releaseId, release.id), and(eq(schema.splitRules.bandId, release.bandId), isNull(schema.splitRules.releaseId)))!),
      ]);
      out.deductions = deductions.map((d) => ({
        id: d.id,
        label: d.label,
        appliesTo: d.releaseId ? "this release" : d.bandId ? "the whole band" : "every band",
        ...(d.kind === "percent" ? { percent: (d.percentBps ?? 0) / 100 } : d.amountCents !== null ? { amount: formatCents(d.amountCents, d.currency ?? "USD"), kind: d.kind } : { kind: d.kind }),
        goesTo: d.destination === "person" ? (names.person.get(d.personId ?? -1) ?? "someone") : d.destination,
      }));
      out.splits = splits.map((r) => ({
        id: r.id,
        for: r.releaseId ? "this release" : r.scope === "band_item_type" ? `the band's ${r.itemCategory}` : "the band's default",
        from: r.effectiveFrom,
        shares: r.shares.map((s) => `${names.person.get(s.personId) ?? `#${s.personId}`}: ${(s.bps / 100).toFixed(2)}%`),
      }));
    }
    if (can(ctx.access, "sales") && inBandScope(bandScope(ctx.access, "sales"), [release.bandId])) {
      const r = await salesReport(ctx.orgId, { releaseId: release.id });
      out.sold = r.currency
        ? { sales: r.saleCount, units: r.units, gross: formatCents(r.gross, r.currency), net: formatCents(r.net, r.currency), toPeople: formatCents(r.toPeople, r.currency), toLabel: formatCents(r.label, r.currency) }
        : { sales: 0 };
    }
    return out;
  },
});

const personDetail = abelTool({
  name: "person_detail",
  description: "Everything about one person who gets paid: their email and how they're paid (PayPal.me, Venmo, Cash App), their bands, whether they can sign in, and what they're owed and have been paid.",
  params: z.object({ personId: z.number().int() }),
  needs: "anyone",
  run: async (ctx: Context, { personId }) => {
    const self = ctx.person?.id === personId;
    if (!self && !can(ctx.access, "roster")) return { error: "You can only see your own details." };
    const [p] = await db.select().from(schema.people).where(and(eq(schema.people.orgId, ctx.orgId), eq(schema.people.id, personId)));
    if (!p) return { error: "No such person in this group." };
    const memberships = await db
      .select({ bandId: schema.bandMemberships.bandId, roles: schema.bandMemberships.roles, active: schema.bandMemberships.active })
      .from(schema.bandMemberships)
      .where(eq(schema.bandMemberships.personId, p.id));
    const scope = bandScope(ctx.access, "roster");
    if (!self && scope && !memberships.some((m) => scope.includes(m.bandId))) return { error: "That person isn't in one of your bands." };
    const names = await nameMaps(ctx.orgId);
    const out: Record<string, unknown> = {
      id: p.id,
      name: p.name,
      email: p.email,
      paypalMe: p.paypalMe,
      venmo: p.venmo,
      cashApp: p.cashtag,
      canSignIn: !!p.userId,
      holdsLabelAccount: p.holdsLabelAccount,
      bands: memberships.map((m) => ({ band: names.band.get(m.bandId) ?? `#${m.bandId}`, roles: m.roles, former: !m.active })),
      ...(ctx.lens ? {} : { notes: p.notes }),
    };
    if (self || can(ctx.access, "payouts")) {
      const e = await earningsIn(ctx.orgId, p.id);
      const money = (m: Map<string, number>) => [...m].map(([cur, c]) => formatCents(c, cur)).join(", ") || formatCents(0);
      out.money = {
        owedFromFinalizedPayouts: money(e.owed),
        paid: money(e.received),
        notInAPayoutYet: money(new Map(e.upcoming.map((u) => [u.cur, u.line.total]))),
      };
    }
    return out;
  },
});

export const FIND_TOOLS = [find, releaseDetail, personDetail];
