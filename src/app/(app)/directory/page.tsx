import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { BandFields } from "@/components/band-fields";
import { ActionForm, OpenLinkedSection, SaveWhenChanged, SubmitButton } from "@/components/client";
import { SyncFooter } from "@/components/sync-status";
import { Badge, Card, Disclosure, Empty, Field, MoneyList, PageHeader, RolesList } from "@/components/ui";
import { ViewAsButton } from "@/components/viewing-as";
import { WhoCanSignIn } from "@/components/who-can-sign-in";
import { db, schema } from "@/db";
import { payHandlesSummary } from "@/lib/paypal-export";
import { bandScope } from "@/lib/permissions";
import { addMember, deletePerson, mergePeopleAction, removeMember, savePerson } from "@/server/actions";
import { type Context, requireAccess } from "@/server/context";
import { labelHost } from "@/server/data";
import { type BandAccountSummary, bandAccountSummaries, ensureBandAccounts } from "@/server/band-accounts";
import { MemberTypesCard } from "@/components/member-types";
import { possibleDuplicates } from "@/server/people";
import { StandingInviteLink } from "@/components/band-invite-links";

export const metadata = { title: "directory" };

type Person = typeof schema.people.$inferSelect;
type Band = typeof schema.bands.$inferSelect;
type Membership = { id: number; personId: number; roles: string[]; active: boolean; band: Band };
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
  // Bands' own accounts (label admins): bands added since (or from before sub-accounts) get theirs.
  const showAccounts = ctx.isAdmin && ctx.org.kind === "label";
  if (showAccounts) await ensureBandAccounts(orgId);
  const [allBands, everyone, memberships, payoutRows, duplicates, outsideRows, accounts] = await Promise.all([
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
    db
      .select({
        id: schema.bandMemberships.id,
        personId: schema.bandMemberships.personId,
        roles: schema.bandMemberships.roles,
        active: schema.bandMemberships.active,
        band: schema.bands,
      })
      .from(schema.bandMemberships)
      .innerJoin(schema.bands, eq(schema.bands.id, schema.bandMemberships.bandId))
      .where(eq(schema.bandMemberships.orgId, orgId)),
    db.select().from(schema.payouts).where(eq(schema.payouts.orgId, orgId)),
    possibleDuplicates(orgId),
    db.select().from(schema.outsideArtists).where(eq(schema.outsideArtists.orgId, orgId)),
    showAccounts ? bandAccountSummaries(orgId) : new Map<number, BandAccountSummary>(),
  ]);
  const bands = scope ? allBands.filter((b) => scope.includes(b.id)) : allBands;
  // A band account is one band: its directory is that band and its people.
  if (ctx.org.kind === "band" && bands.length === 0) redirect("/");
  const people = scope ? everyone.filter((p) => memberships.some((m) => m.personId === p.id && scope.includes(m.band.id))) : everyone;
  const inNoBand = scope ? [] : people.filter((p) => !memberships.some((m) => m.personId === p.id));
  // Limited to some bands: only duplicates that are all their people.
  const shownDuplicates = scope ? duplicates.filter((g) => g.every((d) => people.some((p) => p.id === d.id))) : duplicates;

  // Limited to some bands (a band's own account): only what they were paid from those bands.
  const amountOf = (r: (typeof payoutRows)[number]) => (scope ? scope.reduce((a, b) => a + (r.byBand[String(b)] ?? 0), 0) : r.amountCents);
  const sumBy = (rows: typeof payoutRows, personId: number) => {
    const m: Totals = new Map();
    for (const r of rows) {
      const cents = r.personId === personId ? amountOf(r) : 0;
      if (cents) m.set(r.currency, (m.get(r.currency) ?? 0) + cents);
    }
    return m;
  };
  const pending = payoutRows.filter((r) => r.status === "pending");
  // Paid out, or kept in the label's account by whoever holds it: either way, it's theirs and settled.
  const paid = payoutRows.filter((r) => r.status !== "pending");
  const money = new Map(people.map((p) => [p.id, { owed: sumBy(pending, p.id), paid: sumBy(paid, p.id) }]));
  const contactFor = (personId: number) => outsideRows.filter((a) => a.contactPersonId === personId).map((a) => a.name);

  const labelHosts = new Map(await Promise.all(bands.filter((b) => b.isLabel).map(async (b) => [b.id, await labelHost(orgId, b.id)] as const)));
  /** The band's Bandcamp page, from a bare subdomain pattern or a custom host. */
  const bandcampHost = (b: Band) => {
    const p = b.urlPatterns.find((x) => !x.includes("/"));
    return p ? (p.includes(".") ? p : `${p}.bandcamp.com`) : (labelHosts.get(b.id) ?? null);
  };
  // Someone in several bands is listed under each; their edit panel's anchor (#p12) is on the first.
  const anchored = new Set<number>();
  const anchorFor = (personId: number) => {
    if (anchored.has(personId)) return undefined;
    anchored.add(personId);
    return `p${personId}`;
  };
  const row = (p: Person, membership: Membership | null) => (
    <PersonRow
      key={p.id}
      id={anchorFor(p.id)}
      person={p}
      membership={membership}
      bandsOf={memberships.filter((m) => m.personId === p.id)}
      contactFor={contactFor(p.id)}
      money={money.get(p.id)!}
      everyone={people}
      bands={bands}
      ctx={ctx}
      limited={!!scope}
    />
  );

  return (
    <>
      <PageHeader
        title="Directory"
      />

      {shownDuplicates.length > 0 && (
        <Card title="Possible duplicates">
          {/* <p className="mb-3 text-sm text-muted">
            These look like the same person entered more than once. Merging combines their bands, splits and payouts so they’re paid once.
            (People with the same email are merged automatically when you save.)
          </p> */}
          <ul className="space-y-4">
            {shownDuplicates.map((group) => (
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

      {bands.length === 0 && <Empty>No bands yet.</Empty>}
      <div className={scope && bands.length === 1 ? "" : "divide-y divide-border border-y border-border"}>
        {bands.map((b) => {
          const nameOf = (m: Membership) => people.find((p) => p.id === m.personId)?.name ?? "";
          // Current members first, then by name.
          const members = memberships
            .filter((m) => m.band.id === b.id)
            .sort((x, y) => Number(y.active) - Number(x.active) || nameOf(x).localeCompare(nameOf(y)));
          const current = members.filter((m) => m.active).length;
          const host = bandcampHost(b);
          const body = (
            <>
                {members.length > 0 && (
                  <div className="text-sm">
                    <ColumnHeads />
                    {members.map((m) => row(people.find((p) => p.id === m.personId)!, m))}
                  </div>
                )}
                <AddToBand bandId={b.id} bandName={b.name} people={people.filter((p) => !members.some((m) => m.personId === p.id && m.active))} />
                {accounts.get(b.id) && (
                  <BandAccountLine
                    bandId={b.id}
                    account={accounts.get(b.id)!}
                  />
                )}
            </>
          );
          // Just one band (a band's own account): its people, without a band to open.
          if (scope && bands.length === 1) {
            return (
              <div key={b.id} id={`band-${b.id}`} className="pb-4">
                {body}
              </div>
            );
          }
          return (
            <details key={b.id} id={`band-${b.id}`} className="group/band scroll-mt-4">
              <summary className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 hover:bg-surface-2">
                <span className="w-4 shrink-0 text-center text-xs text-muted transition group-open/band:rotate-90">▸</span>
                <Link href={`/bands/${b.id}`} className="flex items-center gap-3 font-bold">
                  {b.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={b.imageUrl} alt="" className="h-8 w-8 shrink-0 bg-surface-2 object-cover" />
                  ) : (
                    <span className="h-8 w-8 shrink-0 bg-surface-2" />
                  )}
                  {b.name}
                </Link>
                {host && (
                  <a href={`https://${host}`} target="_blank" rel="noreferrer" className="text-xs">
                    {host}
                  </a>
                )}
                <span className={`ml-auto text-xs ${current || b.isLabel ? "text-muted" : "text-warn"}`}>
                  {current ? `${current} member${current === 1 ? "" : "s"}` : b.isLabel ? "the label itself" : "no members yet"}
                </span>
                {accounts.get(b.id)?.managed && <ViewAsButton kind="band" id={b.id} />}
              </summary>
              <div className="mb-4 ml-8">{body}</div>
            </details>
          );
        })}

        {inNoBand.length > 0 && (
          <details id="not-in-a-band" className="group/band scroll-mt-4">
            <summary className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 hover:bg-surface-2">
              <span className="w-4 shrink-0 text-center text-xs text-muted transition group-open/band:rotate-90">▸</span>
              <span className="font-bold">Not in a band</span>
              {/* <span className="text-xs text-muted">co-writers, producers, contacts for outside artists</span> */}
              <span className="ml-auto text-xs text-muted">
                {inNoBand.length} {inNoBand.length === 1 ? "person" : "people"}
              </span>
            </summary>
            <div className="mb-4 ml-8 text-sm">
              <ColumnHeads />
              {inNoBand.map((p) => row(p, null))}
            </div>
          </details>
        )}
      </div>
      <OpenLinkedSection />

      {!scope && (
        <div className="mt-6 flex flex-wrap items-start gap-3">
          {ctx.org.kind === "label" && (
            <Disclosure summary="+ Add a band">
              <BandFields />
            </Disclosure>
          )}
          <Disclosure summary="+ Add someone">
            <PersonFields />
          </Disclosure>
        </div>
      )}

      {/* Logins, invites and member types: admins only (it's who can see and change the books). */}
      {ctx.isAdmin && (
        <div id="who-can-sign-in" className="mt-10 scroll-mt-4">
          <WhoCanSignIn ctx={ctx} />
          <MemberTypesCard orgId={orgId} />
        </div>
      )}
      <SyncFooter orgId={orgId} />
    </>
  );
}

/** The person columns, at the top of an opened band. */
function ColumnHeads() {
  return (
    <div className={`${COLUMNS} border-b border-border px-2.5 py-1.5 text-xs text-muted lowercase`}>
      <span>person</span>
      <span>roles</span>
      <span>how they’re paid</span>
      <span className="text-right">owed</span>
      <span className="text-right">paid / kept</span>
      <span />
    </div>
  );
}

/** Add someone to a band: someone already in the books, or someone new. */
function AddToBand({ bandId, bandName, people }: { bandId: number; bandName: string; people: Person[] }) {
  return (
    <div className="mt-3">
      <Disclosure
        summary={
          <>
            + Add someone to <span className="normal-case">{bandName}</span>
          </>
        }
      >
        <form action={addMember} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="bandId" value={bandId} />
          {people.length > 0 && (
            <Field label="Someone already here" className="sm:col-span-2">
              <select name="personId" defaultValue="">
                <option value="">Someone new (fill in below)</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Name">
            <input name="name" />
          </Field>
          <Field label="Roles (comma-separated)">
            <input name="roles" placeholder="vocals, guitar, songwriter" />
          </Field>
          <Field label="Email (optional)" className="sm:col-span-2">
            <input name="email" type="email" />
          </Field>
          <div className="sm:col-span-2">
            <SubmitButton>
              Add to <span className="normal-case">{bandName}</span>
            </SubmitButton>
          </div>
        </form>
      </Disclosure>
    </div>
  );
}

/** Under a band's name: its own account, who signs in to it (or a form to invite its login), and "view as". */
function BandAccountLine({
  bandId,
  account: a,
}: {
  bandId: number;
  account: BandAccountSummary;
}) {
  const manage = `/bands/${bandId}?tab=people#band-account`;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {a.managed ? (
        <>
          <span>Band account:</span>
          {a.logins > 0 && (
            <>
              <span>
                {a.logins} sign{a.logins === 1 ? "s" : ""} in
              </span>
              <Link href={manage}>manage</Link>
            </>
          )}
          <StandingInviteLink bandOrgId={a.orgId} bandId={bandId} />
        </>
      ) : (
        <>
          <span>Linked to their own account, “{a.name}”.</span>
          <Link href={manage}>manage</Link>
        </>
      )}
    </div>
  );
}

/** One person under a band (with their roles there) or under "not in a band": click to edit. */
function PersonRow({
  id,
  person: p,
  membership,
  bandsOf,
  contactFor,
  money,
  everyone,
  bands,
  ctx,
  limited,
}: {
  id?: string;
  person: Person;
  /** Their place in the band they're listed under (null: not in a band). */
  membership: Membership | null;
  bandsOf: Membership[];
  contactFor: string[];
  money: { owed: Totals; paid: Totals };
  everyone: Person[];
  /** The bands they can be added to (the ones on this page). */
  bands: Band[];
  ctx: Context;
  limited: boolean;
}) {
  const roles = membership?.roles ?? null;
  const active = membership?.active ?? true;
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
          <MoneyList totals={money.owed} />
        </span>
        <span className="text-right tabular-nums">
          <MoneyList totals={money.paid} />
        </span>
        <span className="text-right text-xs text-link">
          <span className="group-open:hidden">edit</span>
          <span className="hidden group-open:inline">close</span>
        </span>
      </summary>
      <div className="mb-3 space-y-4 border border-border bg-surface-2 p-4">
        <PersonFields person={p} />
        <PersonBands person={p} bandsOf={bandsOf} bands={bands} />
        {everyone.length > 1 && (
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

/** In a person's panel: the bands they're in (each with remove), and adding them to another. */
function PersonBands({ person: p, bandsOf: all, bands }: { person: Person; bandsOf: Membership[]; bands: Band[] }) {
  // A band manager only sees (and changes) their own bands.
  const bandsOf = all.filter((m) => bands.some((b) => b.id === m.band.id));
  const notIn = bands.filter((b) => !bandsOf.some((m) => m.band.id === b.id && m.active));
  return (
    <div className="space-y-2 border-t border-border pt-4 text-sm">
      <p className="text-xs text-muted lowercase">bands</p>
      {bandsOf.length === 0 && <p className="text-muted">Not in a band.</p>}
      {bandsOf.length > 0 && (
        <ul className="space-y-1">
          {bandsOf.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3">
              <Link href={`/bands/${m.band.id}?tab=people`} className={m.active ? "" : "opacity-60"}>
                {m.band.name}
              </Link>
              {!m.active && <span className="text-xs text-muted">former member</span>}
              <form action={removeMember} className="ml-auto">
                <input type="hidden" name="membershipId" value={m.id} />
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  confirm={`Take ${p.name} out of ${m.band.name}? They stay in your books with their payout history. If they have a share in the band's split, change that on its Money tab.`}
                >
                  remove
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      )}
      {notIn.length > 0 && (
        <form action={addMember} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="personId" value={p.id} />
          <select name="bandId" required defaultValue="" className="!w-56">
            <option value="" disabled>
              Add to a band…
            </option>
            {notIn.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <SubmitButton size="sm" variant="secondary">
            add
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

function PersonFields({ person }: { person?: Person }) {
  return (
    <form action={savePerson} className="grid gap-4 sm:grid-cols-2">
      {person && <input type="hidden" name="id" value={person.id} />}
      <Field label="Name">
        <input name="name" required defaultValue={person?.name} />
      </Field>
      <Field label="PayPal email">
        <input name="email" type="email" defaultValue={person?.email ?? ""} />
      </Field>
      <Field label="PayPal.me handle">
        <input name="paypalMe" defaultValue={person?.paypalMe ?? ""} />
      </Field>
      <Field label="Venmo username" hint="US only.">
        <input name="venmo" defaultValue={person?.venmo ?? ""} placeholder="@yourname" />
      </Field>
      <Field label="Cash App $cashtag">
        <input name="cashtag" defaultValue={person?.cashtag ?? ""} placeholder="$yourname" />
      </Field>
      <Field label="Notes">
        <input name="notes" defaultValue={person?.notes ?? ""} />
      </Field>
      <div className="sm:col-span-2">
        {person ? (
          <SaveWhenChanged>
            <SubmitButton>Save</SubmitButton>
          </SaveWhenChanged>
        ) : (
          <SubmitButton>Add person</SubmitButton>
        )}
      </div>
    </form>
  );
}
