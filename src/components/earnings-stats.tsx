import { Money, MoneyList } from "@/components/ui";
import { addTotals } from "@/server/earnings";

type Totals = Map<string, number>;

/**
 * Someone's earnings in three figures: what they've earned since their last payout (in a payout
 * not paid yet, or in none yet), what they've been paid, and both together.
 */
export function EarningsStats({ owed, received, upcoming }: { owed: Totals; received: Totals; upcoming: Totals }) {
  const since = addTotals(owed, upcoming);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Stat label="Earned since last payout" totals={since} emphasis />
      <Stat label="Paid so far" totals={received} />
      <Stat label="Earned total" totals={addTotals(since, received)} />
    </div>
  );
}

function Stat({ label, totals, emphasis }: { label: string; totals: Totals; emphasis?: boolean }) {
  return (
    <div className={`border-l-2 pl-3 ${emphasis ? "border-accent" : "border-border"}`}>
      <div className="text-xs text-muted lowercase">{label}</div>
      <div className={`mt-0.5 text-xl font-bold ${emphasis ? "text-accent" : ""}`}>
        {totals.size ? <MoneyList totals={totals} /> : <Money cents={0} />}
      </div>
    </div>
  );
}
