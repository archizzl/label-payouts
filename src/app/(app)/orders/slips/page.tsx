import Link from "next/link";
import { connection } from "next/server";
import { PrintButton } from "@/components/client";
import { buttonClass } from "@/components/ui";
import { requireAdmin } from "@/server/context";
import { loadOpenOrders } from "@/server/merch-orders";

/** Printable packing slips, one per page: where it's going, and what's in the box. */
export default async function SlipsPage({ searchParams }: PageProps<"/orders/slips">) {
  await connection();
  const { orgId, org } = await requireAdmin();
  const raw = (await searchParams).ids;
  const ids = new Set(
    String(Array.isArray(raw) ? raw.join(",") : (raw ?? ""))
      .split(",")
      .map(Number)
      .filter(Boolean),
  );
  const open = await loadOpenOrders(orgId);
  const orders = open.status === "ok" ? open.orders.filter((o) => ids.has(o.paymentId)) : [];

  return (
    <>
      <div className="no-print mb-6 flex flex-wrap items-center gap-3">
        <PrintButton />
        <Link href="/orders" className={buttonClass("ghost")}>
          Back to orders
        </Link>
        <span className="text-sm text-muted">
          {orders.length} packing slip{orders.length === 1 ? "" : "s"}, one per page.
        </span>
      </div>
      {orders.length === 0 && <p className="text-sm text-muted">No open orders to print. They may have been marked shipped already.</p>}
      {orders.map((o) => (
        <section key={o.paymentId} className="mb-10 border border-border p-8 break-after-page print:mb-0 print:border-0">
          <div className="mb-8 flex flex-wrap justify-between gap-6">
            <div>
              <div className="text-xl font-bold">{org.name}</div>
              <div className="text-sm text-muted">Packing slip · ordered {o.date}</div>
            </div>
            <address className="text-base not-italic">
              <div className="mb-1 text-xs text-muted uppercase">Ship to</div>
              {o.address.map((line, i) => (
                <div key={i} className={i === 0 ? "font-bold" : ""}>
                  {line}
                </div>
              ))}
            </address>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th className="w-8" />
                <th>Item</th>
                <th>Option</th>
                <th className="num">Qty</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.saleItemId}>
                  <td>
                    <span className="inline-block h-4 w-4 border border-text" aria-hidden />
                  </td>
                  <td>
                    {l.name}
                    {l.artist && <div className="text-xs text-muted">{l.artist}</div>}
                  </td>
                  <td>{l.option ?? "–"}</td>
                  <td className="num font-bold">{l.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {o.note && <p className="mt-6 text-sm">Note from {o.buyer.name || "the buyer"}: {o.note}</p>}
          <p className="mt-10 text-sm">Thank you for supporting {org.name}!</p>
        </section>
      ))}
    </>
  );
}
