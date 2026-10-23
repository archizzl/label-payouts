import "server-only";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { AREAS, bandScope, describePermissions, inBandScope, normalizeBandAreas, normalizePermissions } from "@/lib/permissions";
import { salePartLabel } from "@/lib/sale-parts";
import { nameMaps, unroutedGroups } from "../data";
import { projectsEnabled } from "../features";
import { abelTool } from "./tool";

/*
 * Look-ups the change tools need: the ids of deductions, unmatched sales, imports, pickups, logins,
 * member types, links and projects. Each checks the same access as its page.
 */

const deductions = abelTool({
  name: "list_deductions",
  description: "The group's deductions (what's withheld from sales before the split, and where it goes), with their ids.",
  params: z.object({ bandId: z.number().int().optional() }),
  needs: { area: "rules" },
  run: async (ctx, { bandId }) => {
    const [rows, names] = await Promise.all([
      db.select().from(schema.deductions).where(eq(schema.deductions.orgId, ctx.orgId)).orderBy(asc(schema.deductions.sortOrder), asc(schema.deductions.id)),
      nameMaps(ctx.orgId),
    ]);
    return rows
      .filter((d) => !bandId || d.bandId === bandId)
      .map((d) => ({
        id: d.id,
        label: d.label,
        kind: d.kind,
        how:
          d.kind === "percent"
            ? `${((d.percentBps ?? 0) / 100).toFixed(2)}% of each sale`
            : d.kind === "sale_part"
              ? salePartLabel(d.salePart)
              : `${formatCents(d.amountCents ?? 0, d.currency ?? "USD")}${d.kind === "per_unit" ? " per item" : " until recouped"}`,
        goesTo: d.destination === "person" ? (names.person.get(d.personId ?? -1) ?? "someone") : d.destination,
        band: d.bandId ? (names.band.get(d.bandId) ?? null) : "every band",
        release: d.releaseId ? (names.release.get(d.releaseId) ?? null) : null,
        track: d.trackId ? (names.track.get(d.trackId) ?? null) : null,
        itemType: d.itemCategory,
        from: d.effectiveFrom,
        to: d.effectiveTo,
      }));
  },
});

const unmatched = abelTool({
  name: "unmatched_sales",
  description:
    "Sales that didn't match a band (or, with noRelease, matched a band but no release), grouped by item: each group's key, artist, item, how many sales and their total.",
  params: z.object({ noRelease: z.boolean().optional() }),
  needs: { area: "sales" },
  available: (ctx) => !ctx.lens,
  run: async (ctx, { noRelease }) => {
    const groups = await unroutedGroups(ctx.orgId, noRelease ? "no_release" : "no_band");
    const scope = bandScope(ctx.access, "sales");
    return groups
      .filter((g) => !noRelease || inBandScope(scope, [g.bandId]))
      .slice(0, 40)
      .map((g) => ({
        key: g.key,
        artist: g.artist,
        item: g.itemName,
        type: g.category,
        sales: g.count,
        total: [...g.totals].map(([cur, c]) => formatCents(c, cur)).join(", "),
      }));
  },
});

const imports = abelTool({
  name: "sales_imports",
  description: "Sales imports (with ids, and how many sales each brought in) and the remembered choices of where some sales belong (saved matches, with ids).",
  params: z.object({}),
  needs: { area: "sales", level: "edit" },
  available: (ctx) => !ctx.lens,
  run: async (ctx) => {
    const [importRows, overrides, names] = await Promise.all([
      db.select().from(schema.imports).where(eq(schema.imports.orgId, ctx.orgId)).orderBy(desc(schema.imports.importedAt)).limit(30),
      db.select().from(schema.routingOverrides).where(eq(schema.routingOverrides.orgId, ctx.orgId)).orderBy(desc(schema.routingOverrides.createdAt)).limit(60),
      nameMaps(ctx.orgId),
    ]);
    return {
      imports: importRows.map((i) => ({ id: i.id, file: i.filename, importedAt: i.importedAt, added: i.addedCount, duplicates: i.duplicateCount })),
      savedMatches: overrides.map((o) => ({
        id: o.id,
        key: o.matchKey,
        band: names.band.get(o.bandId) ?? null,
        release: o.releaseId ? (names.release.get(o.releaseId) ?? null) : null,
        track: o.trackId ? (names.track.get(o.trackId) ?? null) : null,
      })),
    };
  },
});

