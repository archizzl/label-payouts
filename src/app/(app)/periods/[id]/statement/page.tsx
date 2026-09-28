import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PrintButton } from "@/components/client";
import { BandStatement } from "@/components/statement";
import { requireAdmin } from "@/server/context";
import { periodView } from "@/server/period-view";

export default async function StatementPage({ params, searchParams }: PageProps<"/periods/[id]/statement">) {
  await connection();
  const id = Number((await params).id);
  const only = Number((await searchParams).band) || null;
  const { orgId } = await requireAdmin();
  const view = await periodView(orgId, id);
  if (!view) notFound();
  const { period, live, names } = view;

  const bandIds = [...new Set(live.results.map((r) => r.bandId).filter((b): b is number => b !== null))]
    .filter((b) => !only || b === only)
    .sort((a, b) => (names.band.get(a) ?? "").localeCompare(names.band.get(b) ?? ""));

  return (
    <>
      <div className="no-print mb-6 flex flex-wrap items-center gap-3">
        <Link href={`/periods/${id}`} className="text-sm text-accent hover:underline">
          ← Back to {period.name}
        </Link>
        <PrintButton />
        <span className="text-sm text-muted">Each band starts on a new page when printed.</span>
      </div>
      {bandIds.length === 0 && <p className="text-muted">No sales for this period.</p>}
      {bandIds.map((bandId) => {
        return <BandStatement key={bandId} view={view} bandId={bandId} />;
      })}
    </>
  );
}
