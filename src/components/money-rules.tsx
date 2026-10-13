import Link from "next/link";
import { Money } from "@/components/ui";
import { possessive } from "@/lib/plural";
import { type ItemCategory } from "@/lib/bandcamp-csv";
import { computeLedger, type EngineSale, LABEL_SHARE, type RuleSource, type SaleResult } from "@/lib/splits";
import { loadEngineContext } from "@/server/data";

/*
 * A band's money rules in one place, as what happens to an example sale: what comes off first
 * (the label's cut, band funds, per-item costs), then who gets the rest. It runs the same engine
 * payouts use, so it can't disagree with them. Each line points to where it's changed.
 */

const EXAMPLE = 1000;

const SOURCE: Record<RuleSource, string> = {
  track: "the track’s own split",
  release: "the release’s own split",
  album_average: "the album’s tracks’ splits",
  band_item_type: "the band’s split for this kind of item",
  band_default: "the band’s split",
  label_default: "the label-wide split",
  outside_artist: "the outside artist’s contact",
  label_keeps: "the label keeps it (the label’s own releases)",
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
    netCents: EXAMPLE,
    quantity: 1,
    format: category === "merch" ? "merch" : "",
    parts: {},
  });
  const kinds: { category: ItemCategory; label: string }[] = [
    { category: "album", label: "a digital album" },
    { category: "track", label: "a digital track" },
    { category: "merch", label: "merch or a physical format" },
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
        const names = distinct.length > 1 ? (distinct.length === kinds.length ? e.label : e === distinct[0] ? "most sales" : e.label) : "every sale";
        return (
          <div key={e.category} className="border border-border bg-surface-2 p-4 text-sm">
            <p className="mb-2 font-medium">
              <Money cents={EXAMPLE} currency="USD" /> from {names} of {bandName}, after Bandcamp’s fees:
            </p>
            <ul className="space-y-1">
              {r.deductions
                .filter((d) => d.cents)
                .map((d, i) => (
                  <li key={i} className="flex justify-between gap-4">
                    <span>
                      − {d.label} <span className="text-muted">({WHERE[d.destination] ?? d.destination})</span>
                    </span>
                    <Money cents={d.cents} currency="USD" />
                  </li>
                ))}
              {r.shares.map((s) => (
                <li key={s.personId} className="flex justify-between gap-4">
                  <span>→ {who(s.personId)}</span>
                  <Money cents={s.cents} currency="USD" />
                </li>
              ))}
              {r.unallocatedCents > 0 && (
                <li className="flex justify-between gap-4 text-bad">
                  <span>Nobody: there’s no split, so this can’t be paid yet</span>
                  <Money cents={r.unallocatedCents} currency="USD" />
                </li>
              )}
            </ul>
            {r.ruleSource && <p className="mt-2 text-xs text-muted">Split by {SOURCE[r.ruleSource]}.</p>}
          </div>
        );
      })}

      <ul className="space-y-1.5 text-sm text-muted">
        {labelAccount && (
          <li>
            What the label keeps is set in <Link href="/rules#label-cut">Label rules</Link>; band funds and costs for {bandName} are under{" "}
            <a href="#band-deductions">Band funds and costs</a> below.
          </li>
        )}
        <li>
          The split is <a href="#default-split">{possessive(bandName)} split</a>
          {labelAccount && (
            <>
              {" "}(or, without one, the <Link href="/rules">label-wide split</Link>)
            </>
          )}
          , unless a <a href="#item-type-splits">split for a kind of item</a> or a release’s own split applies.
        </li>
        {ownSplits > 0 && (
          <li>
            {ownSplits === 1 ? "One release has" : `${ownSplits} releases have`} their own split: see the{" "}
            <Link href="?tab=catalog">Catalog tab</Link>.
          </li>
        )}
        {recoupable.length > 0 && (
          <li>
            Recoupable costs come off sales first until they’re paid back:{" "}
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
