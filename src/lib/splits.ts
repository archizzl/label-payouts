import type { ItemCategory } from "./bandcamp-csv";
import { allocate } from "./money";

/**
 * label_default: used for any band without its own default split. Its shares are optional fixed
 * carve-outs (e.g. 10% to a producer); whatever is left is split evenly between the band's
 * current members.
 */
export type RuleScope = "label_default" | "band_default" | "band_item_type" | "release" | "track";

export type SplitRule = {
  id: number;
  scope: RuleScope;
  bandId: number | null;
  releaseId: number | null;
  trackId: number | null;
  itemCategory: ItemCategory | null;
  /** band_item_type only: apply even when the sale matched a release/track that has its own split. */
  overridesCatalog: boolean;
  effectiveFrom: string; // ISO date
  shares: { personId: number; bps: number }[];
};

export type DeductionDestination = "label" | "band_fund" | "expense" | "person";

export type Deduction = {
  id: number;
  label: string;
  kind: "percent" | "fixed" | "per_unit";
  /** percent: basis points of the amount remaining at this step (2000 = 20%). */
  percentBps: number | null;
  /**
   * fixed: total amount to recoup from matching sales, in order, until covered.
   * per_unit: amount per item sold (× quantity), e.g. what each CD cost to make.
   */
  amountCents: number | null;
  currency: string | null;
  destination: DeductionDestination;
  /** destination "person": who receives it. */
  personId?: number | null;
  /** Only sales whose physical format matches one of these comma-separated words ("CD", "cassette, tape"). */
  formatMatch?: string | null;
  /** Only sales of this specific format of the release (its Bandcamp package id). */
  packageId?: number | null;
  bandId: number | null;
  releaseId: number | null;
  trackId: number | null;
  itemCategory: ItemCategory | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sortOrder: number;
};

export type ReleaseSettings = { id: number; albumSplitMode: "band_default" | "average_tracks"; trackIds: number[] };

export type EngineSale = {
  id: number;
  date: string;
  bandId: number | null;
  releaseId: number | null;
  trackId: number | null;
  category: ItemCategory;
  currency: string;
  netCents: number;
  /** Items in the sale (defaults to 1). */
  quantity?: number;
  /** Words describing the physical format, e.g. "CD Compact Disc (CD)". Empty for digital. */
  format?: string;
  /** The release format that was sold (its Bandcamp package id), when it could be identified. */
  packageId?: number | null;
};

export type EngineContext = {
  rules: SplitRule[];
  deductions: Deduction[];
  releases: ReleaseSettings[];
  /** bandId → current members' person ids, for the label-wide default split. */
  members?: Map<number, number[]>;
  /** Bands that are the label itself: without a split of their own, the label keeps the money. */
  labelBandIds?: Set<number>;
  /**
   * Per-track attribution on compilations: a track by another band on the label (bandId), or by
   * an artist who isn't on the label (outside, paid to their contact once there is one).
   */
  tracks?: Map<number, { bandId: number | null; outside: boolean; contactPersonId: number | null; labelKeeps?: boolean }>;
};

/** Weight key for "the label keeps this share" (label releases without a split). Never a person id. */
export const LABEL_SHARE = -1;

export type RuleSource =
  | "track"
  | "release"
  | "album_average"
  | "band_item_type"
  | "band_default"
  | "label_default"
  | "outside_artist"
  | "label_keeps";

export type SaleResult = {
  saleId: number;
  bandId: number | null;
  currency: string;
  netCents: number;
  deductions: { deductionId: number; label: string; destination: DeductionDestination; bandId: number | null; cents: number }[];
  /**
   * Whole cents per person for this sale, plus their exact (unrounded) amount. Payout totals are
   * built from the exact amounts and rounded once, so rounding doesn't favour anyone.
   */
  shares: { personId: number; cents: number; exact: number }[];
  ruleId: number | null;
  ruleSource: RuleSource | null;
  /** Money that couldn't be assigned to anyone (unrouted sale, or no split rule found). */
  unallocatedCents: number;
  problem: "unrouted" | "no_rule" | null;
};

