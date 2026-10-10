import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { ActionForm, CopyButton, SubmitButton } from "@/components/client";
import { outsideArtistRows } from "@/components/outside-artists";
import { Badge, Callout, Card, Disclosure, Empty, Field, LinkButton, Money, PageHeader, buttonClass } from "@/components/ui";
import { db, schema } from "@/db";
import { centsToDecimal } from "@/lib/money";
import { formatCents } from "@/lib/money";
import { payHandlesSummary, payMethods } from "@/lib/paypal-export";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { finalizePayout, markAllPaid, resyncPreview, setPayoutStatus, undoFinalize } from "@/server/actions";
import { bandcampCredentials } from "@/server/bandcamp-api";
import { getContext } from "@/server/context";
import { type PayoutScope, payoutNote, type periodView, type previewView } from "@/server/period-view";
import { PayQueue, type QueueItem } from "./pay-queue";

type View = NonNullable<Awaited<ReturnType<typeof periodView>>> | Awaited<ReturnType<typeof previewView>>;

/** The band and dates of a payout, as hidden fields for forms that act on a preview. */
function ScopeFields({ scope }: { scope: PayoutScope }) {
  return (
    <>
      {scope.bandId && <input type="hidden" name="bandId" value={scope.bandId} />}
      <input type="hidden" name="startDate" value={scope.startDate} />
      <input type="hidden" name="endDate" value={scope.endDate} />
    </>
  );
}

/**
 * One payout, either a preview (nothing stored yet; `view.period` is null) or a finalized payout
 * with its locked amounts and who's been paid.
 */
