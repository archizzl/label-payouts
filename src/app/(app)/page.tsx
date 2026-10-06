import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ChartBoard } from "@/components/chart-board";
import { owedChart } from "@/components/owed";
import { type BoardChart, breakdownChart, seriesChart } from "@/lib/chart-data";
import { loadLayout } from "@/server/chart-layouts";
import { parseSalesFilter, summarizeSales } from "@/server/sales-browse";
import { Badge, Callout, Card, LinkButton, Money, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { outsideArtistRows } from "@/components/outside-artists";
import { SyncFooter } from "@/components/sync-status";
import { setSetupHidden } from "@/server/actions";
import { requireAdmin } from "@/server/context";
import { computeAllTime } from "@/server/data";

export default async function Dashboard() {
  await connection();
  const { orgId } = await requireAdmin();
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
    bandsWithoutMembers.length ? `No members yet: ${bandsWithoutMembers.map((b) => b.name).join(", ")}.` : "",
    unpayable.length ? `No payment details: ${unpayable.map((p) => p.name).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const steps = [
    { done: bands.length > 0, label: "Add your bands", href: "/bands", hint: "" },
    {
      done: bands.length > 0 && bandsWithoutMembers.length === 0 && unpayable.length === 0,
      label: "Add members to each band, with PayPal details",
      href: "/bands",
      hint: bands.length ? memberHint : "",
    },
    { done: releaseCount > 0, label: "Add your Bandcamp address in Settings, so bands, releases and merch sync automatically", href: "/account", hint: "" },
    {
      done: bands.length > 0 && (defaults.some((d) => d.scope === "label_default") || bands.every((b) => defaults.some((d) => d.bandId === b.id))),
      label: "Set a label-wide default split, or one for each band",
      href: "/rules",
      hint: "",
    },
    { done: saleCount > 0, label: "Import a Bandcamp sales report", href: "/sales/import", hint: "" },
    { done: periods.length > 0, label: "Create a payout period and pay people", href: "/periods", hint: "" },
  ];
  // The header's highlighted button is whatever should happen next.
  const next = saleCount === 0 ? "import" : "payout";
  const setupDone = steps.every((s) => s.done);
  const [settingsRow] = await db
    .select({ setupHidden: schema.accountSettings.setupHidden, forGood: schema.accountSettings.setupHiddenForGood })
    .from(schema.accountSettings)
    .where(eq(schema.accountSettings.orgId, orgId));
  const setupHidden = settingsRow?.setupHidden ?? false;
  const setupGone = settingsRow?.forGood ?? false;
  const stepsLeft = steps.filter((s) => !s.done).length;

  // The customizable charts: net sales by band and who's owed what, with more to add.
  const [all, owed, saved] = await Promise.all([summarizeSales(orgId, parseSalesFilter({})), owedChart(orgId), loadLayout("dashboard")]);
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

      {unrouted > 0 && (
        <Callout tone="bad">
          {unrouted} imported sale(s) aren’t matched to a band. <Link href="/sales/import" className="underline">Fix on the Import page</Link>.
        </Callout>
      )}

      {needContacts.length > 0 && (
        <Callout>
          {needContacts.length} artist{needContacts.length === 1 ? " who isn’t" : "s who aren’t"} on the label{" "}
          {needContacts.length === 1 ? "appears" : "appear"} on your releases and {needContacts.length === 1 ? "needs" : "need"} a
          contact to be paid: {needContacts.map((r) => r.artist.name).join(", ")}.{" "}
          <Link href="/catalog#outside-artists">Add contacts</Link>
        </Callout>
      )}

      {!setupDone && !setupHidden && (
        <Card
          title="Getting started"
          actions={
            <form action={setSetupHidden}>
              <input type="hidden" name="hidden" value="1" />
              <button
                type="submit"
                aria-label="Hide the getting started checklist"
                title="Hide (you can bring it back at the bottom of this page)"
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

      {summary.currencies.map((cur) => {
        const s = summary.byCurrency[cur];
        const dest = (k: string) => [...s.byDestination].filter(([key]) => key === k || key.startsWith(`${k}:`)).reduce((a, [, v]) => a + v, 0);
        return (
          <Card key={cur} title={`All-time${summary.currencies.length > 1 ? ` (${cur})` : ""}`}>
            <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure label="Net sales" cents={s.grossCents} currency={cur} />
              <Figure label="Label income" cents={dest("label")} currency={cur} />
              <Figure
                label="Held in band funds"
                cents={dest("band_fund") - fundExpenses.filter((e) => e.currency === cur).reduce((a, e) => a + e.amountCents, 0)}
                currency={cur}
              />
              <Figure label="Earned by people" cents={[...s.byPerson.values()].reduce((a, p) => a + p.total, 0)} currency={cur} />
            </div>
          </Card>
        );
      })}

      <ChartBoard boardId="dashboard" charts={charts} defaults={[["band"], ["owed"]]} saved={saved} />

      <div>
        <Card title="Recent payout periods" actions={<LinkButton href="/periods" size="sm">All</LinkButton>}>
          {periods.length === 0 ? (
            <p className="text-sm text-muted">None yet.</p>
          ) : (
            <ul className="space-y-2">
              {periods.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`/periods/${p.id}`} className="hover:underline">
                    {p.name}
                  </Link>
                  <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {!setupDone && setupHidden && !setupGone && (
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
              title="Don’t remind me again (you can turn the checklist back on in Settings)"
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
