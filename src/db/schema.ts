import { sql } from "drizzle-orm";
import { bigint, boolean, customType, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

export * from "./auth-schema";

/*
 * Everything below belongs to one account: a label or a band (Better Auth's "organization").
 * Every table carries `orgId`, and every query is scoped to the signed-in account; see
 * src/server/context.ts.
 *
 * Dates are ISO strings ("2026-09-27"), compared as text, as before. IDs are numbers the database
 * assigns, but can be set explicitly (for bringing data over from the old local app).
 */

/** "2026-09-27 14:03:00" in UTC, the format the app shows and sorts by. */
const now = sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')`;
const id = () => integer("id").primaryKey().generatedByDefaultAsIdentity();
/** Bandcamp's own ids (releases, tracks, packages) go past 32 bits. */
const bandcampId = (name: string) => bigint(name, { mode: "number" });
const orgId = () =>
  text("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

/** Per-account settings, e.g. the Bandcamp address and API access. */
export const accountSettings = pgTable("account_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** The account's Bandcamp address, e.g. "mylabel.bandcamp.com". */
  bandcampUrl: text("bandcamp_url"),
  bandcampClientId: text("bandcamp_client_id"),
  /** Encrypted at rest (see src/server/secrets.ts). */
  bandcampClientSecret: text("bandcamp_client_secret"),
  /**
   * The current Bandcamp sign-in, shared by every server process and kept across restarts:
   * Bandcamp allows one active sign-in per API client, so we renew this one rather than asking for
   * a new one. Both tokens are encrypted.
   */
  bandcampAccessToken: text("bandcamp_access_token"),
  bandcampRefreshToken: text("bandcamp_refresh_token"),
  /** When the access token expires (ISO time). */
  bandcampTokenExpiresAt: text("bandcamp_token_expires_at"),
  /** Which Bandcamp accounts the API last reported, and when ("Test connection" or a sync). */
  bandcampConnectedAs: text("bandcamp_connected_as"),
  bandcampCheckedAt: text("bandcamp_checked_at"),
  /**
   * Syncing with Bandcamp (artists, releases, merch, sales): when the last one started (also how
   * only one runs at a time) and finished, what it brought in, and anything that went wrong.
   */
  syncStartedAt: text("sync_started_at"),
  syncFinishedAt: text("sync_finished_at"),
  syncSummary: text("sync_summary"),
  syncError: text("sync_error"),
  /** An admin closed the dashboard's "Getting started" checklist (it can be brought back). */
  setupHidden: boolean("setup_hidden").notNull().default(false),
});

export const bands = pgTable(
  "bands",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    /** Other spellings of the artist name as it appears in Bandcamp's "artist" column. */
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    /** Bandcamp subdomains / URL prefixes that identify this band, e.g. "glassharbor" or "label.bandcamp.com/album/foo". */
    urlPatterns: jsonb("url_patterns").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    imageUrl: text("image_url"),
    location: text("location"),
    /** The label itself: releases under the label's own name (label tapes, compilations). */
    isLabel: boolean("is_label").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("bands_org").on(t.orgId)],
);

/** A physical/merch format of a release, as listed on Bandcamp. */
export type ReleasePackage = {
  bandcampId: number;
  title: string;
  typeName: string | null;
  sku: string | null;
  upc: string | null;
  price: number | null;
  currency: string | null;
  /** Sizes, colours etc. of a merch item, each with its own SKU. */
  options?: { title: string; sku: string | null }[];
};

/** Someone who gets paid. May be linked to a login, so they can see their own earnings. */
export const people = pgTable(
  "people",
  {
    id: id(),
    orgId: orgId(),
    /** Their login, once they've been invited and accepted. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    email: text("email"),
    paypalMe: text("paypal_me"),
    /** Venmo username (US), for a prefilled "pay" link. */
    venmo: text("venmo"),
    /** Cash App $cashtag, without the "$". */
    cashtag: text("cashtag"),
    notes: text("notes"),
    /** Owns the label's bank account: their share is kept there rather than paid out. One person at most. */
    holdsLabelAccount: boolean("holds_label_account").notNull().default(false),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("people_org").on(t.orgId), index("people_user").on(t.userId)],
);

