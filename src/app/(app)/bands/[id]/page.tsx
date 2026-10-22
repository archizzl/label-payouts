import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { BandFields } from "@/components/band-fields";
import { SaveWhenChanged, SubmitButton } from "@/components/client";
import { SalesSection } from "@/components/sales-section";
import { DeductionForm, DeductionList } from "@/components/deductions";
import { BandTabs } from "@/components/band-tabs";
import { ItemCosts } from "@/components/item-cost";
import { MoneyRules } from "@/components/money-rules";
import { PhysicalFormatsTable, costsFor } from "@/components/physical-formats";
import { LabelDefaultSummary, SplitRules, SharesSummary, currentRule } from "@/components/split-rules";
import type { PersonOption } from "@/components/split-editor";
import { Badge, Callout, Card, Disclosure, Empty, Field, LinkButton, Money, MoneyList, PageHeader, RolesList } from "@/components/ui";
import { db, schema } from "@/db";
import { ITEM_CATEGORIES } from "@/lib/bandcamp-csv";
import { possessive } from "@/lib/plural";
import { payHandlesSummary } from "@/lib/paypal-export";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { BandAccountButtons, LinkedBandAccount } from "@/components/band-link";
import { ensureBandAccounts } from "@/server/band-accounts";
import { linkForLabelBand } from "@/server/links";
import { LabelFunds } from "@/components/label-funds";
import { ExpenseForm, ExpenseTable } from "@/components/receipts";
import { deleteBand, removeMember, saveRelease, updateMembership } from "@/server/actions";
import { bandScope, can } from "@/lib/permissions";
import { getContext, ownBooksOf, requireAccess } from "@/server/context";
import { projectsEnabled } from "@/server/features";
import { accountExpenses, expenseFileList } from "@/server/expenses";
import { accountProjects, projectNumbers } from "@/server/projects";
import { loginEmails } from "@/server/people";
import { bandAssociatedPeople, bandMembers, computeAllTime, labelHost, nameMaps, ruleFilter, rulesWhere } from "@/server/data";

/** The tab's title: the band's name. */
export async function generateMetadata({ params }: PageProps<"/bands/[id]">) {
  // (A band account the label made: its splits, in its own books.)
  const lens = await getContext();
  const { orgId, access } = lens.lens ? await ownBooksOf(lens) : lens;
  const id = Number((await params).id);
  const scope = bandScope(access, "roster");
  if (!can(access, "roster") || (scope && !scope.includes(id))) return { title: "band" };
  const [band] = await db
    .select({ name: schema.bands.name })
    .from(schema.bands)
    .where(and(eq(schema.bands.orgId, orgId), eq(schema.bands.id, id)));
  return { title: band?.name ?? "band" };
}

