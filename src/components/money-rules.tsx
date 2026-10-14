import Link from "next/link";
import { Money } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { salePartLabel } from "@/lib/sale-parts";
import { possessive } from "@/lib/plural";
import { type ItemCategory } from "@/lib/bandcamp-csv";
import { computeLedger, type EngineSale, LABEL_SHARE, type RuleSource, type SaleResult } from "@/lib/splits";
import { loadEngineContext } from "@/server/data";

/*
 * A band's money rules in one place, as shares of each sale: what comes off first (the label's cut,
 * band funds, per-item costs), then who gets the rest. Worked out by running a sale through the
 * same engine payouts use, so it can't disagree with them. Each line points to where it's changed.
 */

/** The sale the shares are worked out on (never shown: only the percentages are). */
const BASE = 10000;

const SOURCE: Record<RuleSource, string> = {
  track: "Track’s own split",
  release: "Release’s own split",
  album_average: "Album’s track splits",
  band_item_type: "Band’s split for this kind of item",
  band_default: "Band’s split",
  label_default: "Label-wide split",
  outside_artist: "Outside artist’s contact",
  label_keeps: "Label keeps it",
};

const WHERE: Record<string, string> = { label: "kept by the label", band_fund: "into the band fund", expense: "held back for costs", person: "paid to" };

type Example = { category: ItemCategory; label: string; result: SaleResult };

export async function MoneyRules({
  orgId,
  bandId,
  bandName,
  personName,
  labelAccount,
  ownSplits,
}: {
  orgId: string;
  bandId: number;
  bandName: string;
  personName: Map<number, string>;
  labelAccount: boolean;
  /** How many of its releases have their own split. */
  ownSplits: number;
}) {
  const ctx = await loadEngineContext(orgId);
  // Recoupable costs take whole sales until they're paid back, which would hide the usual split:
  // show the split without them, and list them separately.
  const recoupable = ctx.deductions.filter((d) => d.kind === "fixed" && (d.bandId === null || d.bandId === bandId));
  const steady = { ...ctx, deductions: ctx.deductions.filter((d) => d.kind !== "fixed") };
  const today = new Date().toISOString().slice(0, 10);
  const sale = (category: ItemCategory, id: number): EngineSale => ({
    id,
    date: today,
    bandId,
    releaseId: null,
    trackId: null,
    category,
    currency: "USD",
    netCents: BASE,
    quantity: 1,
    format: category === "merch" ? "merch" : "",
    parts: {},
  });
  const kinds: { category: ItemCategory; label: string }[] = [
    { category: "album", label: "Digital albums" },
    { category: "track", label: "Digital tracks" },
    { category: "merch", label: "Merch and physical formats" },
  ];
  const results = computeLedger(
    kinds.map((k, i) => sale(k.category, -(i + 1))),
    steady,
  );
  const examples: Example[] = kinds.map((k, i) => ({ ...k, result: results.find((r) => r.saleId === -(i + 1))! }));
  // Only show a second (or third) example when it comes out differently.
  const sig = (r: SaleResult) => JSON.stringify([r.deductions.map((d) => [d.label, d.cents]), r.shares.map((s) => [s.personId, s.cents]), r.unallocatedCents]);
  const distinct = examples.filter((e, i) => examples.findIndex((x) => sig(x.result) === sig(e.result)) === i);

  const who = (personId: number) => (personId === LABEL_SHARE ? "the label" : (personName.get(personId) ?? "someone"));

  return (
    <div className="space-y-5">
      {distinct.map((e) => {
        const r = e.result;
        const what = distinct.length > 1 ? (distinct.length === kinds.length || e !== distinct[0] ? e.label : "Most sales") : "Every sale";
        const pct = (cents: number, of = BASE) => `${Math.round((cents / of) * 1000) / 10}%`;
        const taken = r.deductions.filter((d) => d.cents);
        // What's left once everything that comes off has: the people share that.
        const rest = BASE - taken.reduce((a, d) => a + d.cents, 0);
        /** A deduction as it was set up: "30%", "10% of what's left", "$3.42 per item"… */
        const amount = (d: SaleResult["deductions"][number], i: number) => {
          const def = ctx.deductions.find((x) => x.id === d.deductionId);
          if (def?.kind === "percent") return `${(def.percentBps ?? 0) / 100}%${i > 0 ? " of what’s left" : ""}`;
          if (def?.kind === "per_unit") return `${formatCents(def.amountCents ?? 0, def.currency ?? "USD")} per item`;
          if (def?.kind === "sale_part") return salePartLabel(def.salePart).toLowerCase();
          return pct(d.cents);
        };
        return (
          <div key={e.category} className="border border-border bg-surface-2 p-4 text-sm">
            <p className="mb-2 font-medium">{what}, after Bandcamp’s fees:</p>
            <ul className="space-y-1">
              {taken.map((d, i) => (
                <li key={i} className="flex justify-between gap-4">
                  <span>
                    {d.label} <span className="text-muted">({WHERE[d.destination] ?? d.destination})</span>
                  </span>
                  <span className="tabular-nums">{amount(d, i)}</span>
                </li>
              ))}
              {taken.length > 0 && r.shares.length > 0 && <li className="pt-1 text-xs text-muted">Then what’s left is shared:</li>}
              {r.shares.map((s) => (
                <li key={s.personId} className="flex justify-between gap-4">
                  <span>{who(s.personId)}</span>
                  <span className="tabular-nums">{pct(s.cents, rest)}</span>
                </li>
              ))}
              {r.unallocatedCents > 0 && (
                <li className="flex justify-between gap-4 text-bad">
                  <span>Nobody: there’s no split, so this can’t be paid yet</span>
                  <span className="tabular-nums">{pct(r.unallocatedCents, rest)}</span>
                </li>
              )}
            </ul>
            {r.ruleSource && <p className="mt-2 text-xs text-muted">{SOURCE[r.ruleSource]}</p>}
          </div>
        );
      })}

      <ul className="space-y-1.5 text-sm text-muted">
        <li>
          Set in <a href="#default-split">{possessive(bandName)} split</a>, <a href="#item-type-splits">splits for a kind of item</a>
          {labelAccount ? ", " : " and "}
          <a href="#band-deductions">band funds and costs</a>
          {labelAccount && (
            <>
              {" "}and <Link href="/rules">Rules</Link>
            </>
          )}
          .
        </li>
        {ownSplits > 0 && (
          <li>
            {ownSplits === 1 ? "1 release has its" : `${ownSplits} releases have their`} own split: see the <Link href="?tab=catalog">Catalog tab</Link>.
          </li>
        )}
        {recoupable.length > 0 && (
          <li>
            Recoupable costs:{" "}
            {recoupable.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ", "}
                {d.label} (<Money cents={d.amountCents ?? 0} currency={d.currency ?? "USD"} />)
              </span>
            ))}
            .
          </li>
        )}
      </ul>
    </div>
  );
}
