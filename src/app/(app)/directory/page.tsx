import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { BandFields } from "@/components/band-fields";
import { ActionForm, SubmitButton } from "@/components/client";
import { SyncFooter } from "@/components/sync-status";
import { Badge, Card, Disclosure, Empty, Field, MoneyList, PageHeader, RolesList } from "@/components/ui";
import { ViewAsButton } from "@/components/viewing-as";
import { WhoCanSignIn } from "@/components/who-can-sign-in";
import { db, schema } from "@/db";
import { payHandlesSummary } from "@/lib/paypal-export";
import { bandScope, can } from "@/lib/permissions";
import { deletePerson, mergePeopleAction, savePerson, setLabelAccountHolder } from "@/server/actions";
import { type Context, requireAccess } from "@/server/context";
import { computeAllTime, labelHost } from "@/server/data";
import { linkedBandAccounts } from "@/server/links";
import { possibleDuplicates } from "@/server/people";

export const metadata = { title: "directory" };

type Person = typeof schema.people.$inferSelect;
type Band = typeof schema.bands.$inferSelect;
type Membership = { personId: number; roles: string[]; active: boolean; band: Band };
type Totals = Map<string, number>;

/** The person rows' columns (and the header above them). */
const COLUMNS = "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_5.5rem_5.5rem_3rem] gap-3";

/**
 * Everyone on the books: each band with its people underneath, then people who aren't in a band
 * (co-writers, producers, outside artists' contacts). Click a person to edit them; a band's name
 * opens its page.
 */
