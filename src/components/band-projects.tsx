import { Card, Money } from "@/components/ui";
import { projectsEnabled } from "@/server/features";
import { accountProjects, projectNumbers } from "@/server/projects";

/** A band's projects in its label's books (spent, made back, balance), read-only: for the band's own group. */
export async function BandProjects({ labelOrgId, bandId }: { labelOrgId: string; bandId: number }) {
  if (!(await projectsEnabled())) return null;
  const [projects, projectTotals] = await Promise.all([accountProjects(labelOrgId), projectNumbers(labelOrgId)]);
  const bandProjects = projects.filter((p) => p.bandId === bandId);
  if (!bandProjects.length) return null;
  return (
    <Card title="Projects">
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
                    {p.name}
                    {p.status === "done" && <span className="ml-2 text-xs text-muted">done</span>}
                  </td>
                  <td className="num">
                    <Money cents={t.spent} currency={t.currency} />
                  </td>
                  <td className="num">
                    <Money cents={t.madeBack} currency={t.currency} />
                  </td>
                  <td className="num">
                    <Money cents={t.balance} currency={t.currency} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
