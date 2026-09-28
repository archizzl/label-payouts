import Database from "better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";

/*
 * Bring the books from the old single-user app (a SQLite file, data/label.db) into an account.
 * Every row gets a new id in Postgres, and every reference is rewritten to match, including the
 * band ids stored inside payouts and payout snapshots.
 */

type Row = Record<string, unknown>;
type IdMap = Map<number, number>;

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const bool = (v: unknown) => v === 1 || v === true || v === "1";
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

export type LocalImportCounts = Record<string, number>;

export async function importLocalBooks(sqlitePath: string, orgId: string): Promise<LocalImportCounts> {
  const old = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const all = (table: string): Row[] => old.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Row[];
  const counts: LocalImportCounts = {};
  const ids: Record<string, IdMap> = {};
  /** The new id for an old one (null stays null; an id that no longer exists becomes null). */
  const to = (table: string, v: unknown) => (v === null || v === undefined ? null : (ids[table].get(Number(v)) ?? null));

  try {
    await db.transaction(async (tx) => {
      /** Insert rows one at a time (to learn each new id) and remember old → new. */
      const copy = async <T extends { id: number }>(
        table: string,
        rows: Row[],
        insert: (r: Row) => Promise<T[]>,
      ) => {
        const m: IdMap = new Map();
        for (const r of rows) {
          const [created] = await insert(r);
          m.set(Number(r.id), created.id);
        }
        ids[table] = m;
        counts[table] = rows.length;
      };

      await copy("bands", all("bands"), (r) =>
        tx
          .insert(schema.bands)
          .values({
            orgId,
            name: String(r.name),
            aliases: json(r.aliases, []),
            urlPatterns: json(r.url_patterns, []),
            notes: str(r.notes),
            imageUrl: str(r.image_url),
            location: str(r.location),
            isLabel: bool(r.is_label),
            active: bool(r.active),
            createdAt: String(r.created_at),
          })
          .returning(),
      );
      await copy("people", all("people"), (r) =>
        tx
          .insert(schema.people)
          .values({
            orgId,
            name: String(r.name),
            email: str(r.email),
            paypalMe: str(r.paypal_me),
            venmo: str(r.venmo),
            cashtag: str(r.cashtag),
            notes: str(r.notes),
            holdsLabelAccount: bool(r.holds_label_account),
            createdAt: String(r.created_at),
          })
          .returning(),
      );
      await copy("outside_artists", all("outside_artists"), (r) =>
        tx
          .insert(schema.outsideArtists)
          .values({
            orgId,
            name: String(r.name),
            contactPersonId: to("people", r.contact_person_id),
            dismissed: bool(r.dismissed),
            createdAt: String(r.created_at),
          })
          .returning(),
      );
      await copy("band_memberships", all("band_memberships"), (r) =>
        tx
          .insert(schema.bandMemberships)
          .values({
            orgId,
            bandId: to("bands", r.band_id)!,
            personId: to("people", r.person_id)!,
            roles: json(r.roles, []),
            active: bool(r.active),
          })
          .returning(),
      );
      await copy("releases", all("releases"), (r) =>
        tx
          .insert(schema.releases)
          .values({
            orgId,
            bandId: to("bands", r.band_id)!,
            title: String(r.title),
            url: str(r.url),
            catalogNumber: str(r.catalog_number),
            releaseDate: str(r.release_date),
            albumSplitMode: r.album_split_mode === "average_tracks" ? "average_tracks" : "band_default",
            bandcampId: num(r.bandcamp_id),
            kind: r.kind === "track" || r.kind === "merch" ? r.kind : "album",
            upc: str(r.upc),
            artUrl: str(r.art_url),
            about: str(r.about),
            credits: str(r.credits),
            tags: json(r.tags, []),
            packages: json(r.packages, []),
            syncedAt: str(r.synced_at),
          })
          .returning(),
      );
      await copy("tracks", all("tracks"), (r) =>
        tx
          .insert(schema.tracks)
          .values({
            orgId,
            releaseId: to("releases", r.release_id)!,
            bandId: to("bands", r.band_id),
            title: String(r.title),
            url: str(r.url),
            isrc: str(r.isrc),
            position: Number(r.position ?? 0),
            bandcampId: num(r.bandcamp_id),
            durationSec: num(r.duration_sec),
            artist: str(r.artist),
            outsideArtistId: to("outside_artists", r.outside_artist_id),
          })
          .returning(),
      );
      await copy("split_rules", all("split_rules"), (r) =>
        tx
          .insert(schema.splitRules)
          .values({
            orgId,
            scope: r.scope as typeof schema.splitRules.$inferInsert.scope,
            bandId: to("bands", r.band_id),
            releaseId: to("releases", r.release_id),
            trackId: to("tracks", r.track_id),
            itemCategory: (str(r.item_category) as typeof schema.splitRules.$inferInsert.itemCategory) ?? null,
            overridesCatalog: bool(r.overrides_catalog),
            effectiveFrom: String(r.effective_from),
            note: str(r.note),
            createdAt: String(r.created_at),
          })
          .returning(),
      );
      await copy("split_shares", all("split_shares"), (r) =>
        tx
          .insert(schema.splitShares)
          .values({ orgId, ruleId: to("split_rules", r.rule_id)!, personId: to("people", r.person_id)!, bps: Number(r.bps) })
          .returning(),
      );
      await copy("deductions", all("deductions"), (r) =>
        tx
          .insert(schema.deductions)
          .values({
            orgId,
            label: String(r.label),
            kind: r.kind as typeof schema.deductions.$inferInsert.kind,
            percentBps: num(r.percent_bps),
            amountCents: num(r.amount_cents),
            currency: str(r.currency),
            destination: r.destination as typeof schema.deductions.$inferInsert.destination,
            personId: to("people", r.person_id),
            bandId: to("bands", r.band_id),
            releaseId: to("releases", r.release_id),
            trackId: to("tracks", r.track_id),
            itemCategory: (str(r.item_category) as typeof schema.deductions.$inferInsert.itemCategory) ?? null,
            formatMatch: str(r.format_match),
            packageId: num(r.package_id),
            effectiveFrom: str(r.effective_from),
            effectiveTo: str(r.effective_to),
            sortOrder: Number(r.sort_order ?? 0),
          })
          .returning(),
      );
      await copy("routing_overrides", all("routing_overrides"), (r) =>
        tx
          .insert(schema.routingOverrides)
          .values({
            orgId,
            matchKey: String(r.match_key),
            bandId: to("bands", r.band_id)!,
            releaseId: to("releases", r.release_id),
            trackId: to("tracks", r.track_id),
            createdAt: String(r.created_at),
          })
          .returning(),
      );
      await copy("imports", all("imports"), (r) =>
        tx
          .insert(schema.imports)
          .values({
            orgId,
            filename: String(r.filename),
            rowCount: Number(r.row_count),
            addedCount: Number(r.added_count),
            duplicateCount: Number(r.duplicate_count),
            importedAt: String(r.imported_at),
          })
          .returning(),
      );
      await copy("sales", all("sales"), (r) =>
        tx
          .insert(schema.sales)
          .values({
            orgId,
            importId: to("imports", r.import_id)!,
            dedupeKey: String(r.dedupe_key),
            date: String(r.date),
            itemType: String(r.item_type),
            category: r.category as typeof schema.sales.$inferInsert.category,
            itemName: String(r.item_name),
            artist: String(r.artist),
            itemUrl: String(r.item_url),
            packageName: String(r.package_name),
            currency: String(r.currency),
            netCents: Number(r.net_cents),
            quantity: Number(r.quantity ?? 1),
            transactionId: String(r.transaction_id),
            routingKey: String(r.routing_key),
            bandId: to("bands", r.band_id),
            releaseId: to("releases", r.release_id),
            trackId: to("tracks", r.track_id),
            routedVia: str(r.routed_via),
            raw: json(r.raw, {}),
          })
          .returning(),
      );
      await copy("periods", all("periods"), (r) => {
        const snapshot = json<typeof schema.periods.$inferInsert.snapshot>(r.snapshot, null);
        if (snapshot) {
          for (const c of snapshot.currencies) {
            c.byBand = c.byBand.map((b) => ({ ...b, bandId: b.bandId === null ? null : to("bands", b.bandId) }));
            c.byDestination = c.byDestination.map((d) => {
              const m = d.key.match(/^band_fund:(\d+)$/);
              return m ? { ...d, key: `band_fund:${to("bands", m[1])}` } : d;
            });
          }
        }
        return tx
          .insert(schema.periods)
          .values({
            orgId,
            name: String(r.name),
            bandId: to("bands", r.band_id),
            startDate: String(r.start_date),
            endDate: String(r.end_date),
            status: r.status === "paid" ? "paid" : "finalized",
            finalizedAt: str(r.finalized_at),
            snapshot,
            createdAt: String(r.created_at),
          })
          .returning();
      });
      await copy("payouts", all("payouts"), (r) =>
        tx
          .insert(schema.payouts)
          .values({
            orgId,
            periodId: to("periods", r.period_id)!,
            personId: to("people", r.person_id)!,
            currency: String(r.currency),
            amountCents: Number(r.amount_cents),
            byBand: Object.fromEntries(Object.entries(json<Record<string, number>>(r.by_band, {})).map(([b, c]) => [String(to("bands", b)), c])),
            status: r.status === "paid" || r.status === "kept" ? r.status : "pending",
            paidAt: str(r.paid_at),
            reference: str(r.reference),
          })
          .returning(),
      );
      await copy("label_transfers", all("label_transfers"), (r) =>
        tx
          .insert(schema.labelTransfers)
          .values({
            orgId,
            date: String(r.date),
            recipient: String(r.recipient),
            currency: String(r.currency),
            amountCents: Number(r.amount_cents),
            bandId: to("bands", r.band_id),
            releaseId: to("releases", r.release_id),
            method: str(r.method),
            reference: str(r.reference),
            note: str(r.note),
            createdAt: String(r.created_at),
          })
          .returning(),
      );
    });
  } finally {
    old.close();
  }
  return counts;
}