function inWindow(date: string, from: string | null, to: string | null) {
  return (!from || from <= date) && (!to || date <= to);
}

/** Of the rules at one precedence level, the one in effect on `date` (latest effectiveFrom ≤ date). */
function inEffect(rules: SplitRule[], date: string): SplitRule | null {
  let best: SplitRule | null = null;
  for (const r of rules) {
    if (r.effectiveFrom > date) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom || (r.effectiveFrom === best.effectiveFrom && r.id > best.id)) best = r;
  }
  return best;
}

type Resolved = { ruleId: number | null; source: RuleSource; weights: Map<number, number> };

function weightsOf(rule: SplitRule): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of rule.shares) m.set(s.personId, (m.get(s.personId) ?? 0) + s.bps);
  return m;
}

export function resolveRule(sale: EngineSale, ctx: EngineContext): Resolved | null {
  if (sale.bandId === null) return null;
  const date = sale.date;
  const pick = (pred: (r: SplitRule) => boolean) => inEffect(ctx.rules.filter(pred), date);

  const itemTypeRule = pick(
    (r) => r.scope === "band_item_type" && r.bandId === sale.bandId && r.itemCategory === sale.category,
  );
  if (itemTypeRule?.overridesCatalog) {
    return { ruleId: itemTypeRule.id, source: "band_item_type", weights: weightsOf(itemTypeRule) };
  }

  if (sale.trackId !== null) {
    const r = pick((r) => r.scope === "track" && r.trackId === sale.trackId);
    if (r) return { ruleId: r.id, source: "track", weights: weightsOf(r) };
    // A track by an artist who isn't on the label: their contact gets it (flagged until there is one).
    const t = ctx.tracks?.get(sale.trackId);
    if (t?.outside) {
      if (t.contactPersonId) return { ruleId: null, source: "outside_artist", weights: new Map([[t.contactPersonId, 1]]) };
      // An outside artist you chose not to pay: the label keeps it.
      if (t.labelKeeps) return { ruleId: null, source: "label_keeps", weights: new Map([[LABEL_SHARE, 1]]) };
      return null;
    }
  }
  if (sale.releaseId !== null) {
    const r = pick((r) => r.scope === "release" && r.releaseId === sale.releaseId);
    if (r) return { ruleId: r.id, source: "release", weights: weightsOf(r) };

    const release = ctx.releases.find((x) => x.id === sale.releaseId);
    if (sale.category === "album" && sale.trackId === null && release?.albumSplitMode === "average_tracks") {
      const avg = averageTrackWeights(release, sale, ctx);
      if (avg) return { ruleId: null, source: "album_average", weights: avg };
      // Some track can't be paid yet (e.g. an outside artist without a contact): flag the sale
      // instead of letting the band or label take that track's share.
      if (release.trackIds.length > 0) return null;
    }
  }
  if (itemTypeRule) return { ruleId: itemTypeRule.id, source: "band_item_type", weights: weightsOf(itemTypeRule) };

  return bandFallback(sale.bandId, date, ctx);
}

/** The band's default split; for the label's own band, the label keeps it; otherwise the label-wide default. */
function bandFallback(bandId: number, date: string, ctx: EngineContext): Resolved | null {
  const def = inEffect(ctx.rules.filter((r) => r.scope === "band_default" && r.bandId === bandId), date);
  if (def) return { ruleId: def.id, source: "band_default", weights: weightsOf(def) };
  if (ctx.labelBandIds?.has(bandId)) return { ruleId: null, source: "label_keeps", weights: new Map([[LABEL_SHARE, 1]]) };
  const label = inEffect(ctx.rules.filter((r) => r.scope === "label_default"), date);
  if (label) {
    const weights = labelDefaultWeights(label, ctx.members?.get(bandId) ?? []);
    if (weights) return { ruleId: label.id, source: "label_default", weights };
  }
  return null;
}

