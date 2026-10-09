import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { Badge, buttonClass, Callout, Card, Disclosure, Empty, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { type MerchOrder, pickList, readyToShip } from "@/lib/merch-orders";
import { formatCents } from "@/lib/money";
import { bandScope, can, inBandScope } from "@/lib/permissions";
import { requireAccess } from "@/server/context";
import { loadOpenOrders } from "@/server/merch-orders";
import { markOrderShipped, refreshOrders } from "@/server/order-actions";

const CARRIERS = ["USPS", "UPS", "FedEx", "DHL", "Royal Mail", "Canada Post", "Australia Post", "Deutsche Post"];

/** Open merch orders from Bandcamp: what to pack, who's waiting, packing slips, and marking them shipped. */
export default async function OrdersPage({ searchParams }: PageProps<"/orders">) {
  await connection();
  const { orgId, access } = await requireAccess("orders");
  // A member type can limit this to their own bands' orders, and to looking (not marking shipped).
  const scope = bandScope(access, "orders");
  // Marking shipped covers the whole order, so someone limited to their bands can only mark orders that are all theirs.
  const shippable = (o: MerchOrder) => can(access, "orders", "edit") && (scope === null || o.lines.every((l) => l.bandId !== null && scope.includes(l.bandId)));
  const sp = await searchParams;
  const band = Number(sp.band) || null;
  const shipped = typeof sp.shipped === "string" ? sp.shipped.slice(0, 80) : null;
  const [open, bands, people] = await Promise.all([
    loadOpenOrders(orgId),
    db.select({ id: schema.bands.id, name: schema.bands.name }).from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db.select({ id: schema.people.id, name: schema.people.name }).from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
  ]);
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  if (open.status === "ok") open.orders = open.orders.filter((o) => inBandScope(scope, o.bandIds));

  if (open.status !== "ok") {
    return (
      <>
        <PageHeader title="Orders" />
        {open.status === "no-api" ? (
          <Callout tone="neutral">
            Open merch orders come straight from Bandcamp. Add your Bandcamp API access under <Link href="/account">Settings</Link> to see them here.
          </Callout>
        ) : (
          <Callout tone="bad">
            Couldn’t get your orders from Bandcamp: {open.message}{" "}
            <form action={refreshOrders} className="inline">
              <button type="submit" className="underline">
                Try again
              </button>
            </form>
          </Callout>
        )}
      </>
    );
  }

  const all = band ? open.orders.filter((o) => o.bandIds.includes(band)) : open.orders;
  const ready = all.filter(readyToShip);
  const preorders = all.filter((o) => !o.failed && o.preorderUntil);
  const failed = all.filter((o) => o.failed);
  const pack = pickList(ready);
  const bandsWithOrders = bands.filter((b) => open.orders.some((o) => o.bandIds.includes(b.id)));
  const slipHref = (ids: number[]) => `/orders/slips?ids=${ids.join(",")}`;

  return (
    <>
      <PageHeader
        title="Orders"
        actions={
          <>
            {ready.length > 0 && (
              <Link href={slipHref(ready.map((o) => o.paymentId))} className={buttonClass("secondary")}>
                Packing slips ({ready.length})
              </Link>
            )}
            <form action={refreshOrders}>
              <button type="submit" className={buttonClass("ghost")} title="Get the latest from Bandcamp">
                Refresh
              </button>
            </form>
          </>
        }
      />

      {shipped && (
        <Callout tone="good">
          Marked {shipped}’s order shipped on Bandcamp{sp.emailed ? " and emailed them" : ""}
          {Number(sp.costs) > 0 && (
            <>
              , and added {formatCents(Number(sp.costs), typeof sp.currency === "string" ? sp.currency : "USD")} of shipping costs to{" "}
              <Link href="/receipts">Receipts</Link>
            </>
          )}
          .
        </Callout>
      )}
      {typeof sp.costError === "string" && (
        <Callout tone="bad">The order was marked shipped, but its shipping costs couldn’t be saved ({sp.costError}). Add them on Receipts.</Callout>
      )}

      {bandsWithOrders.length > 1 && (
        <nav className="mb-6 flex flex-wrap gap-2 text-sm">
          <Link href="/orders" className={`rounded-full px-3 py-1 ${!band ? "bg-text text-bg" : "bg-surface-2 text-muted"}`}>
            everyone
          </Link>
          {bandsWithOrders.map((b) => (
            <Link key={b.id} href={`/orders?band=${b.id}`} className={`rounded-full px-3 py-1 ${band === b.id ? "bg-text text-bg" : "bg-surface-2 text-muted"}`}>
              {b.name}
            </Link>
          ))}
        </nav>
      )}

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="Orders to ship" value={String(ready.length)} />
        <Tile label="Items to pack" value={String(pack.reduce((a, p) => a + p.quantity, 0))} />
        <Tile label="Oldest waiting" value={ready.length ? `${ready[0].daysWaiting} day${ready[0].daysWaiting === 1 ? "" : "s"}` : "–"} />
        <Tile label="Pre-orders not out yet" value={String(preorders.length)} />
      </div>

      {all.length === 0 ? (
        <Card>
          <Empty>Nothing waiting to ship. 🎉</Empty>
        </Card>
      ) : (
        <>
          {pack.length > 0 && (
            <Card title="To pack">
              <table className="data">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Option</th>
                    {pack.some((p) => p.sku) && <th>SKU</th>}
                    <th className="num">Orders</th>
                    <th className="num">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {pack.map((p) => (
                    <tr key={`${p.name}|${p.option}`}>
                      <td>{p.name}</td>
                      <td>{p.option ?? <span className="text-muted">–</span>}</td>
                      {pack.some((x) => x.sku) && <td className="text-xs text-muted">{p.sku ?? "–"}</td>}
                      <td className="num text-muted">{p.orders}</td>
                      <td className="num font-bold">{p.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card title={`Waiting to ship (${ready.length})`}>
            {ready.length === 0 ? <Empty>Nothing ready to ship.</Empty> : <OrderList orders={ready} bandName={bandName} slipHref={slipHref} people={people} canShip={shippable} />}
          </Card>

          {preorders.length > 0 && (
            <Card title={`Pre-orders not out yet (${preorders.length})`}>
              <OrderList orders={preorders} bandName={bandName} slipHref={slipHref} people={people} canShip={shippable} />
            </Card>
          )}
          {failed.length > 0 && (
            <Card title={`Payment failed (${failed.length})`}>
              <p className="mb-3 text-sm text-muted">Bandcamp says these payments didn’t go through (e.g. a PayPal eCheck that failed). Don’t ship them.</p>
              <OrderList orders={failed} bandName={bandName} slipHref={slipHref} people={people} canShip={shippable} />
            </Card>
          )}
        </>
      )}
      <p className="mt-6 text-xs text-muted">
        Straight from Bandcamp as of {new Date(open.fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. Buyers’ details
        aren’t saved in this app.
      </p>
    </>
  );
}

function OrderList({
  orders,
  bandName,
  slipHref,
  people,
  canShip,
}: {
  orders: MerchOrder[];
  bandName: Map<number, string>;
  slipHref: (ids: number[]) => string;
  people: { id: number; name: string }[];
  canShip: (o: MerchOrder) => boolean;
}) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {orders.map((o) => (
        <li key={o.paymentId} className="grid gap-4 py-4 md:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-bold">{o.buyer.name || "Buyer"}</span>
              <span className="text-sm text-muted">{o.date}</span>
              {o.preorderUntil ? (
                <Badge>pre-order, ships from {o.preorderUntil}</Badge>
              ) : o.failed ? (
                <Badge tone="bad">payment failed</Badge>
              ) : (
                <Badge tone={o.daysWaiting > 7 ? "warn" : "neutral"}>
                  waiting {o.daysWaiting} day{o.daysWaiting === 1 ? "" : "s"}
                </Badge>
              )}
              {o.total !== null && <span className="text-sm text-muted">{formatCents(Math.round(o.total * 100), o.currency)}</span>}
            </div>
            <ul className="text-sm">
              {o.lines.map((l) => (
                <li key={l.saleItemId}>
                  <span className="font-bold tabular-nums">{l.quantity} ×</span> {l.name}
                  {l.option && <span> — {l.option}</span>}
                  <span className="text-muted"> · {l.bandId ? bandName.get(l.bandId) : l.artist}</span>
                </li>
              ))}
            </ul>
            {o.note && <p className="rounded-sm bg-warn-bg px-2 py-1 text-sm">Note: {o.note}</p>}
            <div className="flex flex-wrap items-start gap-2 pt-1">
              <Link href={slipHref([o.paymentId])} className={buttonClass("secondary", "sm")}>
                Packing slip
              </Link>
              {!o.failed && canShip(o) && (
                <Disclosure summary="Mark shipped">
                  <ActionForm action={markOrderShipped} className="grid gap-3 sm:grid-cols-2">
                    <input type="hidden" name="paymentId" value={o.paymentId} />
                    <Field label="Carrier (optional)">
                      <input name="carrier" list="carriers" placeholder="USPS" />
                    </Field>
                    <Field label="Tracking number (optional)">
                      <input name="tracking" />
                    </Field>
                    <label className="flex items-center gap-2 text-sm sm:col-span-2">
                      <input type="checkbox" name="notify" defaultChecked /> Email {o.buyer.name || "the buyer"} that it’s shipped
                    </label>
                    <Field label="Message (optional)" className="sm:col-span-2">
                      <input name="message" placeholder="Thanks so much! Hope you love it." />
                    </Field>
                    <fieldset className="grid gap-3 border-t border-border pt-3 sm:col-span-2 sm:grid-cols-3">
                      <legend className="pb-1 text-sm font-medium">
                        Shipping costs <span className="font-normal text-muted">(optional, added to Receipts)</span>
                      </legend>
                      <Field label="Postage">
                        <input name="postage" inputMode="decimal" placeholder="4.63" />
                      </Field>
                      <Field label="Packaging">
                        <input name="packaging" inputMode="decimal" placeholder="0.85" />
                      </Field>
                      <Field label="Paid by">
                        <select name="costPaidBy" defaultValue="label">
                          <option value="label">The label</option>
                          {o.bandIds.length === 1 && <option value="band_fund">{bandName.get(o.bandIds[0])}’s band fund</option>}
                          <optgroup label="Someone (to pay back)">
                            {people.map((p) => (
                              <option key={p.id} value={`person:${p.id}`}>
                                {p.name}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                      </Field>
                      <Field label="Receipt (optional)" hint="A photo or PDF of the postage label or receipt." className="sm:col-span-3">
                        <input type="file" name="receipt" accept="image/*,application/pdf" multiple className="text-sm" />
                      </Field>
                    </fieldset>
                    <datalist id="carriers">
                      {CARRIERS.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                    <div className="sm:col-span-2">
                      <SubmitButton confirm={`Mark ${o.buyer.name || "this order"}’s order shipped on Bandcamp? If the email box is ticked, Bandcamp emails them.`}>
                        Mark shipped on Bandcamp
                      </SubmitButton>
                    </div>
                  </ActionForm>
                </Disclosure>
              )}
            </div>
          </div>
          <div className="text-sm">
            <address className="not-italic">
              {o.address.map((line, i) => (
                <div key={i} className={i === 0 ? "font-medium" : ""}>
                  {line}
                </div>
              ))}
            </address>
            {(o.buyer.email || o.buyer.phone) && (
              <div className="mt-1 text-xs break-all text-muted">{[o.buyer.email, o.buyer.phone].filter(Boolean).join(" · ")}</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
