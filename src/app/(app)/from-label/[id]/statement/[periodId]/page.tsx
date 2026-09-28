import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PrintButton } from "@/components/client";
import { BandStatement } from "@/components/statement";
import { requireLinkedView } from "@/server/links";
import { periodView } from "@/server/period-view";

/** The label's statement for this band for one payout, as the label sees it. */
export default async function FromLabelStatementPage({ params }: PageProps<"/from-label/[id]/statement/[periodId]">) {
  await connection();
  const { id, periodId } = await params;
  const v = await requireLinkedView(Number(id));
  const view = await periodView(v.labelOrgId, Number(periodId));
  // Only payouts that covered this band.
  if (!view || (view.period.bandId !== null && view.period.bandId !== v.bandId)) notFound();
  return (
    <>
      <div className="no-print mb-6 flex flex-wrap items-center gap-3">
        <Link href={`/from-label/${id}`} className="text-sm text-accent hover:underline">
          ← Back to {v.labelName}
        </Link>
        <PrintButton />
      </div>
      <BandStatement view={view} bandId={v.bandId} />
    </>
  );
}
