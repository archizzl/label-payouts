import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { SubmitButton } from "@/components/client";
import { DeductionForm, DeductionList, describeDeduction } from "@/components/deductions";
import { SplitRules } from "@/components/split-rules";
import { Card, Disclosure, Empty, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { deleteRoutingOverride, rerouteAction } from "@/server/actions";
import { requireAccess } from "@/server/context";
import { nameMaps, ruleFilter, rulesWhere } from "@/server/data";

export default async function RulesPage() {
  await connection();
  const { orgId } = await requireAccess("rules");
  const [names, bands, releases, orgDeductions, overrides, labelDefault, peopleRows, bandDefaults] = await Promise.all([
    nameMaps(orgId),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId)).orderBy(asc(schema.releases.title)),
    db.select().from(schema.deductions).where(eq(schema.deductions.orgId, orgId)).orderBy(asc(schema.deductions.sortOrder)),
    db.select().from(schema.routingOverrides).where(eq(schema.routingOverrides.orgId, orgId)).orderBy(asc(schema.routingOverrides.matchKey)),
    rulesWhere(orgId, ruleFilter("label_default", {})),
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
    rulesWhere(orgId, ruleFilter("band_default", {})),
  ]);
  const releaseOpts = releases.map((r) => ({
    id: r.id,
    name: `${r.title} (${names.band.get(r.bandId)})`,
    bandId: r.bandId,
    formats: r.kind === "merch" ? [] : r.packages.map((p) => ({ id: p.bandcampId, title: p.title })),
  }));
  const labelWide = orgDeductions.filter((d) => d.bandId === null);
  const bandLevel = orgDeductions.filter((d) => d.bandId !== null).sort((a, b) => a.bandId! - b.bandId!);
  const everyone = peopleRows.map((p) => ({ id: p.id, name: p.name, inBand: false }));
  const peopleOpts = everyone.map((p) => ({ id: p.id, name: p.name }));
  const withOwnDefault = new Set(bandDefaults.map((r) => r.bandId));
  const usingLabelDefault = bands.filter((b) => !withOwnDefault.has(b.id));

  return (
    <>
      <PageHeader title="Label rules" subtitle="The label-wide default split, what comes off before splitting, and how sales are matched to bands." />

      <Card title="Label-wide default split">
        <p className="mb-3 text-sm text-muted">
          Used for any band that doesn’t have its own default split. Each band’s current members share it evenly. You can
          carve out a fixed share for specific people first, such as a producer or engineer who works on every release.
          Band, item-type, release and track splits always take priority.
        </p>
        <SplitRules
          rules={labelDefault}
          people={everyone}
          scope={{ scope: "label_default" }}
          emptyText="No label-wide default. Bands without their own default split will be flagged at payout time."
        />
        {labelDefault.length > 0 && (
          <p className="mt-3 text-sm text-muted">
            {usingLabelDefault.length === 0 ? (
              "Every band has its own default split right now, so this isn’t used yet."
            ) : (
              <>
                Currently used by:{" "}
                {usingLabelDefault.map((b, i) => (
                  <span key={b.id}>
                    {i > 0 && ", "}
                    <Link href={`/bands/${b.id}`}>{b.name}</Link>
                  </span>
                ))}
                .
              </>
            )}
          </p>
        )}
      </Card>

      <Card title="Label-wide deductions">
        <p className="mb-3 text-sm text-muted">
          Taken from every sale first, e.g. the label’s cut. Limit one to a band, release or item type to make it apply only there.
        </p>
        <DeductionList people={peopleOpts} items={labelWide} names={names} bands={bands} releases={releaseOpts} />
        <div className="mt-3">
          <Disclosure summary="+ Add deduction">
            <DeductionForm people={peopleOpts} bands={bands} releases={releaseOpts} />
          </Disclosure>
        </div>
      </Card>

      <Card title="Band deductions">
        {bandLevel.length === 0 ? (
          <p className="text-sm text-muted">None. Add band funds or recoupable costs on each band’s page.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Band</th>
                <th>Deduction</th>
                <th>Amount</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody>
              {bandLevel.map((d) => {
                const desc = describeDeduction(d, names);
                return (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/bands/${d.bandId}`} className="hover:underline">
                        {names.band.get(d.bandId!)}
                      </Link>
                    </td>
                    <td>{d.label}</td>
                    <td>{desc.amount}</td>
                    <td className="text-xs text-muted">
                      {desc.scope}
                      {desc.window && ` · ${desc.window}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="How sales are matched to bands"
        actions={
          <form action={rerouteAction}>
            <SubmitButton variant="secondary" size="sm">
              Re-match all sales
            </SubmitButton>
          </form>
        }
      >
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>A remembered choice you made on the Import page (listed below)</li>
          <li>The sale’s item URL exactly matches a release or track URL in the catalog</li>
          <li>The URL matches a band’s Bandcamp URLs (subdomain, host or prefix)</li>
          <li>The “artist” column matches a band name or alias</li>
          <li>Within that band, the item name is matched to a release or track title</li>
        </ol>
        <h3 className="mb-2 text-sm font-medium">Remembered choices</h3>
        {overrides.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Sales matching</th>
                <th>Go to</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overrides.map((o) => (
                <tr key={o.id}>
                  <td className="font-mono text-xs break-all">{o.matchKey.replace(/^(url|name):/, "")}</td>
                  <td className="text-sm">
                    {names.band.get(o.bandId)}
                    {o.releaseId && ` › ${names.release.get(o.releaseId)}`}
                    {o.trackId && ` › ${names.track.get(o.trackId)}`}
                  </td>
                  <td className="text-right">
                    <form action={deleteRoutingOverride}>
                      <input type="hidden" name="id" value={o.id} />
                      <SubmitButton variant="ghost" size="sm">
                        Forget
                      </SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
