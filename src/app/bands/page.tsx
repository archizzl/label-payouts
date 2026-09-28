import { count, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { BandFields } from "@/components/band-fields";
import { LabelImport } from "@/components/label-import";
import { Card, Disclosure, Empty, MoneyList, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { computeAllTime, labelHost } from "@/server/data";

export default async function BandsPage() {
  await connection();
  const bands = db.select().from(schema.bands).orderBy(schema.bands.name).all();
  const members = new Map(
    db
      .select({ bandId: schema.bandMemberships.bandId, n: count() })
      .from(schema.bandMemberships)
      .where(eq(schema.bandMemberships.active, true))
      .groupBy(schema.bandMemberships.bandId)
      .all()
      .map((r) => [r.bandId, r.n]),
  );
  const allReleases = db.select({ bandId: schema.releases.bandId, kind: schema.releases.kind }).from(schema.releases).all();
  const countOf = (bandId: number, merch: boolean) => allReleases.filter((r) => r.bandId === bandId && (r.kind === "merch") === merch).length;
  const splitRules = db.select().from(schema.splitRules).all();
  const hasLabelDefault = splitRules.some((r) => r.scope === "label_default");
  const splitStatus = (bandId: number) =>
    splitRules.some((r) => r.scope === "band_default" && r.bandId === bandId)
      ? { text: "own split", tone: "" }
      : bands.find((b) => b.id === bandId)?.isLabel
        ? { text: "label keeps it", tone: "text-muted" }
        : hasLabelDefault
          ? { text: "label-wide default", tone: "text-muted" }
          : { text: "no split set", tone: "text-warn" };
  /** The band's Bandcamp page, from a bare subdomain pattern or a custom host. */
  const bandcampUrl = (b: (typeof bands)[number]) => {
    const p = b.urlPatterns.find((x) => !x.includes("/"));
    const host = p ? (p.includes(".") ? p : `${p}.bandcamp.com`) : b.isLabel ? labelHost(b.id) : null;
    return host ? `https://${host}` : null;
  };
  const { summary } = computeAllTime();
  const earnings = (bandId: number) => {
    const m = new Map<string, number>();
    for (const cur of summary.currencies) {
      const v = summary.byCurrency[cur].byBand.get(bandId);
      if (v) m.set(cur, v);
    }
    return m;
  };

  return (
    <>
      <PageHeader title="Bands" subtitle="Each band's members, how sales are matched to it, and its default splits." />
      <LabelImport />
      <Card>
        {bands.length === 0 ? (
          <Empty>No bands yet. Add your first one below.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Band</th>
                <th>Bandcamp</th>
                <th>Split</th>
                <th className="num">Members</th>
                <th className="num">Releases</th>
                <th className="num">Merch</th>
                <th className="num">All-time net sales</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link href={`/bands/${b.id}`} className="flex items-center gap-3 font-medium">
                      {b.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={b.imageUrl} alt="" className="h-9 w-9 shrink-0 bg-surface-2 object-cover" />
                      ) : (
                        <span className="h-9 w-9 shrink-0 bg-surface-2" />
                      )}
                      <span>
                        {b.name}
                        {b.isLabel && <span className="ml-2 text-xs font-normal text-muted">(the label)</span>}
                        {b.location && <span className="block text-xs font-normal text-muted">{b.location}</span>}
                      </span>
                    </Link>
                  </td>
                  <td className="text-xs">
                    {bandcampUrl(b) ? (
                      <a href={bandcampUrl(b)!} target="_blank" rel="noreferrer">
                        {bandcampUrl(b)!.replace(/^https:\/\//, "")}
                      </a>
                    ) : (
                      <span className="text-muted">matched by name</span>
                    )}
                  </td>
                  <td className={`text-xs ${splitStatus(b.id).tone}`}>{splitStatus(b.id).text}</td>
                  <td className={`num ${members.get(b.id) || b.isLabel ? "" : "text-warn"}`}>{members.get(b.id) ?? 0}</td>
                  <td className="num">{countOf(b.id, false)}</td>
                  <td className="num">{countOf(b.id, true)}</td>
                  <td className="num">
                    <MoneyList totals={earnings(b.id)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Disclosure summary="+ add a band by hand">
        <BandFields />
      </Disclosure>
    </>
  );
}
