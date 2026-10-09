import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, Disclosure, Empty, Field, MoneyList, PageHeader, RolesList } from "@/components/ui";
import { db, schema } from "@/db";
import { deletePerson, mergePeopleAction, savePerson, setLabelAccountHolder } from "@/server/actions";
import { payHandlesSummary } from "@/lib/paypal-export";
import { requireAccess } from "@/server/context";
import { possibleDuplicates } from "@/server/people";

function PersonFields({ person }: { person?: typeof schema.people.$inferSelect }) {
  return (
    <form action={savePerson} className="grid gap-4 sm:grid-cols-2">
      {person && <input type="hidden" name="id" value={person.id} />}
      <Field label="Name">
        <input name="name" required defaultValue={person?.name} />
      </Field>
      <Field label="PayPal email" hint="Used for the PayPal bulk payout file.">
        <input name="email" type="email" defaultValue={person?.email ?? ""} />
      </Field>
      <Field label="PayPal.me handle" hint="For one-click PayPal links with the amount filled in, e.g. “samdrums”.">
        <input name="paypalMe" defaultValue={person?.paypalMe ?? ""} />
      </Field>
      <Field label="Venmo username" hint="US only. For one-click Venmo links with the amount and a note filled in.">
        <input name="venmo" defaultValue={person?.venmo ?? ""} placeholder="@yourname" />
      </Field>
      <Field label="Cash App $cashtag" hint="For one-click Cash App links with the amount filled in.">
        <input name="cashtag" defaultValue={person?.cashtag ?? ""} placeholder="$yourname" />
      </Field>
      <Field label="Notes">
        <input name="notes" defaultValue={person?.notes ?? ""} />
      </Field>
      <div className="sm:col-span-2">
        <SubmitButton>{person ? "Save" : "Add person"}</SubmitButton>
      </div>
    </form>
  );
}

