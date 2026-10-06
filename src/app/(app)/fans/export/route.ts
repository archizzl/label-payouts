import { asc, eq } from "drizzle-orm";
import Papa from "papaparse";
import type { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { centsToDecimal } from "@/lib/money";
import { requireAdmin } from "@/server/context";
import { allFans } from "@/server/fans";

/** "24.00 USD" (or several currencies joined), from what reached the label. */
function spent(purchases: { currency: string; netCents: number }[]) {
  const totals = new Map<string, number>();
  for (const p of purchases) totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.netCents);
  return [...totals].map(([c, v]) => `${centsToDecimal(v)} ${c}`).join(" + ");
}

/** The mailing list (or the part matching the Fans page's search) as a CSV that Mailchimp and the like import directly. */
export async function GET(req: NextRequest) {
  const { orgId, org } = await requireAdmin();
  const q = req.nextUrl.searchParams.get("q")?.trim() || undefined;
  const band = req.nextUrl.searchParams.get("band") ?? "";
  const [rows, bands] = await Promise.all([
    allFans(orgId, { q, bandId: band === "label" ? "label" : Number(band) || null }),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
  ]);
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  const csv = Papa.unparse(
    rows.map((f) => {
      const [first, ...rest] = (f.name ?? "").split(" ");
      return {
        "Email Address": f.email,
        "First Name": first ?? "",
        "Last Name": rest.join(" "),
        Name: f.name ?? "",
        Country: f.country ?? "",
        "Postal Code": f.postalCode ?? "",
        "Signed Up": f.addedOn,
        Tags: f.bandIds.map((b) => bandName.get(b) ?? "").filter(Boolean).join(", "),
        Purchases: f.purchases.length,
        Spent: spent(f.purchases),
      };
    }),
  );
  const slug = org.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "fans";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-fans.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
