import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PayoutView } from "@/components/payout-view";
import { periodView } from "@/server/period-view";

/** A finalized payout. (Before finalizing, a payout is only a preview at /periods/new.) */
export default async function PeriodPage({ params }: PageProps<"/periods/[id]">) {
  await connection();
  const view = periodView(Number((await params).id));
  if (!view) notFound();
  return <PayoutView view={view} name={view.period.name} />;
}