/**
 * An artist on one of the label's releases (usually a compilation) who isn't on the label. No band
 * is created for them, just one point of contact who gets paid for their tracks.
 */
export const outsideArtists = pgTable(
  "outside_artists",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    contactPersonId: integer("contact_person_id").references(() => people.id, { onDelete: "set null" }),
    /** You chose not to pay this artist (e.g. a donated track): the label keeps their share. */
    dismissed: boolean("dismissed").notNull().default(false),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("outside_artists_org_name").on(t.orgId, t.name)],
);

export const bandMemberships = pgTable(
  "band_memberships",
  {
    id: id(),
    orgId: orgId(),
    bandId: integer("band_id")
      .notNull()
      .references(() => bands.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    roles: jsonb("roles").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("band_person_unique").on(t.bandId, t.personId), index("band_memberships_org").on(t.orgId)],
);

export const releases = pgTable(
  "releases",
  {
    id: id(),
    orgId: orgId(),
    bandId: integer("band_id")
      .notNull()
      .references(() => bands.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url"),
    catalogNumber: text("catalog_number"),
    releaseDate: text("release_date"),
    /** How album sales are split when this release has no split of its own. */
    albumSplitMode: text("album_split_mode", { enum: ["band_default", "average_tracks"] }).notNull().default("band_default"),
    // Filled in from Bandcamp
    bandcampId: bandcampId("bandcamp_id"),
    /** merch: a standalone merch item (shirt, poster…) rather than music. */
    kind: text("kind", { enum: ["album", "track", "merch"] }).notNull().default("album"),
    upc: text("upc"),
    artUrl: text("art_url"),
    about: text("about"),
    credits: text("credits"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    packages: jsonb("packages").$type<ReleasePackage[]>().notNull().default([]),
    syncedAt: text("synced_at"),
  },
  (t) => [index("releases_org").on(t.orgId)],
);

export const tracks = pgTable(
  "tracks",
  {
    id: id(),
    orgId: orgId(),
    releaseId: integer("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    /** Only set when the track belongs to a different band than its release (split releases, comps). */
    bandId: integer("band_id").references(() => bands.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    url: text("url"),
    isrc: text("isrc"),
    position: integer("position").notNull().default(0),
    bandcampId: bandcampId("bandcamp_id"),
    durationSec: integer("duration_sec"),
    /** Track-level artist credit from Bandcamp, when it differs from the release artist. */
    artist: text("artist"),
    /** Credited to an artist who isn't on the label (their contact is paid for this track). */
    outsideArtistId: integer("outside_artist_id").references(() => outsideArtists.id, { onDelete: "set null" }),
  },
  (t) => [index("tracks_org").on(t.orgId)],
);

export const splitRules = pgTable(
  "split_rules",
  {
    id: id(),
    orgId: orgId(),
    scope: text("scope", { enum: ["label_default", "band_default", "band_item_type", "release", "track"] }).notNull(),
    bandId: integer("band_id").references(() => bands.id, { onDelete: "cascade" }),
    releaseId: integer("release_id").references(() => releases.id, { onDelete: "cascade" }),
    trackId: integer("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    itemCategory: text("item_category", { enum: ["album", "track", "merch", "other"] }),
    overridesCatalog: boolean("overrides_catalog").notNull().default(false),
    effectiveFrom: text("effective_from").notNull().default("2000-01-01"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("split_rules_org").on(t.orgId)],
);

export const splitShares = pgTable(
  "split_shares",
  {
    id: id(),
    orgId: orgId(),
    ruleId: integer("rule_id")
      .notNull()
      .references(() => splitRules.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    bps: integer("bps").notNull(),
  },
  (t) => [index("split_shares_org").on(t.orgId)],
);

export const deductions = pgTable(
  "deductions",
  {
    id: id(),
    orgId: orgId(),
    label: text("label").notNull(),
    /** percent of what's left · fixed total recouped over time · per_unit amount per item sold */
    kind: text("kind", { enum: ["percent", "fixed", "per_unit"] }).notNull(),
    percentBps: integer("percent_bps"),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    destination: text("destination", { enum: ["label", "band_fund", "expense", "person"] }).notNull(),
    /** destination "person": who is paid this amount (e.g. whoever fronted the manufacturing). */
    personId: integer("person_id").references(() => people.id, { onDelete: "set null" }),
    bandId: integer("band_id").references(() => bands.id, { onDelete: "cascade" }),
    releaseId: integer("release_id").references(() => releases.id, { onDelete: "cascade" }),
    trackId: integer("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    itemCategory: text("item_category", { enum: ["album", "track", "merch", "other"] }),
    /** Only physical formats matching these words, e.g. "CD" or "cassette, tape" (comma = or). */
    formatMatch: text("format_match"),
    /** Only one specific format of the release: its Bandcamp package id (e.g. the CD, not the vinyl). */
    packageId: bandcampId("package_id"),
    effectiveFrom: text("effective_from"),
    effectiveTo: text("effective_to"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("deductions_org").on(t.orgId)],
);

export const routingOverrides = pgTable(
  "routing_overrides",
  {
    id: id(),
    orgId: orgId(),
    matchKey: text("match_key").notNull(),
    bandId: integer("band_id")
      .notNull()
      .references(() => bands.id, { onDelete: "cascade" }),
    releaseId: integer("release_id").references(() => releases.id, { onDelete: "set null" }),
    trackId: integer("track_id").references(() => tracks.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("routing_overrides_org_key").on(t.orgId, t.matchKey)],
);

export const imports = pgTable(
  "imports",
  {
    id: id(),
    orgId: orgId(),
    filename: text("filename").notNull(),
    rowCount: integer("row_count").notNull(),
    addedCount: integer("added_count").notNull(),
    duplicateCount: integer("duplicate_count").notNull(),
    importedAt: text("imported_at").notNull().default(now),
  },
  (t) => [index("imports_org").on(t.orgId)],
);

export const sales = pgTable(
  "sales",
  {
    id: id(),
    orgId: orgId(),
    importId: integer("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    date: text("date").notNull(),
    itemType: text("item_type").notNull(),
    category: text("category", { enum: ["album", "track", "merch", "other"] }).notNull(),
    itemName: text("item_name").notNull(),
    artist: text("artist").notNull(),
    itemUrl: text("item_url").notNull(),
    packageName: text("package_name").notNull(),
    currency: text("currency").notNull(),
    netCents: integer("net_cents").notNull(),
    quantity: integer("quantity").notNull().default(1),
    transactionId: text("transaction_id").notNull(),
    routingKey: text("routing_key").notNull(),
    bandId: integer("band_id").references(() => bands.id, { onDelete: "set null" }),
    releaseId: integer("release_id").references(() => releases.id, { onDelete: "set null" }),
    trackId: integer("track_id").references(() => tracks.id, { onDelete: "set null" }),
    routedVia: text("routed_via"),
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    /**
     * A fingerprint of the buyer's email (see emailFingerprint), to match purchases to fans on the
     * mailing list. The email itself isn't stored. "" when the report had none.
     */
    buyerKey: text("buyer_key"),
  },
  (t) => [
    uniqueIndex("sales_org_dedupe").on(t.orgId, t.dedupeKey),
    index("sales_org_date").on(t.orgId, t.date),
    index("sales_org_buyer").on(t.orgId, t.buyerKey),
  ],
);

export const periods = pgTable(
  "periods",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    /** Pay just this band; empty = the whole label. */
    bandId: integer("band_id").references(() => bands.id),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    /** A payout is only stored once finalized; before that it's a preview computed on the fly. */
    status: text("status", { enum: ["finalized", "paid"] }).notNull().default("finalized"),
    finalizedAt: text("finalized_at"),
    /** Snapshot of the computed summary at finalization, so later rule edits don't change history. */
    snapshot: jsonb("snapshot").$type<PeriodSnapshot>(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("periods_org").on(t.orgId)],
);

export const payouts = pgTable(
  "payouts",
  {
    id: id(),
    orgId: orgId(),
    periodId: integer("period_id")
      .notNull()
      .references(() => periods.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "restrict" }),
    currency: text("currency").notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** bandId → cents */
    byBand: jsonb("by_band").$type<Record<string, number>>().notNull(),
    /** kept: owed to the label account holder, so it stays in the label's account instead of being sent. */
    status: text("status", { enum: ["pending", "paid", "kept"] }).notNull().default("pending"),
    paidAt: text("paid_at"),
    reference: text("reference"),
  },
  (t) => [index("payouts_org").on(t.orgId), index("payouts_person").on(t.personId)],
);

/**
 * Money the label kept and then sent on elsewhere: a fundraiser's proceeds to an aid group, a
 * donation, a bill paid for a band. Recorded so the label's own balance stays honest.
 */
export const labelTransfers = pgTable(
  "label_transfers",
  {
    id: id(),
    orgId: orgId(),
    date: text("date").notNull(),
    /** Who received it, e.g. "Mutual Aid NYC". */
    recipient: text("recipient").notNull(),
    currency: text("currency").notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** What it was for (both optional): the band whose sales raised it, and/or the release. */
    bandId: integer("band_id").references(() => bands.id, { onDelete: "set null" }),
    releaseId: integer("release_id").references(() => releases.id, { onDelete: "set null" }),
    /** How it was sent: PayPal, bank transfer, check… */
    method: text("method"),
    reference: text("reference"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("label_transfers_org").on(t.orgId)],
);

/**
 * A project: an album, an EP, a tour, a video. Expenses are assigned to it, and the sales of its
 * releases (and their formats and merch) are what it makes back.
 */
export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    /** The band it's for; empty for a label-wide project (a compilation, a label showcase). */
    bandId: integer("band_id").references(() => bands.id, { onDelete: "set null" }),
    status: text("status", { enum: ["active", "done"] }).notNull().default("active"),
    /** Optional: what you planned to spend. */
    budgetCents: integer("budget_cents"),
    currency: text("currency").notNull().default("USD"),
    startDate: text("start_date"),
    notes: text("notes"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("projects_org").on(t.orgId)],
);

/** The releases (and merch items) whose sales count toward a project. */
export const projectReleases = pgTable(
  "project_releases",
  {
    id: id(),
    orgId: orgId(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    releaseId: integer("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("project_release_unique").on(t.projectId, t.releaseId)],
);

/** Raw file bytes (receipt photos and PDFs), kept in the database so there's no separate file store. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

/**
 * An expense with its receipt: pressing CDs, mastering, a van repair. Members can submit their own
 * (status "pending") for an admin to approve; only approved expenses count.
 *
 * - `paidBy`: who paid the bill: the label, a band fund, or a person out of pocket.
 * - `recoup`: pay it back from the band's (or release's) sales not yet paid out (from `recoupFrom`),
 *   before they're split. The money goes back to whoever paid (a person gets it in their next payout).
 * - Not recouped and paid by a person: the label reimburses them (`reimbursedAt` once done).
 */
export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    orgId: orgId(),
    date: text("date").notNull(),
    description: text("description").notNull(),
    vendor: text("vendor"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    bandId: integer("band_id").references(() => bands.id, { onDelete: "set null" }),
    releaseId: integer("release_id").references(() => releases.id, { onDelete: "set null" }),
    /** The project it was spent on, if any. */
    projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** What kind of cost: "Studio time", "Session musicians", "Mixing"… (free text, with suggestions). */
    category: text("category"),
    paidBy: text("paid_by", { enum: ["label", "band_fund", "person"] }).notNull(),
    paidByPersonId: integer("paid_by_person_id").references(() => people.id, { onDelete: "set null" }),
    recoup: boolean("recoup").notNull().default(false),
    /**
     * Pay back from sales made on or after this date: the expense date, or the day after the last
     * finalized payout covering the band if that's later (paid-out sales are never touched). Set
     * when it's approved.
     */
    recoupFrom: text("recoup_from"),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
    submittedByUserId: text("submitted_by_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Why it was rejected, or anything the reviewer wants to note. */
    reviewNote: text("review_note"),
    reviewedAt: text("reviewed_at"),
    reimbursedAt: text("reimbursed_at"),
    reimbursedReference: text("reimbursed_reference"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("expenses_org").on(t.orgId), index("expenses_band").on(t.bandId)],
);

export const expenseFiles = pgTable(
  "expense_files",
  {
    id: id(),
    orgId: orgId(),
    expenseId: integer("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    data: bytea("data").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("expense_files_expense").on(t.expenseId)],
);

/**
 * A band's own account linked to its label's account: the band account gets a read-only view of
 * the label's books for that band. The label creates a code (pending); the band account accepts it.
 */
export const accountLinks = pgTable(
  "account_links",
  {
    id: id(),
    labelOrgId: text("label_org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The band in the label's books. */
    labelBandId: integer("label_band_id")
      .notNull()
      .references(() => bands.id, { onDelete: "cascade" }),
    /** The band's own account, once it has accepted. */
    bandOrgId: text("band_org_id").references(() => organization.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    status: text("status", { enum: ["pending", "active"] }).notNull().default("pending"),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().default(now),
    acceptedAt: text("accepted_at"),
  },
  (t) => [uniqueIndex("account_links_code").on(t.code), uniqueIndex("account_links_label_band").on(t.labelBandId)],
);

export type PeriodSnapshot = {
  currencies: {
    currency: string;
    grossCents: number;
    byBand: { bandId: number | null; cents: number }[];
    byDestination: { key: string; cents: number }[];
    unallocated: number;
    problems: { unrouted: number; noRule: number };
  }[];
  saleCount: number;
};

/** A mailing-list file brought in from Bandcamp (Tools → Mailing list → export). */
export const fanImports = pgTable(
  "fan_imports",
  {
    id: id(),
    orgId: orgId(),
    filename: text("filename").notNull(),
    /** The band the list was exported from, when the file doesn't say per row. Null: label-wide. */
    bandId: integer("band_id").references(() => bands.id, { onDelete: "set null" }),
    rowCount: integer("row_count").notNull(),
    addedCount: integer("added_count").notNull(),
    importedByUserId: text("imported_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("fan_imports_org").on(t.orgId)],
);

/**
 * Someone on the mailing list: one row per email per account, however many lists they're on.
 * Personal data: admins only, and deletable on request.
 */
export const fans = pgTable(
  "fans",
  {
    id: id(),
    orgId: orgId(),
    /** Lower-cased. */
    email: text("email").notNull(),
    name: text("name"),
    country: text("country"),
    postalCode: text("postal_code"),
    /** When they first signed up, as Bandcamp reports it (yyyy-mm-dd), or when first imported. */
    addedOn: text("added_on").notNull(),
    /** Columns we don't otherwise use, kept as exported. */
    extra: jsonb("extra").$type<Record<string, string>>().notNull().default({}),
    firstImportId: integer("first_import_id").references(() => fanImports.id, { onDelete: "set null" }),
    /** Fingerprint of the email, to find their purchases (sales.buyerKey). */
    emailKey: text("email_key"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("fans_org").on(t.orgId), uniqueIndex("fans_org_email").on(t.orgId, t.email), index("fans_org_key").on(t.orgId, t.emailKey)],
);

/** Which bands' lists a fan is on (none: the label's own list). */
export const fanBands = pgTable(
  "fan_bands",
  {
    fanId: integer("fan_id")
      .notNull()
      .references(() => fans.id, { onDelete: "cascade" }),
    bandId: integer("band_id")
      .notNull()
      .references(() => bands.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("fan_bands_pk").on(t.fanId, t.bandId), index("fan_bands_band").on(t.bandId)],
);