/** Carve-outs first, then the rest split evenly between members. Null if nobody can take the rest. */
export function labelDefaultWeights(rule: SplitRule, memberIds: number[]): Map<number, number> | null {
  const weights = weightsOf(rule);
  const carved = [...weights.values()].reduce((a, b) => a + b, 0);
  const rest = Math.max(0, 10000 - carved);
  const members = [...new Set(memberIds)];
  if (rest > 0) {
    if (members.length === 0) return null;
    for (const p of members) weights.set(p, (weights.get(p) ?? 0) + rest / members.length);
  }
  return weights.size > 0 ? weights : null;
}

/**
 * Each track counts equally. A track without its own split goes to its artist: another band on
 * the label (its split), an outside artist (their contact), or else the release's band. If any
 * track can't be paid yet (e.g. an outside artist with no contact), the whole sale is flagged
 * rather than handing that track's share to someone else.
 */
function averageTrackWeights(release: ReleaseSettings, sale: EngineSale, ctx: EngineContext): Map<number, number> | null {
  if (release.trackIds.length === 0 || sale.bandId === null) return null;
  const total = new Map<number, number>();
  for (const trackId of release.trackIds) {
    const rule = inEffect(ctx.rules.filter((r) => r.scope === "track" && r.trackId === trackId), sale.date);
    const t = ctx.tracks?.get(trackId);
    const w = rule
      ? weightsOf(rule)
      : t?.outside
        ? t.contactPersonId
          ? new Map([[t.contactPersonId, 1]])
          : t.labelKeeps
            ? new Map([[LABEL_SHARE, 1]])
            : null
        : (bandFallback(t?.bandId ?? sale.bandId, sale.date, ctx)?.weights ?? null);
    if (!w) return null;
    const sum = [...w.values()].reduce((a, b) => a + b, 0);
    if (sum <= 0) return null;
    for (const [p, bps] of w) total.set(p, (total.get(p) ?? 0) + bps / sum);
  }
  return total;
}