export default async function BandPage({ params, searchParams }: PageProps<"/bands/[id]">) {
  await connection();
  let ctx = await requireAccess("roster");
  // A band account the label made: its band's page in its own books is its splits (its people are
  // in the Directory, the label's).
  const lens = ctx.lens;
  if (lens) ctx = await requireAccess("rules");
  const { orgId } = ctx;
  const id = Number((await params).id);
  const sp = await searchParams;
  const tab = (["overview", "money", "people", "catalog", "settings"] as const).find((t) => t === sp.tab) ?? "overview";
  // A band account the label made, in its own books: the band and its members come from the label's
  // books, so they're changed there (the band on Settings, its members in the Directory).
  const ownBooks = ctx.books === "own";
  // A band account (its own books, or a band that runs its own account): the band's settings are its Settings.
  const settingsElsewhere = ownBooks || ctx.org.kind === "band";
  if (settingsElsewhere && tab === "settings") redirect("/settings");
  // A band account: this page is just its splits (its "splits" tab); the rest of it is what the
  // dashboard, Directory and Catalog already show.
  const splitsOnly = ctx.org.kind === "band";
  if (splitsOnly && tab !== "money") redirect({ overview: "/", people: "/directory", catalog: "/catalog", settings: "/settings" }[tab]);
  const [band] = await db
    .select()
    .from(schema.bands)
    .where(and(eq(schema.bands.orgId, orgId), eq(schema.bands.id, id)));
  // (One of the label's bands, from a band account the label made: its people are in the Directory.)
  if (!band && lens) redirect("/directory");
  if (!band) notFound();
  // A band manager sees only their own bands.
  const rosterScope = bandScope(ctx.access, "roster");
  if (rosterScope && !rosterScope.includes(id)) notFound();

  const showProjects = await projectsEnabled();
  // Its account (label admins, on People): undefined for anyone else, or the label's own band.
  const accountRow =
    sp.tab === "people" && ctx.org.kind === "label" && ctx.isAdmin && !band.isLabel
      ? await ensureBandAccounts(orgId).then(() => linkForLabelBand(orgId, id))
      : undefined;
  const [members, allPeople, releases, allReleases, orgDeductions, names, defaultRules, labelRules, bandPeople, periodRows, { summary }, bandExpenses, expenseFiles, allProjects, projectTotals, loginOf] =
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
      showProjects ? accountProjects(orgId) : [],
      showProjects ? projectNumbers(orgId) : new Map<number, never>(),
      loginEmails(orgId),
    ]);
  const bandProjects = allProjects.filter((p) => p.bandId === id);
  const personOptions: PersonOption[] = [
    ...members.filter((m) => m.active).map((m) => ({ id: m.person.id, name: m.person.name, roles: m.roles, inBand: true })),
    ...allPeople.filter((p) => !members.some((m) => m.active && m.person.id === p.id)).map((p) => ({ id: p.id, name: p.name, inBand: false })),
  ];
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

  // Payouts that paid this band: its own, and whole-label ones that paid someone for its sales
  // (not every whole-label payout: a band nobody was paid for wasn't in it).
  const paidLines = await db
    .select({ periodId: schema.payouts.periodId, byBand: schema.payouts.byBand })
    .from(schema.payouts)
    .where(eq(schema.payouts.orgId, orgId));
  const paidThisBand = new Set(paidLines.filter((l) => (l.byBand[String(id)] ?? 0) !== 0).map((l) => l.periodId));
  const bandPeriods = periodRows
    .filter((p) => p.bandId === id || (p.bandId === null && paidThisBand.has(p.id)))
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
  // Nothing would be paid to anyone: no split of its own, and no label-wide one to fall back on.
  const needsSplit = !band.isLabel && defaultRules.length === 0 && !labelDefault;
  /** What a sale with no more specific split falls back to, in words. */
  const fallbackSplit = defaultRules.length ? "band default" : band.isLabel ? "label keeps it" : labelDefault ? "label-wide default" : "no split set";

  /** Releases or merch items: tiny artwork, title and details, and the split they use. */
  const itemTable = (items: typeof releases) => (
    <div className="overflow-x-auto">
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
    </div>
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
      {ctx.org.kind === "label" && (
        <Link href={`/directory#band-${id}`} className="-mt-3 mb-3 inline-block text-sm">
          ← Directory
        </Link>
      )}
      {splitsOnly ? (
        <PageHeader title="Splits" />
      ) : (
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

          <BandTabs bandId={id} active={tab} needsSplit={needsSplit} members={members.filter((m) => m.active).length} noSettings={settingsElsewhere} />
        </>
      )}

      {band.isLabel && (
        <Callout tone="neutral">
          This is the label itself. It holds releases under the label’s own name. Unless you
          set a split below, the label keeps what these releases earn. On compilations, tracks by your bands go to those bands,
          and tracks by other artists go to their <Link href="/catalog#outside-artists">contacts</Link>.
        </Callout>
      )}

      {tab === "overview" && (
        <>
          <SalesSection boardId="band-sales" scope={{ bandId: id }} range={sp.range as string | undefined} basePath={`/bands/${id}`} showItems />

          <Card
            title="Payouts"
            actions={
              <LinkButton href={`/periods?band=${id}`} size="sm" variant="primary">
                Pay this band
              </LinkButton>
            }
          >
            {bandPeriods.length === 0 ? (
              <Empty>No payouts for {band.name} yet.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="data">
                  <thead>
                    <tr>
                      <th>payout</th>
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
              </div>
            )}
          </Card>

          {showProjects && (
            <Card title="Projects" actions={<LinkButton href={`/projects?band=${id}`} size="sm">All projects</LinkButton>}>
              {bandProjects.length === 0 ? (
                <p className="text-sm text-muted">
                  No projects yet.{" "}
                  <Link href={`/projects?band=${id}`}>Create one</Link>.
                </p>
              ) : (
                <div className="overflow-x-auto">
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
                </div>
              )}
            </Card>
          )}

          <Card title="Receipts" actions={<LinkButton href={`/receipts?band=${id}`} size="sm">All receipts</LinkButton>}>
            {bandExpenses.length === 0 ? (
              <p className="mb-3 text-sm text-muted">No expenses for {band.name} yet.</p>
            ) : (
              <div className="mb-4">
                <ExpenseTable
                  group={ctx.org.kind === "band" ? "band" : "label"}
                  groupName={ctx.org.name}
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
              <ExpenseForm bands={[band]} releases={releases} people={bandPeople} bandId={id} projects={allProjects} oneBand={ctx.org.kind === "band"} />
            </Disclosure>
          </Card>

          {ctx.org.kind === "label" && <LabelFunds bandId={id} />}

        </>
      )}
      {tab === "money" && (
        <>
          <Card title="Money rules">
            <MoneyRules
              orgId={orgId}
              bandId={id}
              bandName={band.name}
              personName={names.person}
              labelAccount={ctx.org.kind === "label"}
              ownSplits={[...releaseRules.values()].filter(Boolean).length}
            />
          </Card>
          <div id="default-split" />
          <Card title={`${possessive(band.name)} split`}>
            {/* <p className="mb-3 text-sm text-muted">Used for every sale of this band unless a release, track or item-type split below applies.</p> */}
            <SplitRules
              rules={defaultRules}
              people={personOptions}
              scope={{ scope: "band_default", bandId: id }}
              emptyText={
                labelDefault
                  ? "No default split of its own, so it uses the label-wide default (below)."
                  : "No default split yet."
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

          <div id="item-type-splits" />
          <Card title="Splits for a kind of item">
            {/* <p className="mb-4 text-sm text-muted">
              Optional: a different split for merch, digital albums or digital tracks. These apply when the sale has no
              release/track split, unless you tick “use this even when the release/track has its own split”.
            </p> */}
            <div className="divide-y divide-border border-b border-border">
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

          <div id="band-deductions" />
          <Card title="Band funds and costs">
            {/* <p className="mb-3 text-sm text-muted">
              Money taken from {possessive(band.name)} sales before the split: a band fund, costs paid back from sales, per-item costs.
              {ctx.org.kind === "label" && " Taken after anything the label takes."}
            </p> */}
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

        </>
      )}
      {tab === "people" && (
        <>
          <Card title="Members">
            {members.length === 0 ? (
              <Empty>No members yet.</Empty>
            ) : (
              // Rows expand full-width to edit, rather than squeezing a form into a table cell.
              <div className="mb-4 text-sm">
                <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.3fr)_auto] gap-3 border-b border-border px-2.5 py-1.5 text-xs text-muted lowercase sm:grid">
                  <span>person</span>
                  <span>roles</span>
                  <span>paypal</span>
                  <span>account</span>
                  <span />
                </div>
                {members.map((m) => (
                  <details key={m.membershipId} className="group border-b border-border">
                    <summary
                      // On a phone: the name (and edit), then the rest under it.
                      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-2.5 py-2 hover:bg-surface-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.3fr)_auto] sm:gap-3 ${m.active ? "" : "opacity-50"}`}
                    >
                      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                        {m.person.name}
                        {!m.active && <span className="ml-2 text-xs font-normal text-muted">(former member)</span>}
                      </span>
                      <span className="col-span-2 sm:col-span-1">
                        <RolesList roles={m.roles} />
                      </span>
                      <span className="col-span-2 truncate text-xs text-muted sm:col-span-1">
                        {[m.person.email, payHandlesSummary(m.person)].filter(Boolean).join(" · ") || (
                          <span className="text-warn">no payment details — click to add</span>
                        )}
                      </span>
                      <span className="col-span-2 truncate text-xs sm:col-span-1">{loginOf(m.person.id, id)}</span>
                      <span className={`col-start-2 row-start-1 text-xs text-link sm:col-start-auto sm:row-start-auto ${ownBooks ? "invisible" : ""}`}>
                        <span className="group-open:hidden">edit</span>
                        <span className="hidden group-open:inline">close</span>
                      </span>
                    </summary>
                    {!ownBooks && (
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
                          <SaveWhenChanged>
                            <SubmitButton size="sm">Save</SubmitButton>
                          </SaveWhenChanged>
                        </div>
                      </form>
                      <form action={removeMember} className="mt-4 border-t border-border pt-3">
                        <input type="hidden" name="membershipId" value={m.membershipId} />
                        <SubmitButton variant="danger" size="sm" confirm={`Remove ${m.person.name} from ${band.name}? They stay in the app and any other bands.`}>
                          Remove from this band
                        </SubmitButton>
                      </form>
                    </div>
                    )}
                  </details>
                ))}
              </div>
            )}
            {accountRow !== undefined && (
              <div id="band-account" className="flex scroll-mt-4 flex-wrap items-center gap-2">
                <BandAccountButtons labelOrgId={orgId} band={band} row={accountRow} />
              </div>
            )}
          </Card>

          {accountRow !== undefined && <LinkedBandAccount band={band} row={accountRow} />}

        </>
      )}
      {tab === "catalog" && (
        <>
          <Card title="Releases" actions={<LinkButton href={`/catalog?band=${id}`} size="sm">Open in catalog</LinkButton>}>
            {music.length === 0 ? (
              <Empty>No releases yet.</Empty>
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
              empty="No CDs, vinyl or cassettes."
              costs={itemCosts}
            />
          </Card>

          <Card title="Standalone merch">
            {merch.length === 0 ? (
              <Empty>No shirts, posters or other merch.</Empty>
            ) : (
              itemTable(merch)
            )}
          </Card>

        </>
      )}
      {tab === "settings" && (
        <>
          <Card title="Band settings">
            <BandFields band={band} />
            {ctx.org.kind === "label" && (
              <form action={deleteBand} className="mt-8 border-t border-border pt-4">
                <input type="hidden" name="id" value={id} />
                <p className="mb-2 text-sm text-muted">Deleting the band also deletes its releases, splits and deductions. Its sales become unmatched.</p>
                <SubmitButton variant="danger" size="sm" confirm={`Delete ${band.name}? Its releases, splits and deductions are deleted too, and its sales become unrouted.`}>
                  Delete band
                </SubmitButton>
              </form>
            )}
          </Card>
        </>
      )}
    </>
  );
}