export default async function PeoplePage() {
  await connection();
  const { orgId } = await requireAccess("roster");
  const [people, memberships, payoutRows, duplicates, outsideRows] = await Promise.all([
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
    db
      .select({ personId: schema.bandMemberships.personId, roles: schema.bandMemberships.roles, active: schema.bandMemberships.active, band: schema.bands })
      .from(schema.bandMemberships)
      .innerJoin(schema.bands, eq(schema.bands.id, schema.bandMemberships.bandId))
      .where(eq(schema.bandMemberships.orgId, orgId)),
    db.select().from(schema.payouts).where(eq(schema.payouts.orgId, orgId)),
    possibleDuplicates(orgId),
    db.select().from(schema.outsideArtists).where(eq(schema.outsideArtists.orgId, orgId)),
  ]);
  const pending = payoutRows.filter((r) => r.status === "pending");
  // Paid out, or kept in the label's account by whoever holds it: either way, it's theirs and settled.
  const paid = payoutRows.filter((r) => r.status !== "pending");
  const holder = people.find((p) => p.holdsLabelAccount);
  const sumBy = (rows: typeof pending, personId: number) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.personId === personId) m.set(r.currency, (m.get(r.currency) ?? 0) + r.amountCents);
    return m;
  };
  const contactFor = (personId: number) => outsideRows.filter((a) => a.contactPersonId === personId).map((a) => a.name);
  const bandsOf = (personId: number) =>
    memberships
      .filter((m) => m.personId === personId)
      .map((m) => m.band.name)
      .join(", ") || "no band";

  return (
    <>
      <PageHeader title="People" subtitle="Everyone who gets paid: band members, co-writers, producers. One person can be in several bands and still gets one payment." />
      {duplicates.length > 0 && (
        <Card title="Possible duplicates">
          <p className="mb-3 text-sm text-muted">
            These look like the same person entered more than once. Merging combines their bands, splits and payouts so they’re
            paid once. (People with the same email are merged automatically when you save.)
          </p>
          <ul className="space-y-4">
            {duplicates.map((group) => (
              <li key={group.map((p) => p.id).join("-")} className="space-y-1.5 border-l-2 border-accent pl-3">
                {group.map((keep) => (
                  <form key={keep.id} action={mergePeopleAction} className="flex flex-wrap items-center gap-3 text-sm">
                    <input type="hidden" name="intoId" value={keep.id} />
                    {group
                      .filter((p) => p.id !== keep.id)
                      .map((p) => (
                        <input key={p.id} type="hidden" name="fromId" value={p.id} />
                      ))}
                    <span>
                      <b>{keep.name}</b>{" "}
                      <span className="text-muted">
                        · {keep.email ?? "no email"} · {bandsOf(keep.id)}
                      </span>
                    </span>
                    <SubmitButton size="sm" variant="secondary">
                      keep this one
                    </SubmitButton>
                  </form>
                ))}
                <p className="text-xs text-muted">“Keep this one” merges the others into it.</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {people.length > 0 && (
        <Card title="Label bank account">
          <p className="mb-3 text-sm text-muted">
            Whoever the label’s bank account belongs to doesn’t need to pay themselves. Their share of each payout is recorded as
            theirs, but marked <i>kept in label account</i> instead of being sent through PayPal.
          </p>
          <form action={setLabelAccountHolder} className="flex flex-wrap items-center gap-2">
            <select key={holder?.id ?? "none"} name="personId" defaultValue={holder?.id ?? ""} className="!w-64" aria-label="Who holds the label’s bank account">
              <option value="">Nobody (pay everyone out)</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <SubmitButton variant="secondary">Save</SubmitButton>
          </form>
          <p className="mt-2 text-xs text-muted">Choosing someone also marks their unpaid payouts so far as kept.</p>
        </Card>
      )}

      <Card>
        {people.length === 0 ? (
          <Empty>No one yet. Add people here or straight from a band page.</Empty>
        ) : (
          // Rows expand full-width to edit, rather than squeezing a form into a table cell.
          <div className="text-sm">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.4fr)_5.5rem_5.5rem_3rem] gap-3 border-b border-border px-2.5 py-1.5 text-xs text-muted lowercase">
              <span>name</span>
              <span>bands &amp; roles</span>
              <span>payment</span>
              <span className="text-right">owed</span>
              <span className="text-right">paid / kept</span>
              <span />
            </div>
            {people.map((p) => {
              const mine = memberships.filter((m) => m.personId === p.id);
              return (
                <details key={p.id} id={`p${p.id}`} className="group border-b border-border">
                  <summary className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.4fr)_5.5rem_5.5rem_3rem] items-start gap-3 px-2.5 py-2 hover:bg-surface-2">
                    <span className="font-medium">
                      {p.name}
                      {p.holdsLabelAccount && (
                        <span className="mt-0.5 block">
                          <Badge tone="accent">label account</Badge>
                        </span>
                      )}
                    </span>
                    <span>
                      {mine.length === 0 && contactFor(p.id).length === 0 && <span className="text-xs text-muted">not in a band</span>}
                      {contactFor(p.id).length > 0 && (
                        <span className="block text-xs text-muted">contact for {contactFor(p.id).join(", ")}</span>
                      )}
                      {mine.map((m) => (
                        <span key={m.band.id} className={`block ${m.active ? "" : "opacity-50"}`}>
                          {m.band.name} <RolesList roles={m.roles} />
                        </span>
                      ))}
                    </span>
                    <span className="truncate text-xs">
                      {p.email ? (
                        <span className="block truncate">{p.email}</span>
                      ) : p.holdsLabelAccount ? (
                        <span className="block text-muted">not needed</span>
                      ) : payHandlesSummary(p) ? null : (
                        <span className="block text-warn">no payment details</span>
                      )}
                      {payHandlesSummary(p) && <span className="block truncate text-muted">{payHandlesSummary(p)}</span>}
                    </span>
                    <span className="text-right tabular-nums">
                      <MoneyList totals={sumBy(pending, p.id)} />
                    </span>
                    <span className="text-right tabular-nums">
                      <MoneyList totals={sumBy(paid, p.id)} />
                    </span>
                    <span className="text-right text-xs text-link">
                      <span className="group-open:hidden">edit</span>
                      <span className="hidden group-open:inline">close</span>
                    </span>
                  </summary>
                  <div className="mb-3 space-y-4 border border-border bg-surface-2 p-4">
                    <PersonFields person={p} />
                    {mine.length > 0 && (
                      <p className="text-xs text-muted">
                        Roles are set per band:{" "}
                        {mine.map((m, i) => (
                          <span key={m.band.id}>
                            {i > 0 && ", "}
                            <Link href={`/bands/${m.band.id}`}>{m.band.name}</Link>
                          </span>
                        ))}
                        .
                      </p>
                    )}
                    {people.length > 1 && (
                      <form action={mergePeopleAction} className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
                        <input type="hidden" name="fromId" value={p.id} />
                        <Field label={`Merge ${p.name} into…`} hint="Their bands, splits and payouts move to that person, then this record is removed.">
                          <select name="intoId" required defaultValue="" className="!w-64">
                            <option value="" disabled>
                              Choose a person
                            </option>
                            {people
                              .filter((o) => o.id !== p.id)
                              .map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name}
                                  {o.email ? ` (${o.email})` : ""}
                                </option>
                              ))}
                          </select>
                        </Field>
                        <SubmitButton size="sm" variant="secondary" confirm={`Merge ${p.name} into the chosen person? This can’t be undone.`}>
                          merge
                        </SubmitButton>
                      </form>
                    )}
                    <ActionForm action={deletePerson} className="border-t border-border pt-4">
                      <input type="hidden" name="id" value={p.id} />
                      <SubmitButton variant="danger" size="sm" confirm={`Delete ${p.name}? They're removed from every band and split.`}>
                        Delete person
                      </SubmitButton>
                    </ActionForm>
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </Card>
      <Disclosure summary="+ Add person">
        <PersonFields />
      </Disclosure>
    </>
  );
}
