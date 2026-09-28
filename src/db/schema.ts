import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(datetime('now'))`;

export const bands = sqliteTable("bands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** Other spellings of the artist name as it appears in Bandcamp's "artist" column. */
  aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** Bandcamp subdomains / URL prefixes that identify this band, e.g. "glassharbor" or "label.bandcamp.com/album/foo". */
  urlPatterns: text("url_patterns", { mode: "json" }).$type<string[]>().notNull().default([]),
  notes: text("notes"),
  imageUrl: text("image_url"),
  location: text("location"),
  /** The label itself: releases under the label's own name (label tapes, compilations). */
  isLabel: integer("is_label", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(now),
});

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

export const people = sqliteTable("people", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email"),
  paypalMe: text("paypal_me"),
  /** Venmo username (US), for a prefilled "pay" link. */
  venmo: text("venmo"),
  /** Cash App $cashtag, without the "$". */
  cashtag: text("cashtag"),
  notes: text("notes"),
  /** Owns the label's bank account: their share is kept there rather than paid out. One person at most. */
  holdsLabelAccount: integer("holds_label_account", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
});

/**
 * An artist on one of the label's releases (usually a compilation) who isn't on the label. No band
 * is created for them, just one point of contact who gets paid for their tracks.
 */
export const outsideArtists = sqliteTable("outside_artists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  contactPersonId: integer("contact_person_id").references(() => people.id, { onDelete: "set null" }),
  /** You chose not to pay this artist (e.g. a donated track): the label keeps their share. */
  dismissed: integer("dismissed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
});

export const bandMemberships = sqliteTable(
  "band_memberships",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bandId: integer("band_id").notNull().references(() => bands.id, { onDelete: "cascade" }),
    personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    roles: text("roles", { mode: "json" }).$type<string[]>().notNull().default([]),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("band_person_unique").on(t.bandId, t.personId)],
);

export const releases = sqliteTable("releases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bandId: integer("band_id").notNull().references(() => bands.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  url: text("url"),
  catalogNumber: text("catalog_number"),
  releaseDate: text("release_date"),
  /** How album sales are split when this release has no split of its own. */
  albumSplitMode: text("album_split_mode", { enum: ["band_default", "average_tracks"] }).notNull().default("band_default"),
  // Filled in from Bandcamp
  bandcampId: integer("bandcamp_id"),
  /** merch: a standalone merch item (shirt, poster…) rather than music. */
  kind: text("kind", { enum: ["album", "track", "merch"] }).notNull().default("album"),
  upc: text("upc"),
  artUrl: text("art_url"),
  about: text("about"),
  credits: text("credits"),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  packages: text("packages", { mode: "json" }).$type<ReleasePackage[]>().notNull().default([]),
  syncedAt: text("synced_at"),
});

export const tracks = sqliteTable("tracks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  releaseId: integer("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
  /** Only set when the track belongs to a different band than its release (split releases, comps). */
  bandId: integer("band_id").references(() => bands.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  url: text("url"),
  isrc: text("isrc"),
  position: integer("position").notNull().default(0),
  bandcampId: integer("bandcamp_id"),
  durationSec: integer("duration_sec"),
  /** Track-level artist credit from Bandcamp, when it differs from the release artist. */
  artist: text("artist"),
  /** Credited to an artist who isn't on the label (their contact is paid for this track). */
  outsideArtistId: integer("outside_artist_id").references(() => outsideArtists.id, { onDelete: "set null" }),
});

export const splitRules = sqliteTable("split_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope", { enum: ["label_default", "band_default", "band_item_type", "release", "track"] }).notNull(),
  bandId: integer("band_id").references(() => bands.id, { onDelete: "cascade" }),
  releaseId: integer("release_id").references(() => releases.id, { onDelete: "cascade" }),
  trackId: integer("track_id").references(() => tracks.id, { onDelete: "cascade" }),
  itemCategory: text("item_category", { enum: ["album", "track", "merch", "other"] }),
  overridesCatalog: integer("overrides_catalog", { mode: "boolean" }).notNull().default(false),
  effectiveFrom: text("effective_from").notNull().default("2000-01-01"),
  note: text("note"),
  createdAt: text("created_at").notNull().default(now),
});

export const splitShares = sqliteTable("split_shares", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ruleId: integer("rule_id").notNull().references(() => splitRules.id, { onDelete: "cascade" }),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  bps: integer("bps").notNull(),
});

export const deductions = sqliteTable("deductions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
  packageId: integer("package_id"),
  effectiveFrom: text("effective_from"),
  effectiveTo: text("effective_to"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const routingOverrides = sqliteTable("routing_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  matchKey: text("match_key").notNull().unique(),
  bandId: integer("band_id").notNull().references(() => bands.id, { onDelete: "cascade" }),
  releaseId: integer("release_id").references(() => releases.id, { onDelete: "set null" }),
  trackId: integer("track_id").references(() => tracks.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull().default(now),
});

export const imports = sqliteTable("imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(),
  rowCount: integer("row_count").notNull(),
  addedCount: integer("added_count").notNull(),
  duplicateCount: integer("duplicate_count").notNull(),
  importedAt: text("imported_at").notNull().default(now),
});

export const sales = sqliteTable("sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importId: integer("import_id").notNull().references(() => imports.id, { onDelete: "cascade" }),
  dedupeKey: text("dedupe_key").notNull().unique(),
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
  raw: text("raw", { mode: "json" }).$type<Record<string, string>>().notNull(),
});

export const periods = sqliteTable("periods", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** Pay just this band; empty = the whole label. */
  bandId: integer("band_id").references(() => bands.id),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  /** A payout is only stored once finalized; before that it's a preview computed on the fly. */
  status: text("status", { enum: ["finalized", "paid"] }).notNull().default("finalized"),
  finalizedAt: text("finalized_at"),
  /** Snapshot of the computed summary at finalization, so later rule edits don't change history. */
  snapshot: text("snapshot", { mode: "json" }).$type<PeriodSnapshot>(),
  createdAt: text("created_at").notNull().default(now),
});

export const payouts = sqliteTable("payouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  periodId: integer("period_id").notNull().references(() => periods.id, { onDelete: "cascade" }),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "restrict" }),
  currency: text("currency").notNull(),
  amountCents: integer("amount_cents").notNull(),
  /** bandId → cents */
  byBand: text("by_band", { mode: "json" }).$type<Record<string, number>>().notNull(),
  /** kept: owed to the label account holder, so it stays in the label's account instead of being sent. */
  status: text("status", { enum: ["pending", "paid", "kept"] }).notNull().default("pending"),
  paidAt: text("paid_at"),
  reference: text("reference"),
});

/**
 * Money the label kept and then sent on elsewhere: a fundraiser's proceeds to an aid group, a
 * donation, a bill paid for a band. Recorded so the label's own balance stays honest.
 */
export const labelTransfers = sqliteTable("label_transfers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
});

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
