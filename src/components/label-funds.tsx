import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, Disclosure, Empty, Field, Money, MoneyList } from "@/components/ui";
import { db, schema } from "@/db";
import { centsToDecimal } from "@/lib/money";
import { deleteLabelTransfer, saveLabelTransfer } from "@/server/actions";
import { eq } from "drizzle-orm";
import { getContext } from "@/server/context";
import { labelFunds, nameMaps } from "@/server/data";
import { incomeSources, labelIncome } from "@/server/label-income";
import { type SourceInfo, SourceSelect } from "./source-select";

type Transfer = typeof schema.labelTransfers.$inferSelect;

async function TransferForm({ transfer, bandId, sources }: { transfer?: Transfer; bandId?: number; sources: SourceInfo[] }) {
  const { orgId } = await getContext();
  const [bands, releases] = await Promise.all([
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(schema.bands.name),
    db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId)).orderBy(schema.releases.title),
  ]);
  // Keep a source that's since been renamed or removed selectable when editing.
  const sourceOptions: SourceInfo[] =
    transfer?.source && !sources.some((x) => x.label === transfer.source)
      ? [...sources, { label: transfer.source, bandId: null, releaseId: null, remainingCents: null, currency: null, lastRecipient: null, lastMethod: null }]
      : sources;
  const today = new Date().toLocaleDateString("en-CA"); // local yyyy-mm-dd
  const forBand = transfer?.bandId ?? bandId ?? null;
  return (
    <ActionForm action={saveLabelTransfer} className="grid gap-4 sm:grid-cols-3">
      {transfer && <input type="hidden" name="id" value={transfer.id} />}
      <Field label="Sent to" hint="A charity, aid group, venue, anyone outside the label.">
        <input name="recipient" required defaultValue={transfer?.recipient} placeholder="Mutual Aid NYC" />
      </Field>
      <Field label="Amount">
        <span className="flex gap-2">
          <input name="amount" required inputMode="decimal" defaultValue={transfer ? centsToDecimal(transfer.amountCents) : ""} placeholder="250.00" />
          <input name="currency" defaultValue={transfer?.currency ?? "USD"} className="!w-20" aria-label="Currency" />
        </span>
      </Field>
      <Field label="Date sent">
        <input name="date" type="date" required defaultValue={transfer?.date ?? today} />
      </Field>
      <Field label="From (optional)" hint="Which of the label’s money it came out of. A fundraiser fills in its band and release for you.">
        <SourceSelect sources={sourceOptions} defaultValue={transfer?.source ?? ""} />
      </Field>
      <Field label="Raised by (optional)" hint="The band whose sales this money came from.">
        <select name="bandId" defaultValue={forBand ?? ""}>
          <option value="">Not tied to a band</option>
          {bands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="From release (optional)" hint="e.g. the fundraiser release. Shows what it raised against what was sent.">
        <select name="releaseId" defaultValue={transfer?.releaseId ?? ""}>
          <option value="">No specific release</option>
          {bands
            .filter((b) => !bandId || b.id === bandId)
            .map((b) => (
              <optgroup key={b.id} label={b.name}>
                {releases
                  .filter((r) => r.bandId === b.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
              </optgroup>
            ))}
        </select>
      </Field>
      <Field label="How (optional)">
        <input name="method" list="transfer-methods" defaultValue={transfer?.method ?? ""} placeholder="Bank transfer" />
      </Field>
      <Field label="Reference (optional)" hint="Transaction or check number.">
        <input name="reference" defaultValue={transfer?.reference ?? ""} />
      </Field>
      <Field label="Note (optional)" className="sm:col-span-2">
        <input name="note" defaultValue={transfer?.note ?? ""} placeholder="Proceeds from the benefit show livestream" />
      </Field>
      <datalist id="transfer-methods">
        <option value="Bank transfer" />
        <option value="PayPal" />
        <option value="Check" />
        <option value="Venmo" />
        <option value="Cash" />
      </datalist>
      <div className="sm:col-span-3">
        <SubmitButton>{transfer ? "Save" : "Record it"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** Each income source, with what picking it can fill in: what's still there, and who it went to last time. */
async function sourceDetails(orgId: string): Promise<SourceInfo[]> {
  const [sources, income, transfers] = await Promise.all([
    incomeSources(orgId),
    labelIncome(orgId),
    db.select().from(schema.labelTransfers).where(eq(schema.labelTransfers.orgId, orgId)),
  ]);
  const cur = income.currencies[0] ?? "USD";
  const latest = [...transfers].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  return sources.map((s) => {
    const last = latest.find((t) => t.source === s.label);
    const came = income.bySource.get(s.label)?.get(cur) ?? 0;
    const sent = income.sentBySource.get(s.label)?.get(cur) ?? 0;
    return {
      ...s,
      remainingCents: came ? came - sent : null,
      currency: cur,
      lastRecipient: last?.recipient ?? null,
      lastMethod: last?.method ?? null,
    };
  });
}

/**
 * The label's own money and where it went: kept from sales, sent on to others (fundraisers,
 * donations), and what's left. With `bandId`, only transfers raised by that band.
 */
export async function LabelFunds({ bandId, showTotals = true }: { bandId?: number; showTotals?: boolean }) {
  const { orgId } = await getContext();
  const [funds, names, sources] = await Promise.all([labelFunds(orgId), nameMaps(orgId), sourceDetails(orgId)]);
  const transfers = bandId ? funds.transfers.filter((t) => t.bandId === bandId) : funds.transfers;
  const causes = bandId ? funds.causes.filter((c) => c.bandId === bandId) : funds.causes;
  const causeName = (c: { bandId: number | null; releaseId: number | null }) =>
    [c.bandId && names.band.get(c.bandId), c.releaseId && names.release.get(c.releaseId)].filter(Boolean).join(" · ");
  const currencies = [...funds.balance.keys()].sort();

  return (
    <Card title={bandId ? "Label funds sent on" : showTotals ? "Label funds" : "Sent on to others"}>
      <p className="mb-4 text-sm text-muted">
        {bandId || !showTotals
          ? "Money the label kept from sales and then passed on, e.g. a fundraiser’s proceeds sent to an aid group."
          : "What the label kept from sales (its cut, label releases, anything routed to it like a fundraiser), what it passed on to others or spent (expenses it paid, people it reimbursed; see Receipts), and what’s left in its account."}
      </p>

      {!bandId &&
        showTotals &&
        currencies.map((cur) => (
          <div key={cur} className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={`Kept by the label${currencies.length > 1 ? ` (${cur})` : ""}`} cents={funds.kept.get(cur) ?? 0} currency={cur} />
            <Stat label="Sent on to others" cents={funds.sent.get(cur) ?? 0} currency={cur} />
            <Stat label="Spent on expenses" cents={funds.spent.get(cur) ?? 0} currency={cur} />
            <Stat label="Left in the label’s account" cents={funds.balance.get(cur) ?? 0} currency={cur} emphasis />
          </div>
        ))}

      {causes.length > 0 && (
        <div className="mb-6 overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Raised by</th>
                <th className="num">Kept by the label</th>
                <th className="num">Sent on</th>
                <th className="num">Still holding</th>
              </tr>
            </thead>
            <tbody>
              {causes.map((c) => {
                const holding = new Map<string, number>();
                for (const cur of new Set([...c.raised.keys(), ...c.sent.keys()])) holding.set(cur, (c.raised.get(cur) ?? 0) - (c.sent.get(cur) ?? 0));
                return (
                  <tr key={`${c.bandId}-${c.releaseId}`}>
                    <td>
                      {c.releaseId ? <Link href={`/catalog/${c.releaseId}`}>{causeName(c)}</Link> : c.bandId ? <Link href={`/bands/${c.bandId}`}>{causeName(c)}</Link> : "—"}
                    </td>
                    <td className="num">
                      <MoneyList totals={c.raised} />
                    </td>
                    <td className="num">
                      <MoneyList totals={c.sent} />
                    </td>
                    <td className="num">
                      <MoneyList totals={holding} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            “Kept by the label” counts every sale where money went to the label: its cut, or all of it if a release is set up that way
            (a 100% “kept by the label” deduction on the band page). A negative “still holding” means the label sent more than those
            sales brought in.
          </p>
        </div>
      )}

      {transfers.length === 0 ? (
        <Empty>Nothing sent out yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>Sent to</th>
                <th>From</th>
                <th className="num">Amount</th>
                <th>How</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap text-muted">{t.date}</td>
                  <td>
                    <div className="font-medium">{t.recipient}</div>
                    {t.note && <div className="text-xs text-muted">{t.note}</div>}
                  </td>
                  <td className="text-sm">
                    {t.source ?? (causeName(t) ? null : <span className="text-muted">—</span>)}
                    {causeName(t) && <div className={t.source ? "text-xs text-muted" : ""}>{causeName(t)}</div>}
                  </td>
                  <td className="num font-medium">
                    <Money cents={t.amountCents} currency={t.currency} />
                  </td>
                  <td className="text-xs text-muted">{[t.method, t.reference].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="text-right">
                    <div className="flex items-start justify-end gap-2">
                      <Disclosure summary="Edit">
                        <TransferForm transfer={t} sources={sources} />
                        <form action={deleteLabelTransfer} className="mt-3 border-t border-border pt-3">
                          <input type="hidden" name="id" value={t.id} />
                          <SubmitButton variant="danger" size="sm" confirm={`Delete the ${centsToDecimal(t.amountCents)} ${t.currency} sent to ${t.recipient}?`}>
                            Delete
                          </SubmitButton>
                        </form>
                      </Disclosure>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4">
        <Disclosure summary="+ Record money sent out">
          <TransferForm bandId={bandId} sources={sources} />
        </Disclosure>
      </div>
    </Card>
  );
}

function Stat({ label, cents, currency, emphasis }: { label: string; cents: number; currency: string; emphasis?: boolean }) {
  return (
    <div className={`border-l-2 pl-3 ${emphasis ? "border-accent" : "border-border"}`}>
      <div className="text-xs text-muted lowercase">{label}</div>
      <div className={`mt-0.5 text-xl font-bold ${emphasis ? "text-accent" : ""}`}>
        <Money cents={cents} currency={currency} />
      </div>
    </div>
  );
}
