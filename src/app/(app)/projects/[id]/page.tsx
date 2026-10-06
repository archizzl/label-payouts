import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BarList, SpentVsMadeBack } from "@/components/charts";
import { SubmitButton } from "@/components/client";
import { ProjectForm } from "@/components/project-form";
import { ExpenseForm, ExpenseTable } from "@/components/receipts";
import { Badge, Callout, Card, Disclosure, Empty, Money, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { requireAdmin } from "@/server/context";
import { nameMaps } from "@/server/data";
import { expenseFileList } from "@/server/expenses";
import { deleteProject } from "@/server/project-actions";
import { accountProjects, projectNumbers } from "@/server/projects";

/** One project: what it cost, what its releases made back on Bandcamp, and where it stands. */
export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  await connection();
  const { orgId } = await requireAdmin();
  const id = Number((await params).id);
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.orgId, orgId), eq(schema.projects.id, id)));
  if (!project) notFound();

  const [numbers, links, expenses, files, names, bands, releases, people, projects] = await Promise.all([
    projectNumbers(orgId, id),
    db.select().from(schema.projectReleases).where(eq(schema.projectReleases.projectId, id)),
    db
      .select()
      .from(schema.expenses)
      .where(and(eq(schema.expenses.orgId, orgId), eq(schema.expenses.projectId, id)))
      .orderBy(asc(schema.expenses.date)),
    expenseFileList(orgId),
    nameMaps(orgId),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId)).orderBy(asc(schema.releases.title)),
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
    accountProjects(orgId),
  ]);
  const n = numbers.get(id)!;
  const cur = n.currency;
  const pct = n.spent ? Math.round((n.madeBack / n.spent) * 100) : null;
  const budgetPct = project.budgetCents ? Math.round((n.spent / project.budgetCents) * 100) : null;
  const releaseIds = links.map((l) => l.releaseId);

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {project.name} {project.status === "done" ? <Badge>done</Badge> : <Badge tone="accent">in progress</Badge>}
          </span>
        }
        subtitle={
          <>
            {project.bandId ? <Link href={`/bands/${project.bandId}`}>{names.band.get(project.bandId)}</Link> : "whole label"}
            {project.startDate && <> · started {project.startDate}</>}
            {n.firstSale && <> · first sale {n.firstSale}</>}
            {project.notes && <> · {project.notes}</>}
          </>
        }
        actions={
          <form action={deleteProject}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton variant="ghost" size="sm" confirm={`Delete “${project.name}”? Its expenses stay, just without a project.`}>
              Delete project
            </SubmitButton>
          </form>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Spent" value={formatCents(n.spent, cur)} hint={n.pending ? `+ ${formatCents(n.pending, cur)} waiting for approval` : undefined} />
        <Stat label="Made back on Bandcamp" value={formatCents(n.madeBack, cur)} hint={`${n.units} item${n.units === 1 ? "" : "s"} sold`} />
        <Stat
          label={n.spent === 0 ? "Balance" : n.balance >= 0 ? "Ahead by" : "Still to make back"}
          value={formatCents(Math.abs(n.balance), cur)}
          hint={pct === null ? "nothing spent yet" : `${pct}% of what was spent`}
          tone={n.balance >= 0 && n.spent > 0 ? "good" : undefined}
          emphasis
        />
        <Stat
          label="Budget"
          value={project.budgetCents ? formatCents(project.budgetCents, cur) : "—"}
          hint={budgetPct === null ? "none set" : `${budgetPct}% used${budgetPct > 100 ? ", over budget" : ""}`}
          tone={budgetPct !== null && budgetPct > 100 ? "warn" : undefined}
        />
      </div>

      {releaseIds.length === 0 && (
        <Callout>No releases attached yet, so nothing counts as made back. Edit the project to choose its releases and merch.</Callout>
      )}
      {n.otherCurrencies.length > 0 && (
        <Callout tone="neutral">
          Also has sales or expenses in {n.otherCurrencies.join(", ")}; those aren’t converted, so they’re not in these {cur} totals.
        </Callout>
      )}

      {n.monthly.length > 1 && (
        <Card title="Spent vs made back over time">
          <SpentVsMadeBack data={n.monthly} currency={cur} budget={project.budgetCents} />
        </Card>
      )}

      <div className="grid gap-x-8 md:grid-cols-2">
        <Card title="Where the money went">
          {n.byCategory.length === 0 ? (
            <Empty>No approved expenses yet.</Empty>
          ) : (
            <BarList
              data={n.byCategory.map((c) => ({ key: c.category, net: c.cents, units: 0 }))}
              currency={cur}
              total={n.spent}
              share="of spending"
              showUnits={false}
            />
          )}
        </Card>
        <Card title="Where the money made back went">
          {n.madeBack === 0 ? (
            <Empty>No sales yet.</Empty>
          ) : (
            <table className="data">
              <tbody>
                <Row label="Paid to people" cents={n.toPeople} cur={cur} />
                <Row label="Kept by the label" cents={n.labelKept} cur={cur} />
                {n.bandFunds !== 0 && <Row label="Into band funds" cents={n.bandFunds} cur={cur} />}
                <Row label="Of which paid back this project’s costs" cents={n.recouped} cur={cur} muted />
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Releases">
        {n.byRelease.length === 0 ? (
          <Empty>None attached.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Release</th>
                <th className="num">Sold</th>
                <th className="num">Made back</th>
              </tr>
            </thead>
            <tbody>
              {n.byRelease.map((r) => (
                <tr key={r.releaseId}>
                  <td>
                    <span className="flex items-center gap-2.5">
                      {r.artUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.artUrl.replace(/_(10|16)\.jpg$/, "_3.jpg")} alt="" className="h-6 w-6 border border-border object-cover" />
                      ) : (
                        <span className="h-6 w-6 bg-surface-2" />
                      )}
                      <Link href={`/catalog/${r.releaseId}`}>{r.title}</Link>
                      {r.kind === "merch" && <span className="text-xs text-muted">merch</span>}
                    </span>
                  </td>
                  <td className="num">{r.units}</td>
                  <td className="num">
                    <Money cents={r.net} currency={cur} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Expenses">
        <div className="mb-4">
          <Disclosure summary="+ Add an expense">
            <ExpenseForm bands={bands} releases={releases} people={people} projects={projects} projectId={id} bandId={project.bandId ?? undefined} />
          </Disclosure>
        </div>
        <ExpenseTable
          rows={[...expenses].reverse()}
          files={files}
          personName={(pid) => names.person.get(pid)}
          bandName={(bid) => names.band.get(bid)}
          mode="admin"
          edit={(e) => <ExpenseForm expense={e} bands={bands} releases={releases} people={people} projects={projects} />}
          payees={new Map(people.map((p) => [p.id, p]))}
        />
      </Card>

      <Card title="Project settings">
        <Disclosure summary="Edit project">
          <ProjectForm project={project} releaseIds={releaseIds} bands={bands} releases={releases} />
        </Disclosure>
      </Card>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "warn";
  emphasis?: boolean;
}) {
  const color = tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : emphasis ? "text-accent" : "";
  return (
    <div className={`border-l-2 pl-3 ${emphasis ? "border-accent" : "border-border"}`}>
      <div className="text-xs text-muted lowercase">{label}</div>
      <div className={`mt-0.5 text-xl font-bold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

function Row({ label, cents, cur, muted }: { label: string; cents: number; cur: string; muted?: boolean }) {
  return (
    <tr>
      <td className={muted ? "text-muted" : ""}>{label}</td>
      <td className={`num ${muted ? "text-muted" : ""}`}>
        <Money cents={cents} currency={cur} />
      </td>
    </tr>
  );
}
