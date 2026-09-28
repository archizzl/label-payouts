import Papa from "papaparse";
import type { NextRequest } from "next/server";
import { centsToDecimal } from "@/lib/money";
import { paypalBulkCsv } from "@/lib/paypal-export";
import { requireAdmin } from "@/server/context";
import { periodView, toPayoutLines } from "@/server/period-view";

function csvResponse(body: string, filename: string) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(_req: NextRequest, ctx: RouteContext<"/periods/[id]/export/[kind]">) {
  const { id, kind } = await ctx.params;
  const { orgId } = await requireAdmin();
  const view = await periodView(orgId, Number(id));
  if (!view) return new Response("Not found", { status: 404 });
  const slug = view.period.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || `period-${id}`;
  const band = (b: number | null) => (b === null ? "UNROUTED" : (view.names.band.get(b) ?? `#${b}`));

  if (kind === "paypal-bulk") {
    if (!view.finalized) return new Response("Finalize the period before exporting payouts.", { status: 409 });
    return csvResponse(paypalBulkCsv(toPayoutLines(view)), `paypal-payouts-${slug}.csv`);
  }

  if (kind === "people") {
    const rows = view.lines.map((l) => ({
      person: l.name,
      email: l.email ?? "",
      paypal_me: l.paypalMe ?? "",
      venmo: l.venmo ?? "",
      cashtag: l.cashtag ? `$${l.cashtag}` : "",
      currency: l.currency,
      amount: centsToDecimal(l.amountCents),
      bands: l.byBand.map((b) => `${band(b.bandId)}: ${centsToDecimal(b.cents)}`).join("; "),
      status: l.status ?? "preview",
      paid_at: l.paidAt ?? "",
      reference: l.reference ?? "",
    }));
    return csvResponse(Papa.unparse(rows), `payout-summary-${slug}.csv`);
  }

  if (kind === "sales") {
    const rows = view.live.results.map((r) => {
      const s = view.live.saleById.get(r.saleId)!;
      return {
        date: s.date,
        band: band(r.bandId),
        release: s.releaseId ? (view.names.release.get(s.releaseId) ?? "") : "",
        track: s.trackId ? (view.names.track.get(s.trackId) ?? "") : "",
        item_type: s.itemType,
        item_name: s.itemName,
        artist: s.artist,
        item_url: s.itemUrl,
        currency: r.currency,
        net: centsToDecimal(r.netCents),
        deductions: r.deductions.map((d) => `${d.label}: ${centsToDecimal(d.cents)}`).join("; "),
        split_used: r.ruleSource ?? r.problem ?? "",
        shares: r.shares.map((x) => `${view.names.person.get(x.personId)}: ${centsToDecimal(x.cents)}`).join("; "),
        unallocated: centsToDecimal(r.unallocatedCents),
        bandcamp_transaction_id: s.transactionId,
      };
    });
    return csvResponse(Papa.unparse(rows), `sales-detail-${slug}.csv`);
  }

  return new Response("Unknown export", { status: 404 });
}
