import type { BoardChart } from "@/lib/chart-data";
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

/** "Who's owed what": what the label still owes, band by band and to outside groups, as a chart for a board. */
export async function owedChart(orgId: string): Promise<BoardChart> {
  const rows = await owedByBand(orgId);
  const currencies = [...new Set(rows.map((r) => r.currency))];
  return {
    spec: { kind: "owed", title: "Who’s owed what", shape: "owed" },
    data: {
      shape: "owed",
      parts: PARTS,
      empty: "All sales are paid out.",
      groups: currencies.map((currency) => {
        const mine = rows.filter((r) => r.currency === currency);
        return {
          currency,
          grand: mine.reduce((a, r) => a + owedTotal(r), 0),
          whom: whom(mine),
          rows: mine.map((r) => ({
            key: r.key,
            name: r.name,
            href: r.kind === "band" && r.bandId ? `/periods?band=${r.bandId}` : undefined,
            values: [r.finalized, r.unpaid, r.receipts, r.raised],
            detail: r.people.slice(0, 5).map((p) => `${p.name}: ${formatCents(p.cents, currency)}`),
            people: r.people.map((p) => p.name),
          })),
        };
      }),
    },
  };
}
