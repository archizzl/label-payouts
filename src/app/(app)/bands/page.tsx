import { redirect } from "next/navigation";
import { requireAccess } from "@/server/context";
import { ownBand } from "@/server/data";

/** Bands are in the Directory now, with their people. A band account goes straight to its band. */
export default async function BandsPage() {
  const ctx = await requireAccess("roster");
  if (ctx.org.kind === "band") {
    const band = await ownBand(ctx.orgId);
    if (band) redirect(`/bands/${band.id}`);
  }
  redirect("/directory");
}