function deductionMatches(d: Deduction, sale: EngineSale): boolean {
  if (!inWindow(sale.date, d.effectiveFrom, d.effectiveTo)) return false;
  if (d.bandId !== null && d.bandId !== sale.bandId) return false;
  if (d.releaseId !== null && d.releaseId !== sale.releaseId) return false;
  if (d.trackId !== null && d.trackId !== sale.trackId) return false;
  if (d.itemCategory !== null && d.itemCategory !== sale.category) return false;
  if (d.kind !== "percent" && d.currency && d.currency !== sale.currency) return false;
  if (d.formatMatch && !formatMatches(d.formatMatch, sale.format ?? "")) return false;
  if (d.packageId != null && d.packageId !== sale.packageId) return false;
  return true;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** "CD" matches "Compact Disc (CD)"; "cassette, tape" matches either word. Whole words only. */
export function formatMatches(match: string, format: string): boolean {
  const hay = ` ${words(format)} `;
  return match
    .split(",")
    .map(words)
    .filter(Boolean)
    .some((needle) => hay.includes(` ${needle} `));
}

/** Label-wide deductions (no band filter) run before band-specific ones; then by sortOrder. */
function deductionOrder(a: Deduction, b: Deduction) {
  const stage = (d: Deduction) => (d.bandId === null && d.releaseId === null && d.trackId === null ? 0 : 1);
  return stage(a) - stage(b) || a.sortOrder - b.sortOrder || a.id - b.id;
}

/**
 * Run every sale through deductions and splits. Sales must include all history up to the
 * end of the period being viewed, because fixed deductions (recoupable costs) carry over
 * from earlier sales. Sales are processed in date order.
 */
export function computeLedger(sales: EngineSale[], ctx: EngineContext): SaleResult[] {
  const ordered = [...sales].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const deductions = [...ctx.deductions].sort(deductionOrder);
  const recoupRemaining = new Map<number, number>();
  for (const d of deductions) if (d.kind === "fixed") recoupRemaining.set(d.id, Math.max(0, d.amountCents ?? 0));

  return ordered.map((sale) => {
    const base: SaleResult = {
      saleId: sale.id,
      bandId: sale.bandId,
      currency: sale.currency,
      netCents: sale.netCents,
      deductions: [],
      shares: [],
      ruleId: null,
      ruleSource: null,
      unallocatedCents: 0,
      problem: null,
    };
    if (sale.bandId === null) return { ...base, unallocatedCents: sale.netCents, problem: "unrouted" };

    let remaining = sale.netCents;
    for (const d of deductions) {
      if (!deductionMatches(d, sale)) continue;
      let cents = 0;
      if (d.kind === "percent") {
        const exact = (Math.abs(remaining) * (d.percentBps ?? 0)) / 10000;
        cents = Math.sign(remaining) * Math.round(exact);
      } else if (d.kind === "per_unit") {
        // Never more than what's left of the sale; a refund reverses it.
        const perSale = Math.max(0, d.amountCents ?? 0) * Math.max(1, Math.abs(sale.quantity ?? 1));
        cents = Math.sign(remaining) * Math.min(perSale, Math.abs(remaining));
      } else {
        if (remaining <= 0) continue; // refunds don't un-recoup costs
        const left = recoupRemaining.get(d.id) ?? 0;
        cents = Math.min(left, remaining);
        recoupRemaining.set(d.id, left - cents);
      }
      if (cents === 0) continue;
      remaining -= cents;
      base.deductions.push({
        deductionId: d.id,
        label: d.label,
        destination: d.destination,
        bandId: sale.bandId,
        cents,
      });
    }

    // Deductions paid to a person (e.g. manufacturing costs they fronted) go straight into their payout.
    const direct = new Map<number, number>();
    for (const d of base.deductions) {
      const personId = deductions.find((x) => x.id === d.deductionId)?.personId;
      if (d.destination === "person" && personId) direct.set(personId, (direct.get(personId) ?? 0) + d.cents);
    }
    const withDirect = (shares: { personId: number; cents: number; exact: number }[]) => {
      const out = new Map(shares.map((x) => [x.personId, { cents: x.cents, exact: x.exact }]));
      for (const [p, c] of direct) {
        const e = out.get(p) ?? { cents: 0, exact: 0 };
        out.set(p, { cents: e.cents + c, exact: e.exact + c });
      }
      return [...out].map(([personId, v]) => ({ personId, ...v }));
    };

    const resolved = resolveRule(sale, ctx);
    const shares = resolved
      ? allocate(
          remaining,
          [...resolved.weights].map(([personId, weight]) => ({ key: personId, weight })),
        ).map((a) => ({ personId: a.key, cents: a.cents, exact: a.cents }))
      : [];
    if (!resolved || (shares.length === 0 && remaining !== 0)) {
      return { ...base, shares: withDirect([]), unallocatedCents: remaining, problem: "no_rule" };
    }
    // The label's own share (label releases without a split) is recorded as money the label keeps.
    const labelShare = shares.find((x) => x.personId === LABEL_SHARE);
    if (labelShare && labelShare.cents !== 0) {
      base.deductions.push({ deductionId: 0, label: "Label’s share", destination: "label", bandId: sale.bandId, cents: labelShare.cents });
    }
    // Exact amounts: the people's whole-cent total, divided precisely by their weights.
    const people = shares.filter((x) => x.personId !== LABEL_SHARE);
    const peopleCents = people.reduce((a, x) => a + x.cents, 0);
    const weightOf = (id: number) => Math.max(0, resolved.weights.get(id) ?? 0);
    const peopleWeight = people.reduce((a, x) => a + weightOf(x.personId), 0);
    const peopleShares = people.map((x) => ({
      ...x,
      exact: peopleWeight > 0 ? (peopleCents * weightOf(x.personId)) / peopleWeight : x.cents,
    }));
    return { ...base, shares: withDirect(peopleShares), ruleId: resolved.ruleId, ruleSource: resolved.source };
  });
}

export type PeriodSummary = {
  currencies: string[];
  /** currency → totals */
  byCurrency: Record<
    string,
    {
      grossCents: number;
      byBand: Map<number | null, number>; // net sales per band (null = unrouted)
      byPerson: Map<number, { total: number; byBand: Map<number, number> }>;
      byDestination: Map<string, number>; // "label", "expense", "band_fund:<bandId>"
      unallocated: number;
      problems: { unrouted: number; noRule: number };
    }
  >;
};

/**
 * Round exact amounts to whole cents that add up to `total`, each within a cent of its exact
 * value. Leftover cents go to the largest fractions; ties are broken by a shuffle seeded with
 * `seed`, so the same person doesn't win every tie.
 */
export function roundToTotal<K extends number>(exact: Map<K, number>, total: number, seed: number): Map<K, number> {
  const rows = [...exact].map(([key, e]) => {
    const v = Math.round(e * 1e6) / 1e6; // absorb floating-point noise
    const floor = Math.floor(v);
    return { key, cents: floor, rem: v - floor, tie: mix(key, seed) };
  });
  let leftover = total - rows.reduce((a, r) => a + r.cents, 0);
  if (leftover > 0) {
    const order = [...rows].sort((a, b) => b.rem - a.rem || a.tie - b.tie);
    for (let i = 0; leftover > 0 && order.length; i = (i + 1) % order.length, leftover--) order[i].cents++;
  } else if (leftover < 0) {
    const order = [...rows].sort((a, b) => a.rem - b.rem || a.tie - b.tie);
    for (let i = 0; leftover < 0 && order.length; i = (i + 1) % order.length, leftover++) order[i].cents--;
  }
  return new Map(rows.map((r) => [r.key, r.cents]));
}

/** A small deterministic hash, for shuffling ties. */
function mix(a: number, b: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}

export function summarize(results: SaleResult[]): PeriodSummary {
  const byCurrency: PeriodSummary["byCurrency"] = {};
  // currency → band → the whole cents its people get, and each person's exact amount of it.
  const pools = new Map<string, Map<number, { cents: number; exact: Map<number, number>; seed: number }>>();
  for (const r of results) {
    const c = (byCurrency[r.currency] ??= {
      grossCents: 0,
      byBand: new Map(),
      byPerson: new Map(),
      byDestination: new Map(),
      unallocated: 0,
      problems: { unrouted: 0, noRule: 0 },
    });
    c.grossCents += r.netCents;
    c.byBand.set(r.bandId, (c.byBand.get(r.bandId) ?? 0) + r.netCents);
    for (const d of r.deductions) {
      if (d.destination === "person") continue; // already in that person's shares
      const key = d.destination === "band_fund" ? `band_fund:${d.bandId}` : d.destination;
      c.byDestination.set(key, (c.byDestination.get(key) ?? 0) + d.cents);
    }
    if (r.bandId !== null && r.shares.length) {
      const bands = pools.get(r.currency) ?? new Map();
      pools.set(r.currency, bands);
      const pool = bands.get(r.bandId) ?? { cents: 0, exact: new Map<number, number>(), seed: r.bandId };
      bands.set(r.bandId, pool);
      pool.seed = mix(pool.seed, r.saleId);
      for (const s of r.shares) {
        pool.cents += s.cents;
        pool.exact.set(s.personId, (pool.exact.get(s.personId) ?? 0) + s.exact);
      }
    }
    c.unallocated += r.unallocatedCents;
    if (r.problem === "unrouted") c.problems.unrouted++;
    if (r.problem === "no_rule") c.problems.noRule++;
  }
  // Round once per band and payout, not per sale: each person gets within a cent of their exact
  // share of the band's money, and the band's people still get exactly its total.
  for (const [cur, bands] of pools) {
    const c = byCurrency[cur];
    for (const [bandId, pool] of bands) {
      for (const [personId, cents] of roundToTotal(pool.exact, pool.cents, pool.seed)) {
        const p = c.byPerson.get(personId) ?? { total: 0, byBand: new Map<number, number>() };
        p.total += cents;
        p.byBand.set(bandId, (p.byBand.get(bandId) ?? 0) + cents);
        c.byPerson.set(personId, p);
      }
    }
  }
  return { currencies: Object.keys(byCurrency).sort(), byCurrency };
}
