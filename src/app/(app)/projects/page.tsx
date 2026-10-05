import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ProjectForm } from "@/components/project-form";
import { Badge, Card, Disclosure, Empty, Money, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { requireAdmin } from "@/server/context";
import { projectReleaseMap } from "@/server/expenses";
import { accountProjects, projectNumbers } from "@/server/projects";

/** Every project, with what it cost against what its releases have made back. */
export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  await connection();
  const { orgId } = await requireAdmin();
  const bandFilter = Number((await searchParams).band) || undefined;
  const [projects, numbers, links, bands, releases] = await Promise.all([
    accountProjects(orgId),
    projectNumbers(orgId),
    projectReleaseMap(orgId),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId)).orderBy(asc(schema.releases.title)),
  ]);
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  const shown = projects
    .filter((p) => !bandFilter || p.bandId === bandFilter)
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Albums, EPs, tours, videos: what each one cost, and what its releases have made back on Bandcamp."
      />
      <Card>
        {shown.length === 0 ? (
          <Empty>No projects yet. Create one, then assign expenses to it from Receipts.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Project</th>
                  <th className="num">Spent</th>
                  <th className="num">Made back</th>
                  <th>Made back of what was spent</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const n = numbers.get(p.id)!;
                  const pct = n.spent ? Math.round((n.madeBack / n.spent) * 100) : null;
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/projects/${p.id}`} className="font-medium">
                          {p.name}
                        </Link>
                        <div className="text-xs text-muted">
                          {p.bandId ? bandName.get(p.bandId) : "whole label"} · {(links.get(p.id) ?? []).length} release
                          {(links.get(p.id) ?? []).length === 1 ? "" : "s"}
                          {p.status === "done" && (
                            <>
                              {" "}
                              · <Badge>done</Badge>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="num">
                        <Money cents={n.spent} currency={n.currency} />
                      </td>
                      <td className="num">
                        <Money cents={n.madeBack} currency={n.currency} />
                      </td>
                      <td className="min-w-40">
                        {pct === null ? (
                          <span className="text-xs text-muted">nothing spent yet</span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <span className="h-2 flex-1 rounded-full bg-surface-2" aria-hidden>
                              <span
                                className="block h-2 rounded-full bg-chart-accent"
                                style={{ width: `${Math.min(100, Math.max(0, pct))}%`, minWidth: pct > 0 ? 2 : 0 }}
                              />
                            </span>
                            <span className="w-10 text-right text-xs tabular-nums">{pct}%</span>
                          </span>
                        )}
                      </td>
                      <td className={`num font-medium ${n.balance >= 0 ? "text-good" : ""}`}>
                        <Money cents={n.balance} currency={n.currency} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4">
          <Disclosure summary="+ New project">
            <ProjectForm bands={bands} releases={releases} bandId={bandFilter} />
          </Disclosure>
        </div>
      </Card>
    </>
  );
}
