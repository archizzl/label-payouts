import { OwedBars } from "@/components/charts";
import { Card, Disclosure, Money } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { owedByBand, owedTotal } from "@/server/owed";

const PARTS = [
  { label: "Finalized, not paid yet", color: "var(--series-1)" },
  { label: "Not in a payout yet", color: "var(--series-2)" },
  { label: "Receipts to pay back", color: "var(--series-3)" },
  { label: "Raised for a cause, not sent on", color: "var(--series-4)" },
];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "3 bands and 1 outside group" */
function whom(rows: { kind: string }[]) {
  const groups = rows.filter((r) => r.kind === "group").length;
  const bands = rows.length - groups;
  return [bands && count(bands, "band", "bands"), groups && count(groups, "outside group", "outside groups")].filter(Boolean).join(" and ");
}

/** What the label still owes, band by band and to outside groups: a chart, with the numbers in a table. */
export async function Owed({ orgId }: { orgId: string }) {
  const rows = await owedByBand(orgId);
  const currencies = [...new Set(rows.map((r) => r.currency))];

  return (
    <Card title="Who’s owed what">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody is owed anything right now: every sale is in a payout and every payout is paid.</p>
      ) : (
        currencies.map((currency) => {
          const mine = rows.filter((r) => r.currency === currency);
          const grand = mine.reduce((a, r) => a + owedTotal(r), 0);
          return (
            <div key={currency} className="mb-6 last:mb-0">
              <p className="mb-3 text-sm">
                <span className="text-2xl font-bold tabular-nums">{formatCents(grand, currency)}</span>{" "}
                <span className="text-muted">
                  owed in total{currencies.length > 1 ? ` (${currency})` : ""}, across {whom(mine)}
                </span>
              </p>
              <OwedBars
                currency={currency}
                parts={PARTS}
                rows={mine.map((r) => ({
                  key: r.key,
                  name: r.name,
                  href: r.kind === "band" && r.bandId ? `/periods?band=${r.bandId}` : undefined,
                  values: [r.finalized, r.unpaid, r.receipts, r.raised],
                  detail: r.people.slice(0, 5).map((p) => `${p.name}: ${formatCents(p.cents, currency)}`),
                }))}
              />
              <div className="mt-4">
              <Disclosure summary="Show as a table">
                <table className="data mt-2">
                  <thead>
                    <tr>
                      <th>Band or group</th>
                      {PARTS.map((p) => (
                        <th key={p.label} className="num">
                          {p.label}
                        </th>
                      ))}
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mine.map((r) => (
                      <tr key={r.key}>
                        <td>
                          {r.name}
                          {r.people.length > 0 && <div className="text-xs text-muted">{r.people.map((p) => p.name).join(", ")}</div>}
                        </td>
                        {[r.finalized, r.unpaid, r.receipts, r.raised].map((v, i) => (
                          <td key={i} className="num">
                            {v ? <Money cents={v} currency={currency} /> : <span className="text-muted">–</span>}
                          </td>
                        ))}
                        <td className="num font-medium">
                          <Money cents={owedTotal(r)} currency={currency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Disclosure>
              </div>
            </div>
          );
        })
      )}
      <p className="mt-3 text-xs text-muted">
        Click a band to start its payout. “Not in a payout yet” is what the next payout would pay out today. Money for whoever holds the label’s
        bank account isn’t counted, since it stays there. “Raised for a cause” is what the label kept from that band’s or release’s sales, minus
        what it has sent on.
      </p>
    </Card>
  );
}