export default async function DirectoryPage() {
  await connection();
  const ctx = await requireAccess("roster");
  const { orgId } = ctx;
  // A band manager: just their bands and the people in them, and nothing label-wide.
  const scope = bandScope(ctx.access, "roster");
  const [allBands, everyone, memberships, payoutRows, duplicates, outsideRows, splitRules, releases, { summary }, linked] = await Promise.all([
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
    db
      .select({ personId: schema.bandMemberships.personId, roles: schema.bandMemberships.roles, active: schema.bandMemberships.active, band: schema.bands })
      .from(schema.bandMemberships)
      .innerJoin(schema.bands, eq(schema.bands.id, schema.bandMemberships.bandId))
      .where(eq(schema.bandMemberships.orgId, orgId)),
    db.select().from(schema.payouts).where(eq(schema.payouts.orgId, orgId)),
    possibleDuplicates(orgId),
    db.select().from(schema.outsideArtists).where(eq(schema.outsideArtists.orgId, orgId)),
    db.select().from(schema.splitRules).where(eq(schema.splitRules.orgId, orgId)),
    db.select({ bandId: schema.releases.bandId, kind: schema.releases.kind }).from(schema.releases).where(eq(schema.releases.orgId, orgId)),
    computeAllTime(orgId),
    linkedBandAccounts(orgId),
  ]);
  const bands = scope ? allBands.filter((b) => scope.includes(b.id)) : allBands;
  // A band account is one band: its directory is that band and its people.
  if (ctx.org.kind === "band" && bands.length === 0) redirect("/");
  const people = scope ? everyone.filter((p) => memberships.some((m) => m.personId === p.id && scope.includes(m.band.id))) : everyone;
  const inNoBand = scope ? [] : people.filter((p) => !memberships.some((m) => m.personId === p.id));
  const holder = everyone.find((p) => p.holdsLabelAccount);

  const sumBy = (rows: typeof payoutRows, personId: number) => {
    const m: Totals = new Map();
    for (const r of rows) if (r.personId === personId) m.set(r.currency, (m.get(r.currency) ?? 0) + r.amountCents);
    return m;
  };
  const pending = payoutRows.filter((r) => r.status === "pending");
  // Paid out, or kept in the label's account by whoever holds it: either way, it's theirs and settled.
  const paid = payoutRows.filter((r) => r.status !== "pending");
  const money = new Map(people.map((p) => [p.id, { owed: sumBy(pending, p.id), paid: sumBy(paid, p.id) }]));
  const contactFor = (personId: number) => outsideRows.filter((a) => a.contactPersonId === personId).map((a) => a.name);

  const hasLabelDefault = splitRules.some((r) => r.scope === "label_default");
  const splitStatus = (b: Band) =>
    splitRules.some((r) => r.scope === "band_default" && r.bandId === b.id)
      ? { text: "own split", tone: "" }
      : b.isLabel
        ? { text: "label keeps it", tone: "text-muted" }
        : hasLabelDefault
          ? { text: "label-wide split", tone: "text-muted" }
          : { text: "no split set", tone: "text-warn" };
  const labelHosts = new Map(await Promise.all(bands.filter((b) => b.isLabel).map(async (b) => [b.id, await labelHost(orgId, b.id)] as const)));
  /** The band's Bandcamp page, from a bare subdomain pattern or a custom host. */
  const bandcampHost = (b: Band) => {
    const p = b.urlPatterns.find((x) => !x.includes("/"));
    return p ? (p.includes(".") ? p : `${p}.bandcamp.com`) : (labelHosts.get(b.id) ?? null);
  };
  const netSales = (bandId: number) => {
    const m: Totals = new Map();
    for (const cur of summary.currencies) {
      const v = summary.byCurrency[cur].byBand.get(bandId);
      if (v) m.set(cur, v);
    }
    return m;
  };
  const countOf = (bandId: number, merch: boolean) => releases.filter((r) => r.bandId === bandId && (r.kind === "merch") === merch).length;
  // Someone in several bands is listed under each; their edit panel's anchor (#p12) is on the first.
  const anchored = new Set<number>();
  const anchorFor = (personId: number) => {
    if (anchored.has(personId)) return undefined;
    anchored.add(personId);
    return `p${personId}`;
  };
  const row = (p: Person, bandId: number | null, roles: string[] | null, active = true) => (
    <PersonRow
      key={p.id}
      id={anchorFor(p.id)}
      person={p}
      bandId={bandId}
      roles={roles}
      active={active}
      bandsOf={memberships.filter((m) => m.personId === p.id)}
      contactFor={contactFor(p.id)}
      money={money.get(p.id)!}
      everyone={people}
      ctx={ctx}
      limited={!!scope}
    />
  );

  return (
    <>
      <PageHeader
        title="Directory"
        subtitle="Your bands, and everyone who gets paid. One person can be in several bands and still gets one payment."
      />

      {!scope && duplicates.length > 0 && (
        <Card title="Possible duplicates">
          <p className="mb-3 text-sm text-muted">
            These look like the same person entered more than once. Merging combines their bands, splits and payouts so they’re paid once.
            (People with the same email are merged automatically when you save.)
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
                        · {keep.email ?? "no email"} ·{" "}
                        {memberships
                          .filter((m) => m.personId === keep.id)
                          .map((m) => m.band.name)
                          .join(", ") || "no band"}
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

      {bands.length === 0 && <Empty>No bands yet. They come in from Bandcamp, or add one below.</Empty>}
      {people.length > 0 && (
        <div className={`${COLUMNS} border-b border-border px-2.5 pb-1.5 text-xs text-muted lowercase`}>
          <span>person</span>
          <span>roles</span>
          <span>how they’re paid</span>
          <span className="text-right">owed</span>
          <span className="text-right">paid / kept</span>
          <span />
        </div>
      )}
      <div className="space-y-8">
        {bands.map((b) => {
          const nameOf = (m: Membership) => people.find((p) => p.id === m.personId)?.name ?? "";
          // Current members first, then by name.
          const members = memberships
            .filter((m) => m.band.id === b.id)
            .sort((x, y) => Number(y.active) - Number(x.active) || nameOf(x).localeCompare(nameOf(y)));
          const host = bandcampHost(b);
          const split = splitStatus(b);
          return (
            <section key={b.id} id={`band-${b.id}`} className="scroll-mt-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border pb-2">
                <Link href={`/bands/${b.id}`} className="flex items-center gap-3 text-base font-bold hover:no-underline">
                  {b.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={b.imageUrl} alt="" className="h-9 w-9 shrink-0 bg-surface-2 object-cover" />
                  ) : (
                    <span className="h-9 w-9 shrink-0 bg-surface-2" />
                  )}
                  <span className="hover:underline">{b.name}</span>
                </Link>
                {b.isLabel && <span className="text-xs text-muted">the label itself</span>}
                {linked.has(b.id) && (
                  <span className="text-xs text-good" title={`Linked to the band's own account, ${linked.get(b.id)}`}>
                    linked
                  </span>
                )}
                <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                  {b.location && <span>{b.location}</span>}
                  {host ? (
                    <a href={`https://${host}`} target="_blank" rel="noreferrer">
                      {host}
                    </a>
                  ) : (
                    <span>matched by name</span>
                  )}
                  <Link href={`/bands/${b.id}?tab=money`} className={split.tone || "text-text"}>
                    {split.text}
                  </Link>
                  <span>
                    {countOf(b.id, false)} release{countOf(b.id, false) === 1 ? "" : "s"} · {countOf(b.id, true)} merch
                  </span>
                  <span className="text-text">
                    <MoneyList totals={netSales(b.id)} />
                  </span>
                </span>
              </div>
              {members.length === 0 ? (
                <p className="px-2.5 py-2 text-sm text-muted">
                  {b.isLabel ? (
                    "No one listed: what the label’s own releases earn stays with the label unless they have a split."
                  ) : (
                    <>
                      <span className="text-warn">No members yet.</span> <Link href={`/bands/${b.id}?tab=people`}>Add them</Link>
                    </>
                  )}
                </p>
              ) : (
                <div className="text-sm">{members.map((m) => row(people.find((p) => p.id === m.personId)!, b.id, m.roles, m.active))}</div>
              )}
            </section>
          );
        })}

        {inNoBand.length > 0 && (
          <section id="not-in-a-band">
            <div className="border-b border-border pb-2">
              <h2 className="text-base font-bold">Not in a band</h2>
              <p className="text-xs text-muted">Co-writers, producers, contacts for outside artists: anyone paid without being in one of your bands.</p>
            </div>
            <div className="text-sm">{inNoBand.map((p) => row(p, null, null))}</div>
          </section>
        )}
      </div>

      {!scope && (
        <div className="mt-6 flex flex-wrap items-start gap-3">
          {ctx.org.kind === "label" && (
            <Disclosure summary="+ Add a band">
              <BandFields />
            </Disclosure>
          )}
          <Disclosure summary="+ Add someone who isn’t in a band">
            <PersonFields />
          </Disclosure>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">To add someone to a band, open the band and use its People tab.</p>

      {can(ctx.access, "funds", "edit") && !scope && ctx.org.kind === "label" && people.length > 0 && (
        <Card title="Label bank account" className="mt-10">
          <p className="mb-3 text-sm text-muted">
            Whoever the label’s bank account belongs to doesn’t need to pay themselves. Their share of each payout is recorded as theirs, but
            marked <i>kept in label account</i> instead of being sent through PayPal.
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

      {/* Logins and invites: admins only (it's who can see and change the books). */}
      {ctx.isAdmin && (
        <div id="who-can-sign-in" className="mt-10">
          <WhoCanSignIn ctx={ctx} />
        </div>
      )}
      <SyncFooter orgId={orgId} />
    </>
  );
}

/** One person under a band (with their roles there) or under "not in a band": click to edit. */
function PersonRow({
  id,
  person: p,
  bandId,
  roles,
  active,
  bandsOf,
  contactFor,
  money,
  everyone,
  ctx,
  limited,
}: {
  id?: string;
  person: Person;
  /** The band they're listed under (null: not in a band). */
  bandId: number | null;
  roles: string[] | null;
  active: boolean;
  bandsOf: Membership[];
  contactFor: string[];
  money: { owed: Totals; paid: Totals };
  everyone: Person[];
  ctx: Context;
  limited: boolean;
}) {
  const others = bandsOf.filter((m) => m.band.id !== bandId);
  return (
    <details id={id} className="group scroll-mt-4 border-b border-border">
      <summary
        className={`${COLUMNS} items-start px-2.5 py-2 hover:bg-surface-2 ${active ? "" : "opacity-50"}`}
      >
        <span className="font-medium">
          {p.name}
          {!active && <span className="ml-2 text-xs font-normal text-muted">(former member)</span>}
          {p.holdsLabelAccount && (
            <span className="mt-0.5 block">
              <Badge tone="accent">label account</Badge>
            </span>
          )}
        </span>
        <span className="text-xs">
          {roles && roles.length > 0 && <RolesList roles={roles} />}
          {contactFor.length > 0 && <span className="block text-muted">contact for {contactFor.join(", ")}</span>}
          {others.length > 0 && <span className="block text-muted">also in {others.map((m) => m.band.name).join(", ")}</span>}
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
        <span className="text-right tabular-nums" title="Owed: in a finalized payout, not paid yet">
          <MoneyList totals={money.owed} />
        </span>
        <span className="text-right tabular-nums" title="Paid, or kept in the label’s account">
          <MoneyList totals={money.paid} />
        </span>
        <span className="text-right text-xs text-link">
          <span className="group-open:hidden">edit</span>
          <span className="hidden group-open:inline">close</span>
        </span>
      </summary>
      <div className="mb-3 space-y-4 border border-border bg-surface-2 p-4">
        <PersonFields person={p} />
        {bandsOf.length > 0 && (
          <p className="text-xs text-muted">
            Roles are set per band, on the band’s People tab:{" "}
            {bandsOf.map((m, i) => (
              <span key={m.band.id}>
                {i > 0 && ", "}
                <Link href={`/bands/${m.band.id}?tab=people`}>{m.band.name}</Link>
              </span>
            ))}
            .
          </p>
        )}
        {!limited && everyone.length > 1 && (
          <form action={mergePeopleAction} className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <input type="hidden" name="fromId" value={p.id} />
            <Field label={`Merge ${p.name} into…`} hint="Their bands, splits and payouts move to that person, then this record is removed.">
              <select name="intoId" required defaultValue="" className="!w-64">
                <option value="" disabled>
                  Choose a person
                </option>
                {everyone
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
        {ctx.isAdmin && ctx.org.kind === "label" && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm">
            <ViewAsButton kind="person" id={p.id} name={p.name} />
            <span className="text-xs text-muted">See {ctx.org.name} as they would when they sign in. Nothing can be changed while viewing.</span>
          </div>
        )}
        {!limited && (
          <ActionForm action={deletePerson} className="border-t border-border pt-4">
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton variant="danger" size="sm" confirm={`Delete ${p.name}? They're removed from every band and split.`}>
              Delete person
            </SubmitButton>
          </ActionForm>
        )}
      </div>
    </details>
  );
}

function PersonFields({ person }: { person?: Person }) {
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
