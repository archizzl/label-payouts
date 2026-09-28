import { Money } from "@/components/ui";
import type { periodView } from "@/server/period-view";

type View = NonNullable<Awaited<ReturnType<typeof periodView>>>;

/**
 * One band's earnings statement for a finalized payout: its sales, what came off them, and who was
 * paid what. Printable: each statement starts on a new page.
 */
export function BandStatement({ view, bandId }: { view: View; bandId: number }) {
  const { period, live, names } = view;
  const results = live.results.filter((r) => r.bandId === bandId);
  const currencies = [...new Set(results.map((r) => r.currency))].sort();
  return (
    <article className="mb-10 rounded-lg border border-border bg-surface p-6 break-after-page print:border-0 print:p-0">
      <header className="mb-6">
        <p className="text-sm text-muted">Earnings statement</p>
        <h1 className="text-2xl font-semibold">{names.band.get(bandId)}</h1>
        <p className="text-sm text-muted">
          {period.name} · {period.startDate} to {period.endDate}
        </p>
      </header>
      {currencies.map((cur) => {
        const rs = results.filter((r) => r.currency === cur);
        const items = new Map<string, { label: string; count: number; net: number }>();
        for (const r of rs) {
          const s = live.saleById.get(r.saleId)!;
          const label = s.trackId
            ? `${names.track.get(s.trackId)} (track)`
            : s.releaseId
              ? `${names.release.get(s.releaseId)}${s.category === "merch" ? ` · ${s.itemName}` : ""}`
              : s.itemName;
          const k = `${label}|${s.category}`;
          const it = items.get(k) ?? { label: `${label}`, count: 0, net: 0 };
          it.count += Math.max(1, s.quantity) * Math.sign(r.netCents || 1);
          it.net += r.netCents;
          items.set(k, it);
        }
        const deductions = new Map<string, number>();
        for (const r of rs) {
          for (const d of r.deductions) {
            // Costs paid to a person show here and are also part of that person's amount below.
            const personId = d.destination === "person" ? view.deductionPerson.get(d.deductionId) : undefined;
            const key = personId ? `${d.label} (paid to ${names.person.get(personId)}, included below)` : d.label;
            deductions.set(key, (deductions.get(key) ?? 0) + d.cents);
          }
        }
        // Same rounded amounts as the payout (rounded once per band, not per sale).
        const people = new Map<number, number>();
        for (const [personId, p] of live.summary.byCurrency[cur]?.byPerson ?? []) {
          const cents = p.byBand.get(bandId);
          if (cents) people.set(personId, cents);
        }
        const net = rs.reduce((a, r) => a + r.netCents, 0);
        const unallocated = rs.reduce((a, r) => a + r.unallocatedCents, 0);
        return (
          <section key={cur} className="mb-8">
            {currencies.length > 1 && <h2 className="mb-2 font-medium">{cur}</h2>}
            <table className="data mb-4">
              <thead>
                <tr>
                  <th>Sales</th>
                  <th className="num">Qty</th>
                  <th className="num">Net</th>
                </tr>
              </thead>
              <tbody>
                {[...items.values()]
                  .sort((a, b) => b.net - a.net)
                  .map((it) => (
                    <tr key={it.label}>
                      <td>{it.label}</td>
                      <td className="num">{it.count}</td>
                      <td className="num">
                        <Money cents={it.net} currency={cur} />
                      </td>
                    </tr>
                  ))}
                <tr>
                  <td className="font-medium">Total net sales (after Bandcamp &amp; payment fees)</td>
                  <td />
                  <td className="num font-medium">
                    <Money cents={net} currency={cur} />
                  </td>
                </tr>
                {[...deductions].map(([label, cents]) => (
                  <tr key={label}>
                    <td className="text-muted">Less: {label}</td>
                    <td />
                    <td className="num text-muted">
                      <Money cents={-cents} currency={cur} />
                    </td>
                  </tr>
                ))}
                {unallocated !== 0 && (
                  <tr>
                    <td className="text-bad">Not yet allocated</td>
                    <td />
                    <td className="num text-bad">
                      <Money cents={-unallocated} currency={cur} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <table className="data">
              <thead>
                <tr>
                  <th>Paid to</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {[...people]
                  .sort((a, b) => b[1] - a[1])
                  .map(([pid, cents]) => (
                    <tr key={pid}>
                      <td>{names.person.get(pid)}</td>
                      <td className="num font-medium">
                        <Money cents={cents} currency={cur} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </article>
  );
}
