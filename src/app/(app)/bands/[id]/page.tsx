import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BandFields } from "@/components/band-fields";
import { SubmitButton } from "@/components/client";
import { SalesSection } from "@/components/sales-section";
import { DeductionForm, DeductionList } from "@/components/deductions";
import { ItemCosts } from "@/components/item-cost";
import { PhysicalFormatsTable, costsFor } from "@/components/physical-formats";
import { LabelDefaultSummary, SplitRules, SharesSummary, currentRule } from "@/components/split-rules";
import type { PersonOption } from "@/components/split-editor";
import { Badge, Callout, Card, Disclosure, Empty, Field, LinkButton, Money, MoneyList, PageHeader, RolesList } from "@/components/ui";
import { db, schema } from "@/db";
import { ITEM_CATEGORIES } from "@/lib/bandcamp-csv";
import { payHandlesSummary } from "@/lib/paypal-export";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { BandAccountLink } from "@/components/band-link";
import { LabelFunds } from "@/components/label-funds";
import { ExpenseForm, ExpenseTable } from "@/components/receipts";
import { addMember, deleteBand, removeMember, saveRelease, updateMembership } from "@/server/actions";
import { requireAccess } from "@/server/context";
import { accountExpenses, expenseFileList } from "@/server/expenses";
import { accountProjects, projectNumbers } from "@/server/projects";
import { bandAssociatedPeople, bandMembers, computeAllTime, labelHost, nameMaps, ruleFilter, rulesWhere } from "@/server/data";