export async function PayoutView({
  view,
  name,
  sync,
}: {
  view: View;
  name: string;
  sync?: { synced: number | null; error: string | null };
}) {
  const { period, scope, live, lines, bands, names, problems, drift, finalized } = view;
  const id = period?.id ?? null;
  const bandName = (bid: number | null) => (bid === null ? "Unrouted" : (names.band.get(bid) ?? `#${bid}`));
  const currencies = live.summary.currencies;
  const pending = lines.filter((l) => l.status === "pending" && l.amountCents > 0);
  const { orgId } = await getContext();
  const [outside, labelBandRows, canSync] = await Promise.all([
    outsideArtistRows(orgId),
    db
      .select({ id: schema.bands.id })
      .from(schema.bands)
      .where(and(eq(schema.bands.orgId, orgId), eq(schema.bands.isLabel, true))),
    bandcampCredentials(orgId).then(Boolean),
  ]);
  const needContacts = outside.filter((r) => r.needsContact).length;
  // Bands whose own sales lack a split. The label's band keeps its money by default, so a problem
  // there is always a missing outside-artist contact, not a missing split.
  const labelBands = new Set(labelBandRows.map((b) => b.id));
  const splitlessBands = problems.noRuleBands.filter((b) => !labelBands.has(b));
  // Whoever holds the label's account is never sent money, so doesn't need PayPal details.
  const missingPaypal = lines.filter(
    (l) => l.amountCents > 0 && !l.holdsLabelAccount && l.status !== "kept" && !l.email && !payHandlesSummary(l),
  );
  // One-click payment links (PayPal.me, Venmo, Cash App) with the amount and a note filled in.
  const methodsFor = (l: (typeof lines)[number]) =>
    payMethods(l, l.amountCents, l.currency, period ? payoutNote(period.name, l, (b) => bandName(b)) : name);
  const queue: QueueItem[] = pending
    .filter((l) => l.payoutId !== null)
    .map((l) => ({
      payoutId: l.payoutId!,
      name: l.name,
      amount: formatCents(l.amountCents, l.currency),
      email: l.email,
      methods: methodsFor(l),
    }));
  const holderLine = lines.find((l) => l.holdsLabelAccount && l.amountCents > 0 && (!finalized || l.status === "kept"));

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {name}{" "}
            {period ? <Badge tone={STATUS_TONE[period.status]}>{STATUS_LABEL[period.status]}</Badge> : <Badge>Preview</Badge>}
          </span>
        }
        subtitle={
          <>
            {scope.bandId ? (
              <>
                <Link href={`/bands/${scope.bandId}`}>{bandName(scope.bandId)}</Link> only
              </>
            ) : (
              "whole label"
            )}{" "}
            · {scope.startDate} → {scope.endDate} · {live.results.length} sales
          </>
        }
        actions={
          id !== null ? (
            <>
              <LinkButton href={`/periods/${id}/statement`} size="sm">
                Printable statements
              </LinkButton>
              <form action={undoFinalize}>
                <input type="hidden" name="id" value={id} />
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  confirm="Undo finalizing? This payout's records, including who's been marked paid, are removed, and it goes back to being a preview."
                >
                  Undo finalize
                </SubmitButton>
              </form>
            </>
          ) : (
            <>
              {canSync && (
                <form action={resyncPreview}>
                  <ScopeFields scope={scope} />
                  <input type="hidden" name="name" value={name} />
                  <SubmitButton variant="secondary" size="sm">
                    Sync from Bandcamp
                  </SubmitButton>
                </form>
              )}
              <LinkButton href={`/periods${scope.bandId ? `?band=${scope.bandId}` : ""}`} size="sm" variant="ghost">
                Cancel
              </LinkButton>
            </>
          )
        }
      />

      {!finalized && (
        <Callout tone="neutral">
          This is a preview: nothing is saved until you finalize it below. Leave the page and it’s gone.
        </Callout>
      )}
      {sync?.error ? (
        <Callout tone="bad">
          Couldn’t get the latest sales from Bandcamp ({sync.error}). This preview uses the sales imported so far; try{" "}
          <b>Sync from Bandcamp</b> again before finalizing.
        </Callout>
      ) : sync?.synced != null ? (
        <Callout tone="good">
          {sync.synced > 0 ? (
            <>
              Synced with Bandcamp first: {sync.synced} new sale{sync.synced === 1 ? "" : "s"} imported (see{" "}
              <Link href="/sales/import">Import sales</Link>).
            </>
          ) : (
            "Synced with Bandcamp first: no new sales, you’re up to date."
          )}
        </Callout>
      ) : null}

      {live.alreadyPaid.length > 0 && (
        <Callout tone="neutral">
          Left out because they were already paid:{" "}
          {live.alreadyPaid.map((a, i) => (
            <span key={a.period.id}>
              {i > 0 && ", "}
              {a.sales} sale{a.sales === 1 ? "" : "s"} in <Link href={`/periods/${a.period.id}`}>{a.period.name}</Link>
            </span>
          ))}
          .
        </Callout>
      )}
      {problems.unrouted > 0 && (
        <Callout tone="bad">
          {problems.unrouted} sale(s) aren’t matched to a band yet.{" "}
          <Link href="/sales/import" className="underline">
            Assign them on the Import page
          </Link>
          .
        </Callout>
      )}
      {problems.noRule > 0 && (
        <Callout tone="bad">
          {problems.noRule} sale(s) can’t be paid yet.{" "}
          {needContacts > 0 && (
            <>
              {needContacts} artist{needContacts === 1 ? "" : "s"} outside the label still need{needContacts === 1 ? "s" : ""} a{" "}
              <Link href="/catalog#outside-artists" className="underline">
                contact
              </Link>
              .{" "}
            </>
          )}
          {splitlessBands.length > 0 && (
            <>
              Set a{" "}
              <Link href="/rules" className="underline">
                label-wide default
              </Link>{" "}
              (and make sure the band has members), or a default split for{" "}
              {splitlessBands.map((b, i) => (
                <span key={b}>
                  {i > 0 && ", "}
                  <Link href={`/bands/${b}`} className="underline">
                    {bandName(b)}
                  </Link>
                </span>
              ))}
              .
            </>
          )}
        </Callout>
      )}
      {drift && (
        <Callout>
          Splits, deductions or sales have changed since this payout was finalized. The amounts below are the finalized ones; the band
          breakdown shows the current calculation. Undo finalize and finalize again to update.
        </Callout>
      )}
      {missingPaypal.length > 0 && (
        <Callout>
          No payment details for {missingPaypal.map((l) => l.name).join(", ")}.{" "}
          <Link href="/people" className="underline">
            Add them on the People page
          </Link>
          .
        </Callout>
      )}

      {currencies.length === 0 && (
        <Card>
          <Empty>
            No sales to pay in these dates.{" "}
            <Link href="/sales/import" className="underline">
              Import a sales report
            </Link>{" "}
            first, or pick other dates.
          </Empty>
        </Card>
      )}

      {currencies.map((cur) => {
        const s = live.summary.byCurrency[cur];
        const dest = (k: string) => [...s.byDestination].filter(([key]) => key === k || key.startsWith(`${k}:`)).reduce((a, [, v]) => a + v, 0);
        const toPeople = [...s.byPerson.values()].reduce((a, p) => a + p.total, 0);
        return (
          <div key={cur} className="mb-8 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-5">
            <Stat label={`Net sales${currencies.length > 1 ? ` (${cur})` : ""}`} cents={s.grossCents} currency={cur} />
            <Stat label="Label" cents={dest("label")} currency={cur} />
            <Stat label="Band funds" cents={dest("band_fund")} currency={cur} />
            <Stat label="Expenses recouped" cents={dest("expense")} currency={cur} />
            <Stat label="To people" cents={toPeople} currency={cur} emphasis />
            {s.unallocated !== 0 && <Stat label="Unallocated" cents={s.unallocated} currency={cur} tone="bad" />}
          </div>
        );
      })}

      {bands.length > 0 && (
        <Card title="By band">
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Band</th>
                  <th className="num">Sales</th>
                  <th className="num">Net</th>
                  <th className="num">Label</th>
                  <th className="num">Band fund</th>
                  <th className="num">Expenses</th>
                  <th className="num">To members</th>
                  {id !== null && <th />}
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => (
                  <tr key={`${b.bandId}|${b.currency}`}>
                    <td className={b.bandId === null ? "text-bad" : "font-medium"}>{bandName(b.bandId)}</td>
                    <td className="num">{b.saleCount}</td>
                    <td className="num">
                      <Money cents={b.netCents} currency={b.currency} />
                    </td>
                    <td className="num">
                      <Money cents={b.labelCents} currency={b.currency} />
                    </td>
                    <td className="num">
                      <Money cents={b.bandFundCents} currency={b.currency} />
                    </td>
                    <td className="num">
                      <Money cents={b.expenseCents} currency={b.currency} />
                    </td>
                    <td className="num">
                      <Money cents={b.peopleCents} currency={b.currency} />
                      {b.unallocatedCents !== 0 && (
                        <div className="text-xs text-bad">
                          + <Money cents={b.unallocatedCents} currency={b.currency} /> unallocated
                        </div>
                      )}
                    </td>
                    {id !== null && (
                      <td className="text-right">
                        {b.bandId !== null && (
                          <Link href={`/periods/${id}/statement?band=${b.bandId}`} className="text-xs">
                            statement
                          </Link>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card
        title={finalized ? "Pay people" : "What each person gets"}
        actions={
          id !== null && (
            <>
              <a href={`/periods/${id}/export/paypal-bulk`} className={buttonClass("primary", "sm")}>
                PayPal bulk payout file
              </a>
              <a href={`/periods/${id}/export/people`} className={buttonClass("secondary", "sm")}>
                Payout summary CSV
              </a>
            </>
          )
        }
      >
        {id !== null && queue.length > 0 && <PayQueue items={queue} />}
        {lines.length === 0 ? (
          <Empty>Nobody is owed anything for this payout.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>From</th>
                  <th className="num">Amount</th>
                  {finalized && <th>Pay</th>}
                  {finalized && <th>Status</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={`${l.personId}|${l.currency}`}>
                    <td>
                      <div className="font-medium">{l.name}</div>
                      <div className="text-xs text-muted">
                        {l.holdsLabelAccount && !finalized && l.amountCents > 0
                          ? "stays in the label’s account"
                          : [l.email, payHandlesSummary(l)].filter(Boolean).join(" · ") || "no payment details"}
                      </div>
                    </td>
                    <td className="text-xs">
                      {l.byBand.map((b) => (
                        <div key={b.bandId}>
                          {bandName(b.bandId)}: <Money cents={b.cents} currency={l.currency} />
                        </div>
                      ))}
                    </td>
                    <td className="num font-medium">
                      <Money cents={l.amountCents} currency={l.currency} />
                    </td>
                    {finalized && (
                      <td>
                        {l.amountCents > 0 && l.status === "pending" && (
                          <div className="flex flex-wrap gap-1.5">
                            {methodsFor(l).map((m, i) => (
                              <a key={m.kind} href={m.url} target="_blank" rel="noreferrer" className={buttonClass(i === 0 ? "primary" : "secondary", "sm")}>
                                {m.label} ↗
                              </a>
                            ))}
                            {l.email && <CopyButton text={l.email} label="Copy email" />}
                            <CopyButton text={centsToDecimal(l.amountCents)} label="Copy amount" />
                          </div>
                        )}
                        {l.status === "kept" && <span className="text-xs text-muted">Nothing to send</span>}
                        {l.amountCents < 0 && (
                          <span className="text-xs text-muted">Owes back (refunds). Carry it into the next payout.</span>
                        )}
                      </td>
                    )}
                    {finalized && (
                      <td>
                        <form action={setPayoutStatus} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="id" value={l.payoutId!} />
                          {l.status === "paid" ? (
                            <>
                              <Badge tone="good">Paid {l.paidAt?.slice(0, 10)}</Badge>
                              {l.reference && <span className="text-xs text-muted">{l.reference}</span>}
                              <input type="hidden" name="status" value="pending" />
                              <SubmitButton variant="ghost" size="sm" confirm="Mark this payment as not paid yet? Its paid date and reference are cleared.">
                                Undo
                              </SubmitButton>
                            </>
                          ) : l.status === "kept" ? (
                            <>
                              <Badge tone="good">Kept in label account</Badge>
                              <input type="hidden" name="status" value="pending" />
                              <SubmitButton variant="ghost" size="sm">
                                Pay out instead
                              </SubmitButton>
                            </>
                          ) : (
                            <>
                              <input type="hidden" name="status" value="paid" />
                              <input name="reference" placeholder="PayPal txn ID (optional)" className="!w-44 !py-1 !text-xs" />
                              <SubmitButton variant="secondary" size="sm">
                                Mark paid
                              </SubmitButton>
                            </>
                          )}
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {holderLine && (
          <p className="mt-3 text-xs text-muted">
            {holderLine.name} holds the label’s bank account, so their <Money cents={holderLine.amountCents} currency={holderLine.currency} />{" "}
            {finalized ? "is recorded as theirs but stays in the account" : "will be recorded as theirs but stays in the account"}: no
            PayPal payment needed. Change who holds the account on the{" "}
            <Link href="/people" className="underline">
              People page
            </Link>
            .
          </p>
        )}

        {id !== null && pending.length > 0 && (
          <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
            <p className="text-muted">
              <b>Paying everyone at once:</b> with a PayPal Business account that has Payouts turned on, go to PayPal → Pay &amp; Get
              Paid → Payouts → upload the <i>PayPal bulk payout file</i>. It includes {pending.filter((l) => l.email).length} of{" "}
              {pending.length} unpaid people (the ones with an email). Otherwise, use <b>Pay next</b> above to go through everyone.
            </p>
            <form action={markAllPaid} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="periodId" value={id} />
              <input name="reference" placeholder="Batch ID (optional)" className="!w-56" />
              <SubmitButton variant="secondary" confirm={`Mark all ${pending.length} unpaid payouts as paid?`}>
                Mark all as paid
              </SubmitButton>
            </form>
          </div>
        )}

        {!finalized && live.results.length > 0 && (
          <div className="mt-4 border-t border-border pt-4">
            <ActionForm action={finalizePayout} className="flex flex-wrap items-end gap-3">
              <ScopeFields scope={scope} />
              <Field label="Name">
                <input name="name" defaultValue={name} className="!w-72" />
              </Field>
              {(problems.unrouted > 0 || problems.noRule > 0) && (
                <label className="flex items-center gap-2 self-center text-sm">
                  <input type="checkbox" name="force" /> Finalize anyway (unallocated money stays unpaid)
                </label>
              )}
              <SubmitButton confirm="Finalize this payout? The amounts are locked in and you can start paying people.">
                Finalize &amp; get ready to pay
              </SubmitButton>
            </ActionForm>
            <p className="mt-2 text-xs text-muted">Finalizing saves the payout and locks the amounts, so later changes to splits don’t alter them.</p>
          </div>
        )}
      </Card>

      {!finalized && (
        <Card title="Dates">
          {/* Just a new preview: nothing to save. */}
          <form action="/periods/new" className="flex flex-wrap items-end gap-3">
            {scope.bandId && <input type="hidden" name="band" value={scope.bandId} />}
            <Field label="From">
              <input name="from" type="date" required defaultValue={scope.startDate} />
            </Field>
            <Field label="To">
              <input name="to" type="date" required defaultValue={scope.endDate} />
            </Field>
            <button type="submit" className={buttonClass("secondary")}>
              Update preview
            </button>
          </form>
        </Card>
      )}

      {live.results.length > 0 && (
        <Card
          title="Every sale"
          actions={
            id !== null && (
              <a href={`/periods/${id}/export/sales`} className={buttonClass("secondary", "sm")}>
                Download CSV
              </a>
            )
          }
        >
          <Disclosure summary={`Show all ${live.results.length} sales and how each was split`}>
            <p className="mb-2 text-xs text-muted">
              Each sale’s split is shown to the nearest cent. Payout amounts add up everyone’s exact shares and round once per band,
              so they can differ from these by a cent or two.
            </p>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Item</th>
                    <th>Band</th>
                    <th className="num">Net</th>
                    <th>Deductions</th>
                    <th>Split</th>
                  </tr>
                </thead>
                <tbody>
                  {live.results.map((r) => {
                    const sale = live.saleById.get(r.saleId)!;
                    return (
                      <tr key={r.saleId}>
                        <td className="whitespace-nowrap text-muted">{sale.date}</td>
                        <td>
                          <div>{sale.itemName}</div>
                          <div className="text-xs text-muted">
                            {sale.itemType}
                            {sale.releaseId && ` · ${names.release.get(sale.releaseId)}`}
                            {sale.trackId && ` › ${names.track.get(sale.trackId)}`}
                          </div>
                        </td>
                        <td className={r.bandId === null ? "text-bad" : ""}>{bandName(r.bandId)}</td>
                        <td className="num">
                          <Money cents={r.netCents} currency={r.currency} />
                        </td>
                        <td className="text-xs">
                          {r.deductions.map((d) => (
                            <div key={d.deductionId}>
                              {d.label}: <Money cents={d.cents} currency={r.currency} />
                            </div>
                          ))}
                        </td>
                        <td className="text-xs">
                          {r.problem === "no_rule" && <span className="text-bad">No split set</span>}
                          {r.problem === "unrouted" && <span className="text-bad">Not matched to a band</span>}
                          {r.ruleSource && <div className="text-muted">{r.ruleSource.replace("_", " ")} split</div>}
                          {r.shares.map((s) => (
                            <div key={s.personId}>
                              {names.person.get(s.personId)}: <Money cents={s.cents} currency={r.currency} />
                            </div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Disclosure>
        </Card>
      )}
    </>
  );
}

function Stat({ label, cents, currency, emphasis, tone }: { label: string; cents: number; currency: string; emphasis?: boolean; tone?: "bad" }) {
  return (
    <div className={`border-l-2 pl-3 ${tone === "bad" ? "border-bad" : emphasis ? "border-accent" : "border-border"}`}>
      <div className={`text-xs lowercase ${tone === "bad" ? "text-bad" : "text-muted"}`}>{label}</div>
      <div className={`mt-0.5 text-xl font-bold ${tone === "bad" ? "text-bad" : emphasis ? "text-accent" : ""}`}>
        <Money cents={cents} currency={currency} />
      </div>
    </div>
  );
}