const pickups = abelTool({
  name: "pickup_orders",
  description: "Orders waiting to be collected in person, with ids, the buyer's first name, what they're getting and the note.",
  params: z.object({}),
  needs: { area: "orders" },
  run: async (ctx) => {
    const scope = bandScope(ctx.access, "orders");
    const rows = await db.select().from(schema.pickupOrders).where(eq(schema.pickupOrders.orgId, ctx.orgId)).orderBy(asc(schema.pickupOrders.orderDate));
    return rows
      .filter((p) => inBandScope(scope, p.bandIds))
      .map((p) => ({
        pickupId: p.id,
        orderDate: p.orderDate,
        buyer: p.buyerName.split(" ")[0] || null,
        items: p.items.map((i) => `${i.quantity} × ${i.name}${i.option ? ` (${i.option})` : ""}`),
        note: p.note,
      }));
  },
});

const outsideArtists = abelTool({
  name: "outside_artists",
  description: "Artists who aren't on the label but appear on its releases, with ids and who's paid for their tracks.",
  params: z.object({}),
  needs: { area: "roster" },
  available: (ctx) => !ctx.lens,
  run: async (ctx) => {
    const [rows, names] = await Promise.all([db.select().from(schema.outsideArtists).where(eq(schema.outsideArtists.orgId, ctx.orgId)), nameMaps(ctx.orgId)]);
    return rows.map((a) => ({ id: a.id, name: a.name, paidTo: a.contactPersonId ? (names.person.get(a.contactPersonId) ?? null) : null, hidden: a.dismissed }));
  },
});

const logins = abelTool({
  name: "who_can_sign_in",
  description:
    "Who can sign in to this group (member ids, user ids, role, member type), invites not used yet (ids), and the group's member types (ids, and what each can see and change).",
  params: z.object({}),
  needs: "admin",
  run: async (ctx) => {
    const orgId = ctx.org.id;
    const [members, invites, types, assignments] = await Promise.all([
      db
        .select({ memberId: schema.member.id, userId: schema.member.userId, role: schema.member.role, name: schema.user.name, email: schema.user.email })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, orgId)),
      db
        .select()
        .from(schema.invitation)
        .where(and(eq(schema.invitation.organizationId, orgId), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date()))),
      db.select().from(schema.memberTypes).where(eq(schema.memberTypes.orgId, orgId)).orderBy(asc(schema.memberTypes.name)),
      db.select().from(schema.memberTypeAssignments).where(eq(schema.memberTypeAssignments.orgId, orgId)),
    ]);
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    return {
      logins: members.map((m) => {
        const type = assignments.find((a) => a.userId === m.userId)?.memberTypeId;
        return { memberId: m.memberId, userId: m.userId, name: m.name, email: m.email, role: m.role, memberType: type ? (typeName.get(type) ?? null) : null };
      }),
      invites: invites.map((i) => ({ inviteId: i.id, email: i.email, role: i.role, expires: i.expiresAt })),
      memberTypes: types.map((t) => ({
        id: t.id,
        name: t.name,
        can: describePermissions(normalizePermissions(t.permissions), normalizeBandAreas(t.bandAreas)),
      })),
      sections: AREAS.map((a) => a.key),
    };
  },
});

const links = abelTool({
  name: "group_links",
  description: "Links between this group and labels or bands that run their own groups, with link ids.",
  params: z.object({}),
  needs: "admin",
  run: async (ctx) => {
    const rows = await db
      .select()
      .from(schema.accountLinks)
      .where(
        and(
          or(eq(schema.accountLinks.labelOrgId, ctx.org.id), eq(schema.accountLinks.bandOrgId, ctx.org.id)),
          eq(schema.accountLinks.managed, false),
        ),
      );
    const orgs = await db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization);
    const name = new Map(orgs.map((o) => [o.id, o.name]));
    return rows.map((l) => ({
      linkId: l.id,
      label: name.get(l.labelOrgId) ?? null,
      band: l.bandOrgId ? (name.get(l.bandOrgId) ?? null) : null,
      status: l.status,
    }));
  },
});

const projects = abelTool({
  name: "list_projects",
  description: "Projects (albums, tours, videos) with ids, band, status, budget and releases.",
  params: z.object({}),
  needs: "admin",
  available: () => projectsEnabled(),
  run: async (ctx) => {
    const [rows, links, names] = await Promise.all([
      db.select().from(schema.projects).where(eq(schema.projects.orgId, ctx.orgId)).orderBy(desc(schema.projects.createdAt)),
      db.select().from(schema.projectReleases).where(eq(schema.projectReleases.orgId, ctx.orgId)),
      nameMaps(ctx.orgId),
    ]);
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      band: p.bandId ? (names.band.get(p.bandId) ?? null) : null,
      status: p.status,
      budget: p.budgetCents ? formatCents(p.budgetCents, p.currency) : null,
      releases: links.filter((l) => l.projectId === p.id).map((l) => names.release.get(l.releaseId) ?? `#${l.releaseId}`),
      link: `/projects/${p.id}`,
    }));
  },
});

export const LOOKUP_TOOLS = [deductions, unmatched, imports, pickups, outsideArtists, logins, links, projects];