export default async function BandPage({ params, searchParams }: PageProps<"/bands/[id]">) {
  await connection();
  const ctx = await requireAccess("roster");
  const { orgId } = ctx;
  const id = Number((await params).id);
  const [band] = await db
    .select()
    .from(schema.bands)
    .where(and(eq(schema.bands.orgId, orgId), eq(schema.bands.id, id)));
  if (!band) notFound();

  const [members, allPeople, releases, allReleases, orgDeductions, names, defaultRules, labelRules, bandPeople, periodRows, { summary }, bandExpenses, expenseFiles, allProjects, projectTotals] =
    await Promise.all([
      bandMembers(orgId, id),
      db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
      db
        .select()
        .from(schema.releases)
        .where(and(eq(schema.releases.orgId, orgId), eq(schema.releases.bandId, id)))
        .orderBy(asc(schema.releases.title)),
      db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId)),
      db.select().from(schema.deductions).where(eq(schema.deductions.orgId, orgId)),
      nameMaps(orgId),
      rulesWhere(orgId, ruleFilter("band_default", { bandId: id })),
      rulesWhere(orgId, ruleFilter("label_default", {})),
      bandAssociatedPeople(orgId, id),
      db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId)),
      computeAllTime(orgId),
      accountExpenses(orgId, { bandId: id }),
      expenseFileList(orgId),
      accountProjects(orgId),
      projectNumbers(orgId),
    ]);
  const bandProjects = allProjects.filter((p) => p.bandId === id);
  const personOptions: PersonOption[] = [
    ...members.filter((m) => m.active).map((m) => ({ id: m.person.id, name: m.person.name, roles: m.roles, inBand: true })),
    ...allPeople.filter((p) => !members.some((m) => m.active && m.person.id === p.id)).map((p) => ({ id: p.id, name: p.name, inBand: false })),
  ];
  const memberIds = new Set(members.map((m) => m.person.id));
  const releaseOpts = allReleases.map((r) => ({
    id: r.id,
    name: r.title,
    bandId: r.bandId,
    formats: r.kind === "merch" ? [] : r.packages.map((p) => ({ id: p.bandcampId, title: p.title })),
  }));
  const bandDeductions = orgDeductions.filter((d) => d.bandId === id);
  const labelDefault = currentRule(labelRules);
  const releaseRules = new Map(
    await Promise.all(releases.map(async (r) => [r.id, currentRule(await rulesWhere(orgId, ruleFilter("release", { releaseId: r.id })))] as const)),
  );
  const itemTypeRules = new Map(
    await Promise.all(
      ITEM_CATEGORIES.map(async (c) => [c.value, await rulesWhere(orgId, ruleFilter("band_item_type", { bandId: id, itemCategory: c.value }))] as const),
    ),
  );

  // Payouts that covered this band: its own, and whole-label ones.
  const bandPeriods = periodRows
    .filter((p) => p.bandId === id || p.bandId === null)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .slice(0, 8);

  const itemCosts = {
    deductions: [...bandDeductions, ...orgDeductions.filter((d) => d.bandId === null)],
    people: bandPeople,
    names,
  };
  const music = releases.filter((r) => r.kind !== "merch");
  const merch = releases.filter((r) => r.kind === "merch");
  const hasMerchSplit = (itemTypeRules.get("merch") ?? []).length > 0;
  /** What a sale with no more specific split falls back to, in words. */
  const fallbackSplit = defaultRules.length ? "band default" : band.isLabel ? "label keeps it" : labelDefault ? "label-wide default" : "no split set";

  /** Releases or merch items: tiny artwork, title and details, and the split they use. */
  const itemTable = (items: typeof releases) => (
    <table className="data mb-4">
      <thead>
        <tr>
          <th>{items[0]?.kind === "merch" ? "Item" : "Release"}</th>
          <th>Split</th>
          {items[0]?.kind === "merch" && <th>per-item cost</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((r) => {
          const rule = releaseRules.get(r.id);
          const details =
            r.kind === "merch" ? [r.packages[0]?.typeName, r.packages[0]?.sku] : [r.catalogNumber, r.kind === "track" ? "single" : null];
          return (
            <tr key={r.id}>
              <td>
                <div className="flex items-center gap-2.5">
                  {r.artUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.artUrl.replace(/_(10|16)\.jpg$/, "_3.jpg")}
                      alt=""
                      loading="lazy"
                      className="h-6 w-6 shrink-0 border border-border bg-surface-2 object-cover"
                    />
                  ) : (
                    <span className="h-6 w-6 shrink-0 bg-surface-2" />
                  )}
                  <Link href={`/catalog/${r.id}`} className="font-medium hover:underline">
                    {r.title}
                  </Link>
                  <span className="text-xs text-muted">{details.filter(Boolean).join(" · ")}</span>
                </div>
              </td>
              <td>
                {rule ? (
                  <SharesSummary shares={rule.shares} people={personOptions} />
                ) : (
                  <span className="text-sm text-muted">{r.kind === "merch" && hasMerchSplit ? "band merch split" : fallbackSplit}</span>
                )}
              </td>
              {r.kind === "merch" && (
                <td>
                  <ItemCosts
                    costs={r.packages[0] ? costsFor(itemCosts.deductions, r, r.packages[0]) : []}
                    releaseId={r.id}
                    currency={r.packages[0]?.currency ?? "USD"}
                    people={bandPeople}
                    personName={names.person}
                  />
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  // A bare subdomain pattern ("blackmarble") or a custom host; prefixes with a path aren't a homepage.
  const homePattern = band.urlPatterns.find((p) => !p.includes("/"));
  const bandcampHost = homePattern
    ? homePattern.includes(".")
      ? homePattern
      : `${homePattern}.bandcamp.com`
    : band.isLabel
      ? await labelHost(orgId, id)
      : null;

  const earned = new Map<string, number>();
  for (const cur of summary.currencies) {
    const v = summary.byCurrency[cur].byBand.get(id);
    if (v) earned.set(cur, v);
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-4">
            {band.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={band.imageUrl} alt="" className="h-16 w-16 shrink-0 bg-surface-2 object-cover" />
            )}
            <span>{band.name}</span>
          </span>
        }
        subtitle={
          <>
            {band.location && <>{band.location} · </>}
            {earned.size ? (
              <>
                all-time net sales: <MoneyList totals={earned} />
              </>
            ) : (
              "no sales yet"
            )}
            {bandcampHost && (
              <>
                {" · "}
                <a href={`https://${bandcampHost}`} target="_blank" rel="noreferrer">
                  Bandcamp ↗
                </a>
              </>
            )}
          </>
        }
      />

      <SalesSection boardId="band-sales" scope={{ bandId: id }} range={(await searchParams).range as string | undefined} basePath={`/bands/${id}`} showItems />

      <Card
        title="Payouts"
        actions={
          <LinkButton href={`/periods?band=${id}`} size="sm" variant="primary">
            Pay this band
          </LinkButton>
        }
      >
        {bandPeriods.length === 0 ? (
          <Empty>No payouts for {band.name} yet. Pay them on their own, or as part of a whole-label payout.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>period</th>
                <th>for</th>
                <th>dates</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {bandPeriods.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/periods/${p.id}`}>{p.name}</Link>
                  </td>
                  <td className="text-sm text-muted">{p.bandId ? "this band" : "whole label"}</td>
                  <td className="text-muted">
                    {p.startDate} → {p.endDate}
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Projects" actions={<LinkButton href={`/projects?band=${id}`} size="sm">All projects</LinkButton>}>
        {bandProjects.length === 0 ? (
          <p className="text-sm text-muted">
            No projects yet. A project (an album, a tour…) collects what was spent on it and what its releases made back.{" "}
            <Link href={`/projects?band=${id}`}>Create one</Link>.
          </p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">Spent</th>
                <th className="num">Made back</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {bandProjects.map((p) => {
                const t = projectTotals.get(p.id)!;
                return (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/projects/${p.id}`}>{p.name}</Link>
                      {p.status === "done" && <span className="ml-2 text-xs text-muted">done</span>}
                    </td>
                    <td className="num">
                      <Money cents={t.spent} currency={t.currency} />
                    </td>
                    <td className="num">
                      <Money cents={t.madeBack} currency={t.currency} />
                    </td>
                    <td className={`num ${t.balance >= 0 && t.spent > 0 ? "text-good" : ""}`}>
                      <Money cents={t.balance} currency={t.currency} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Receipts" actions={<LinkButton href={`/receipts?band=${id}`} size="sm">All receipts</LinkButton>}>
        {bandExpenses.length === 0 ? (
          <p className="mb-3 text-sm text-muted">No expenses for {band.name} yet.</p>
        ) : (
          <div className="mb-4">
            <ExpenseTable
              rows={bandExpenses.slice(0, 5)}
              files={expenseFiles}
              personName={(pid) => names.person.get(pid)}
              bandName={(bid) => names.band.get(bid)}
              projectName={(pid) => allProjects.find((p) => p.id === pid)?.name}
              mode="admin"
              payees={new Map(allPeople.map((p) => [p.id, p]))}
            />
          </div>
        )}
        <Disclosure summary="+ Add an expense">
          <ExpenseForm bands={[band]} releases={releases} people={bandPeople} bandId={id} projects={allProjects} />
        </Disclosure>
      </Card>

      <LabelFunds bandId={id} />

      {ctx.org.kind === "label" && !band.isLabel && <BandAccountLink labelOrgId={orgId} bandId={id} bandName={band.name} />}

      {band.isLabel && (
        <Callout tone="neutral">
          This is the label itself. It holds releases under the label’s own name, like label tapes and compilations. Unless you
          set a split below, the label keeps what these releases earn. On compilations, tracks by your bands go to those bands,
          and tracks by other artists go to their <Link href="/catalog#outside-artists">contacts</Link>.
        </Callout>
      )}

      <Card title="Members">
        {members.length === 0 ? (
          <Empty>No members yet.</Empty>
        ) : (
          // Rows expand full-width to edit, rather than squeezing a form into a table cell.
          <div className="mb-4 text-sm">
            <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1.5fr)_auto] gap-3 border-b border-border px-2.5 py-1.5 text-xs text-muted lowercase">
              <span>person</span>
              <span>roles</span>
              <span>paypal</span>
              <span />
            </div>
            {members.map((m) => (
              <details key={m.membershipId} className="group border-b border-border">
                <summary
                  className={`grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1.5fr)_auto] items-center gap-3 px-2.5 py-2 hover:bg-surface-2 ${m.active ? "" : "opacity-50"}`}
                >
                  <span className="font-medium">
                    {m.person.name}
                    {!m.active && <span className="ml-2 text-xs font-normal text-muted">(former member)</span>}
                  </span>
                  <span>
                    <RolesList roles={m.roles} />
                  </span>
                  <span className="truncate text-xs text-muted">
                    {[m.person.email, payHandlesSummary(m.person)].filter(Boolean).join(" · ") || (
                      <span className="text-warn">no payment details — click to add</span>
                    )}
                  </span>
                  <span className="text-xs text-link">
                    <span className="group-open:hidden">edit</span>
                    <span className="hidden group-open:inline">close</span>
                  </span>
                </summary>
                <div className="mb-3 border border-border bg-surface-2 p-4">
                  <form action={updateMembership} className="grid gap-4 sm:grid-cols-2">
                    <input type="hidden" name="membershipId" value={m.membershipId} />
                    <Field label="Name">
                      <input name="name" required defaultValue={m.person.name} />
                    </Field>
                    <Field label="Roles in this band (comma-separated)">
                      <input name="roles" defaultValue={m.roles.join(", ")} />
                    </Field>
                    <Field label="PayPal email">
                      <input name="email" type="email" defaultValue={m.person.email ?? ""} />
                    </Field>
                    <Field label="PayPal.me handle (optional)">
                      <input name="paypalMe" defaultValue={m.person.paypalMe ?? ""} placeholder="yourname" />
                    </Field>
                    <Field label="Venmo username (optional)">
                      <input name="venmo" defaultValue={m.person.venmo ?? ""} placeholder="@yourname" />
                    </Field>
                    <Field label="Cash App $cashtag (optional)">
                      <input name="cashtag" defaultValue={m.person.cashtag ?? ""} placeholder="$yourname" />
                    </Field>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="active" defaultChecked={m.active} /> Current member
                    </label>
                    <div className="flex justify-end">
                      <SubmitButton size="sm">Save</SubmitButton>
                    </div>
                  </form>
                  <form action={removeMember} className="mt-4 border-t border-border pt-3">
                    <input type="hidden" name="membershipId" value={m.membershipId} />
                    <SubmitButton variant="danger" size="sm" confirm={`Remove ${m.person.name} from ${band.name}? They stay in the app and any other bands.`}>
                      Remove from this band
                    </SubmitButton>
                  </form>
                </div>
              </details>
            ))}
          </div>
        )}
        <Disclosure summary="+ Add member">
          <form action={addMember} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="bandId" value={id} />
            <Field label="Existing person" className="sm:col-span-2">
              <select name="personId" defaultValue="">
                <option value="">New person (fill in below)</option>
                {allPeople
                  .filter((p) => !memberIds.has(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Name">
              <input name="name" />
            </Field>
            <Field label="PayPal email">
              <input name="email" type="email" />
            </Field>
            <Field label="PayPal.me handle (optional)">
              <input name="paypalMe" placeholder="yourname" />
            </Field>
            <Field label="Venmo username (optional)">
              <input name="venmo" placeholder="@yourname" />
            </Field>
            <Field label="Cash App $cashtag (optional)">
              <input name="cashtag" placeholder="$yourname" />
            </Field>
            <Field label="Roles (comma-separated)">
              <input name="roles" placeholder="vocals, guitar, songwriter" />
            </Field>
            <div className="sm:col-span-2">
              <SubmitButton>Add member</SubmitButton>
            </div>
          </form>
        </Disclosure>
      </Card>

      <Card title="Default split">
        <p className="mb-3 text-sm text-muted">Used for every sale of this band unless a release, track or item-type split below applies.</p>
        <SplitRules
          rules={defaultRules}
          people={personOptions}
          scope={{ scope: "band_default", bandId: id }}
          emptyText={
            labelDefault
              ? "No default split of its own, so it uses the label-wide default (below)."
              : "No default split yet. Sales without a more specific split will be flagged."
          }
        />
        {defaultRules.length === 0 && labelDefault && (
          <p className="mt-3 border-l-2 border-accent pl-3 text-sm">
            Label-wide default: <LabelDefaultSummary shares={labelDefault.shares} people={personOptions} />.{" "}
            {members.filter((m) => m.active).length === 0 && <span className="text-bad">This band has no current members yet, so nobody would get the rest. </span>}
            <Link href="/rules">Change it</Link>
          </p>
        )}
      </Card>

      <Card title="Splits by item type">
        <p className="mb-4 text-sm text-muted">
          Optional. For example, split merch evenly while music follows songwriting shares. These apply when the sale has no
          release/track split, unless you tick “use this even when the release/track has its own split”.
        </p>
        <div className="divide-y divide-border border-y border-border">
          {ITEM_CATEGORIES.filter((c) => c.value !== "other").map((c) => {
            const rules = itemTypeRules.get(c.value) ?? [];
            return (
              <div key={c.value} className="py-3">
                <h3 className="mb-2 text-sm font-medium">
                  {c.label}
                  {rules.length === 0 && (
                    <span className="ml-2 font-normal text-muted">
                      · {defaultRules.length || (!band.isLabel && labelDefault) ? `uses the ${fallbackSplit} split` : fallbackSplit}
                    </span>
                  )}
                </h3>
                <SplitRules
                  rules={rules}
                  people={personOptions}
                  scope={{ scope: "band_item_type", bandId: id, itemCategory: c.value }}
                  emptyText=""
                  showOverride
                />
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Releases" actions={<LinkButton href={`/catalog?band=${id}`} size="sm">Open in catalog</LinkButton>}>
        {music.length === 0 ? (
          <Empty>No releases yet. They sync from Bandcamp automatically (see Settings for your Bandcamp address), or add them here, or create them from sales under Sales → Import.</Empty>
        ) : (
          itemTable(music)
        )}
        <Disclosure summary="+ Add release">
          <form action={saveRelease} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="bandId" value={id} />
            <input type="hidden" name="open" value="true" />
            <Field label="Title">
              <input name="title" required />
            </Field>
            <Field label="Bandcamp URL">
              <input name="url" placeholder="https://….bandcamp.com/album/…" />
            </Field>
            <Field label="Catalog number">
              <input name="catalogNumber" />
            </Field>
            <Field label="Release date">
              <input name="releaseDate" type="date" />
            </Field>
            <div className="sm:col-span-2">
              <SubmitButton>Add release</SubmitButton>
            </div>
          </form>
        </Disclosure>
      </Card>

      <Card title="Physical formats">
        <PhysicalFormatsTable
          releases={music}
          empty="No CDs, vinyl or cassettes. They come in with each release when it syncs from Bandcamp."
          costs={itemCosts}
        />
      </Card>

      <Card title="Standalone merch">
        {merch.length === 0 ? (
          <Empty>No shirts, posters or other merch. They sync from Bandcamp automatically.</Empty>
        ) : (
          itemTable(merch)
        )}
      </Card>

      <Card title="Band deductions">
        <p className="mb-3 text-sm text-muted">Taken after any label-wide deductions.</p>
        <DeductionList
          people={bandPeople}
          items={bandDeductions}
          names={names}
          bands={[]}
          releases={releaseOpts}
          fixedBandId={id}
        />
        <div className="mt-3">
          <Disclosure summary="+ Add deduction">
            <DeductionForm people={bandPeople} bands={[]} releases={releaseOpts} fixedBandId={id} />
          </Disclosure>
        </div>
      </Card>

      <Card title="Band settings">
        <BandFields band={band} />
        <form action={deleteBand} className="mt-8 border-t border-border pt-4">
          <input type="hidden" name="id" value={id} />
          <p className="mb-2 text-sm text-muted">Deleting the band also deletes its releases, splits and deductions. Its sales become unmatched.</p>
          <SubmitButton variant="danger" size="sm" confirm={`Delete ${band.name}? Its releases, splits and deductions are deleted too, and its sales become unrouted.`}>
            Delete band
          </SubmitButton>
        </form>
      </Card>
    </>
  );
}