/** Whether an account has any books yet (bands, people who aren't logins, sales, payouts…). */
export async function accountHasBooks(orgId: string) {
  const checks = await Promise.all([
    db.select({ id: schema.bands.id }).from(schema.bands).where(eq(schema.bands.orgId, orgId)).limit(1),
    db.select({ id: schema.sales.id }).from(schema.sales).where(eq(schema.sales.orgId, orgId)).limit(1),
    db.select({ id: schema.periods.id }).from(schema.periods).where(eq(schema.periods.orgId, orgId)).limit(1),
  ]);
  return checks.some((rows) => rows.length > 0);
}

/**
 * Empty an account's books so they can be replaced by an import. Keeps the account itself, who can
 * sign in (and the payee records linked to their logins), settings, invites and links to labels.
 * Links from this account's bands to band accounts go with the bands.
 */
export async function clearBooks(orgId: string) {
  const o = orgId;
  await db.transaction(async (tx) => {
    // Children before parents, so nothing is left pointing at a deleted row.
    await tx.delete(schema.expenses).where(eq(schema.expenses.orgId, o)); // files cascade
    await tx.delete(schema.payouts).where(eq(schema.payouts.orgId, o));
    await tx.delete(schema.periods).where(eq(schema.periods.orgId, o));
    await tx.delete(schema.labelTransfers).where(eq(schema.labelTransfers.orgId, o));
    await tx.delete(schema.imports).where(eq(schema.imports.orgId, o)); // sales cascade
    await tx.delete(schema.routingOverrides).where(eq(schema.routingOverrides.orgId, o));
    await tx.delete(schema.deductions).where(eq(schema.deductions.orgId, o));
    await tx.delete(schema.splitRules).where(eq(schema.splitRules.orgId, o)); // shares cascade
    await tx.delete(schema.tracks).where(eq(schema.tracks.orgId, o));
    await tx.delete(schema.releases).where(eq(schema.releases.orgId, o));
    await tx.delete(schema.bandMemberships).where(eq(schema.bandMemberships.orgId, o));
    await tx.delete(schema.bands).where(eq(schema.bands.orgId, o));
    await tx.delete(schema.outsideArtists).where(eq(schema.outsideArtists.orgId, o));
    await tx.delete(schema.people).where(and(eq(schema.people.orgId, o), isNull(schema.people.userId)));
  });
}
