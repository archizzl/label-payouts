import { redirect } from "next/navigation";
import { connection } from "next/server";
import { PayoutView } from "@/components/payout-view";
import { requireAdmin } from "@/server/context";
import { payoutName, previewView } from "@/server/period-view";

/** A payout before it's finalized: computed from the band and dates in the address, nothing stored. */
export default async function PayoutPreviewPage({ searchParams }: PageProps<"/periods/new">) {
  await connection();
  const { orgId } = await requireAdmin();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === "string" ? q[k] : undefined);
  const date = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(one(k) ?? "") ? one(k)! : null);
  const startDate = date("from");
  const endDate = date("to");
  if (!startDate || !endDate || startDate > endDate) redirect("/periods");
  const scope = { bandId: Number(one("band")) || null, startDate, endDate };
  const synced = one("synced");
  return (
    <PayoutView
      view={await previewView(orgId, scope)}
      name={one("name") || (await payoutName(orgId, scope))}
      sync={{ synced: synced === undefined ? null : Number(synced), error: one("syncError") ?? null }}
    />
  );
}
