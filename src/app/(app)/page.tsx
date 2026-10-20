import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { ChartBoard } from "@/components/chart-board";
import { OrdersNotice } from "@/components/orders-notice";
import { owedChart } from "@/components/owed";
import { type BoardChart, breakdownChart, seriesChart } from "@/lib/chart-data";
import { loadLayout } from "@/server/chart-layouts";
import { parseSalesFilter, summarizeSales } from "@/server/sales-browse";
import { Badge, Callout, Card, LinkButton, Money, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { plural, someNames } from "@/lib/plural";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { outsideArtistRows } from "@/components/outside-artists";
import { SyncFooter } from "@/components/sync-status";
import { setSetupHidden } from "@/server/actions";
import { requireAccess } from "@/server/context";
import { computeAllTime } from "@/server/data";
import { labelPartFor } from "@/server/own-books";
import { BandProjects } from "@/components/band-projects";
import type { PeriodSummary } from "@/lib/splits";

export const metadata = { title: "dashboard" };

export default async function Dashboard() {
  await connection();
  const ctx = await requireAccess("dashboard");
  const { orgId, isAdmin } = ctx;
  // A band account the label made: its own books, with what the label has for its band added in.
  const m = ctx.managedBy;
  const [bands, memberships, defaults, saleRows, periods, outside, { summary }, people, releaseRows, fundExpenses] = await Promise.all([
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)),
    db.select().from(schema.bandMemberships).where(eq(schema.bandMemberships.orgId, orgId)),
    db
      .select()
      .from(schema.splitRules)
      .where(and(eq(schema.splitRules.orgId, orgId), inArray(schema.splitRules.scope, ["band_default", "label_default"]))),
    db.select({ bandId: schema.sales.bandId }).from(schema.sales).where(eq(schema.sales.orgId, orgId)),
    db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId)).orderBy(desc(schema.periods.startDate)).limit(5),
    outsideArtistRows(orgId),
    computeAllTime(orgId),
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)),
    db.select({ id: schema.releases.id }).from(schema.releases).where(eq(schema.releases.orgId, orgId)),
    // Band funds pay for some expenses; what's held is what went in, less what they paid for.
    db
      .select()
      .from(schema.expenses)
      .where(and(eq(schema.expenses.orgId, orgId), eq(schema.expenses.status, "approved"), eq(schema.expenses.paidBy, "band_fund"))),
  ]);
  const saleCount = saleRows.length;
  const unrouted = saleRows.filter((s) => s.bandId === null).length;
  const needContacts = outside.filter((r) => r.needsContact);
  const releaseCount = releaseRows.length;
  // Bands still missing members, and members still missing PayPal details.
  const active = memberships.filter((m) => m.active);
  const bandsWithoutMembers = bands.filter((b) => !active.some((m) => m.bandId === b.id));
  const unpayable = people.filter((p) => active.some((m) => m.personId === p.id) && !p.holdsLabelAccount && !p.email && !p.paypalMe && !p.venmo && !p.cashtag);
  const memberHint = [
    bandsWithoutMembers.length ? `No members yet: ${someNames(bandsWithoutMembers.map((b) => b.name))}.` : "",
    unpayable.length ? `No payment details: ${someNames(unpayable.map((p) => p.name))}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const isBand = ctx.org.kind === "band";
  const [[settingsRow], labelCuts, [paidLine]] = await Promise.all([
    db
      .select({
        setupHidden: schema.accountSettings.setupHidden,
        forGood: schema.accountSettings.setupHiddenForGood,
        bandcampUrl: schema.accountSettings.bandcampUrl,
        keepsNothing: schema.accountSettings.labelKeepsNothing,
      })
      .from(schema.accountSettings)
      .where(eq(schema.accountSettings.orgId, orgId)),
    db
      .select({ id: schema.deductions.id })
      .from(schema.deductions)
      .where(and(eq(schema.deductions.orgId, orgId), eq(schema.deductions.destination, "label")))
      .limit(1),
    db
      .select({ id: schema.payouts.id })
      .from(schema.payouts)
      .where(and(eq(schema.payouts.orgId, orgId), inArray(schema.payouts.status, ["paid", "kept"])))
      .limit(1),
  ]);
  const splitsSet = bands.length > 0 && (defaults.some((d) => d.scope === "label_default") || bands.every((b) => defaults.some((d) => d.bandId === b.id)));
  // A band account the label made has nothing to set up: the label brings in its band, members and
  // sales, and its own books are there for when it needs them.
  const steps = m ? [] : [
    {
      done: !!settingsRow?.bandcampUrl || releaseCount > 0,
      label: isBand ? "Add your Bandcamp address, so your releases and merch come in by themselves" : "Add your Bandcamp address, so your bands, releases and merch come in by themselves",
      href: "/settings",
      hint: "",
    },
    ...(isBand ? [] : [{ done: bands.length > 0, label: "Add your bands", href: "/directory", hint: "Or let them come in from Bandcamp." }]),
    {
      done: bands.length > 0 && bandsWithoutMembers.length === 0 && unpayable.length === 0,
      label: isBand ? "Add the band’s members, with how to pay them" : "Add members to each band, with how to pay them",
      href: isBand && bands[0] ? `/bands/${bands[0].id}?tab=people` : "/directory",
      hint: bands.length ? memberHint : "",
    },
    ...(isBand
      ? []
      : [{ done: labelCuts.length > 0 || !!settingsRow?.keepsNothing, label: "Decide what the label keeps from each sale", href: "/rules#label-cut", hint: "" }]),
    {
      done: splitsSet,
      label: isBand ? "Decide how you split what you earn" : "Decide how each band splits its share",
      href: isBand && bands[0] ? `/bands/${bands[0].id}?tab=money` : "/rules",
      hint: isBand ? "" : "One label-wide split for every band, or each band’s own.",
    },
    { done: saleCount > 0, label: "Bring in your sales: import a Bandcamp sales report", href: "/sales/import", hint: "" },
    { done: !!paidLine, label: "Make a payout and pay people", href: "/periods", hint: "" },
  ];
  // The header's highlighted button is whatever should happen next.
  const next = saleCount === 0 ? "import" : "payout";
  const setupDone = steps.every((s) => s.done);
  const setupHidden = settingsRow?.setupHidden ?? false;
  const setupGone = settingsRow?.forGood ?? false;
  const stepsLeft = steps.filter((s) => !s.done).length;

  // The customizable charts: net sales by band and who's owed what, with more to add.
  const [all, owed, saved, fromLabel] = await Promise.all([
    summarizeSales(m ? { own: orgId, label: { orgId: m.labelOrgId, bandId: m.bandId } } : orgId, parseSalesFilter({})),
    owedChart(orgId),
    loadLayout("dashboard"),
    m ? labelPartFor(m.labelOrgId, m.bandId) : null,
  ]);
  const net = all.totals[0]?.net ?? 0;
  const typeLabel = (k: string) => ({ album: "Album", track: "Track", merch: "Merch", other: "Other" })[k] ?? k;
  const charts: BoardChart[] = [
    breakdownChart("band", "Net sales by band", all.byBand, { currency: all.main, total: net, trend: all.trends.band }),
    owed,
    seriesChart("month", "Net received by month", all.byMonth.map((m) => ({ month: m.month, value: m.net, units: m.units })), { currency: all.main }),
    breakdownChart("type", "By type", all.byType.map((r) => ({ ...r, key: typeLabel(r.key) })), {
      currency: all.main,
      total: net,
      trend: { ...all.trends.type, series: all.trends.type.series.map((x) => ({ ...x, key: typeLabel(x.key) })) },
    }),
    breakdownChart("item", "Top items", all.byItem, { currency: all.main, total: net, trend: all.trends.item }),
    breakdownChart("country", "By country", all.byCountry, { currency: all.main, total: net, trend: all.trends.country }),
  ];

  // All-time, per currency: this account's own, plus (a band account the label made) the label's for its band.
  // (In a band's group, what its own books keep is the band's; what the label keeps of its sales is the label's.)
  const figures = new Map<string, { net: number; label: number; labelThrough: number; funds: number; people: number }>();
  const addUp = (s: PeriodSummary, fundsSpent: { currency: string; amountCents: number }[], through = false) => {
    for (const cur of s.currencies) {
      const c = s.byCurrency[cur];
      const dest = (k: string) => [...c.byDestination].filter(([key]) => key === k || key.startsWith(`${k}:`)).reduce((a, [, v]) => a + v, 0);
      const f = figures.get(cur) ?? { net: 0, label: 0, labelThrough: 0, funds: 0, people: 0 };
      f.net += c.grossCents;
      if (through) f.labelThrough += dest("label");
      else f.label += dest("label");
      // Band funds pay for some expenses; what's held is what went in, less what they paid for.
      f.funds += dest("band_fund") - fundsSpent.filter((e) => e.currency === cur).reduce((a, e) => a + e.amountCents, 0);
      f.people += [...c.byPerson.values()].reduce((a, p) => a + p.total, 0);
      figures.set(cur, f);
    }
  };
  addUp(summary, fundExpenses);
  if (fromLabel) addUp(fromLabel.summary, fromLabel.fundsSpent, true);
  // The latest payouts, the label's that paid the band's members among them.
  const recent = [
    ...periods.map((p) => ({ key: `own-${p.id}`, href: `/periods/${p.id}`, period: p, through: null as string | null })),
    ...(fromLabel?.payouts ?? []).map(({ period }) => ({
      key: `label-${period.id}`,
      href: `/from-label/${m!.linkId}/statement/${period.id}`,
      period,
      through: m!.labelName,
    })),
  ]
    .sort((a, b) => b.period.startDate.localeCompare(a.period.startDate))
    .slice(0, 5);

  return (
    <>
      <PageHeader
        title="Dashboard"
        actions={
          <>
            <LinkButton href="/sales/import" variant={next === "import" ? "primary" : "secondary"}>
              Import sales
            </LinkButton>
            <LinkButton href="/periods" variant={next === "payout" ? "primary" : "secondary"}>
              Pay out
            </LinkButton>
          </>
        }
      />


      <Suspense fallback={null}>
        <OrdersNotice ctx={ctx} />
      </Suspense>

      {unrouted > 0 && (
        <Callout tone="bad">
          {plural(unrouted, "imported sale")} {unrouted === 1 ? "isn’t" : "aren’t"} matched to a band. <Link href="/sales/import" className="underline">Fix on the Import page</Link>.
        </Callout>
      )}

      {needContacts.length > 0 && (
        <Callout>
          {needContacts.length} artist{needContacts.length === 1 ? " who isn’t" : "s who aren’t"} on the label{" "}
          {needContacts.length === 1 ? "appears" : "appear"} on your releases and {needContacts.length === 1 ? "needs" : "need"} a
          contact to be paid: {someNames(needContacts.map((r) => r.artist.name))}.{" "}
          <Link href="/catalog#outside-artists">Add contacts</Link>
        </Callout>
      )}

      {isAdmin && !setupDone && !setupHidden && (
        <Card
          title="Getting started"
          actions={
            <form action={setSetupHidden}>
              <input type="hidden" name="hidden" value="1" />
              <button
                type="submit"
                aria-label="Hide the getting started checklist"
                className="flex h-7 w-7 items-center justify-center rounded-sm text-lg leading-none text-muted hover:bg-surface-2 hover:text-text"
              >
                ×
              </button>
            </form>
          }
        >
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={s.label} className="flex items-start gap-3 text-sm">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${s.done ? "bg-good-bg text-good" : "bg-surface-2 text-muted"}`}>
                  {s.done ? "✓" : i + 1}
                </span>
                <span className="pt-0.5">
                  <Link href={s.href} className={s.done ? "text-muted line-through" : "hover:underline"}>
                    {s.label}
                  </Link>
                  {!s.done && s.hint && <span className="block text-xs text-muted">{s.hint}</span>}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* The main currency (the most sales) first. */}
      {[...figures].sort((a, b) => b[1].net - a[1].net).map(([cur, f]) => (
        <Card key={cur} title={`All-time${figures.size > 1 ? ` (${cur})` : ""}`}>
          <div className={`mb-6 grid grid-cols-2 gap-4 ${isBand && m ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
            <Figure label="Net sales" cents={f.net} currency={cur} />
            {isBand ? (
              <>
                <Figure label="Kept by the band" cents={f.label} currency={cur} />
                {m && <Figure label={`Kept by ${m.labelName}`} cents={f.labelThrough} currency={cur} />}
              </>
            ) : (
              <Figure label="Label income" cents={f.label} currency={cur} />
            )}
            <Figure label="Held in band funds" cents={f.funds} currency={cur} />
            <Figure label="Earned by people" cents={f.people} currency={cur} />
          </div>
        </Card>
      ))}

      <ChartBoard boardId="dashboard" charts={charts} saved={saved} />

      {/* A band account the label made: its projects in the label's books. */}
      {m && <BandProjects labelOrgId={m.labelOrgId} bandId={m.bandId} />}

      <div>
        <Card title="Recent payouts" actions={<LinkButton href="/periods" size="sm">All</LinkButton>}>
          {recent.length === 0 ? (
            <p className="text-sm text-muted">None yet.</p>
          ) : (
            <ul className="space-y-2">
              {recent.map(({ key, href, period: p, through }) => (
                <li key={key} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    <Link href={href} className="hover:underline">
                      {p.name}
                    </Link>
                    {through && <span className="text-muted"> · through {through}</span>}
                  </span>
                  <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {isAdmin && !setupDone && setupHidden && !setupGone && (
        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted">
          <form action={setSetupHidden}>
            <input type="hidden" name="hidden" value="0" />
            {stepsLeft} setup step{stepsLeft === 1 ? "" : "s"} left.{" "}
            <button type="submit" className="underline hover:text-text">
              Show the getting started checklist
            </button>
          </form>
          <form action={setSetupHidden}>
            <input type="hidden" name="hidden" value="forever" />
            <button
              type="submit"
              aria-label="Don’t remind me about setup again"
              className="flex h-5 w-5 items-center justify-center rounded-sm text-base leading-none hover:bg-surface-2 hover:text-text"
            >
              ×
            </button>
          </form>
        </div>
      )}
      <SyncFooter orgId={orgId} />
    </>
  );
}

function Figure({ label, cents, currency }: { label: string; cents: number; currency: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold">
        <Money cents={cents} currency={currency} />
      </div>
    </div>
  );
}
