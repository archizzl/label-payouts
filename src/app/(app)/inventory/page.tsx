import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { BandFilter } from "@/components/band-filter";
import { connection } from "next/server";
import { ActionForm, SaveWhenChanged, SubmitButton } from "@/components/client";
import { Badge, Callout, Card, Disclosure, Empty, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { isLow, MOVE_REASONS } from "@/lib/inventory";
import { formatCents } from "@/lib/money";
import { bandScope, can } from "@/lib/permissions";
import { requireAccess } from "@/server/context";
import { addFromCatalog, adjustInventory, archiveInventoryItem, saveInventoryItem } from "@/server/inventory-actions";

export const metadata = { title: "inventory" };

type Item = typeof schema.inventoryItems.$inferSelect;
type Move = typeof schema.inventoryMoves.$inferSelect;
type Option = { id: number; name: string };
type CatalogOption = { value: string; label: string; bandId: number };

/** What the label (or band) has on hand: merch and formats it sells, and supplies it uses. */
export default async function InventoryPage({ searchParams }: PageProps<"/inventory">) {
  await connection();
  const { orgId, access, lens } = await requireAccess("inventory");
  const scope = bandScope(access, "inventory");
  const canEdit = can(access, "inventory", "edit");
  // A band's own account can change its counts, not the items.
  const canCount = canEdit || lens;
  const band = Number((await searchParams).band) || null;

  const [allItems, bandRows, releaseRows] = await Promise.all([
    db
      .select()
      .from(schema.inventoryItems)
      .where(and(eq(schema.inventoryItems.orgId, orgId), eq(schema.inventoryItems.archived, false)))
      .orderBy(asc(schema.inventoryItems.name), asc(schema.inventoryItems.option)),
    db.select({ id: schema.bands.id, name: schema.bands.name }).from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db
      .select({ id: schema.releases.id, title: schema.releases.title, kind: schema.releases.kind, bandId: schema.releases.bandId, packages: schema.releases.packages })
      .from(schema.releases)
      .where(eq(schema.releases.orgId, orgId))
      .orderBy(asc(schema.releases.title)),
  ]);
  const inScope = (bandId: number | null) => !scope || (bandId !== null && scope.includes(bandId));
  const items = allItems.filter((i) => inScope(i.bandId) && (!band || i.bandId === band));
  const bands = bandRows.filter((b) => inScope(b.id));
  const bandName = new Map(bandRows.map((b) => [b.id, b.name]));
  const moves = items.length
    ? await db
        .select()
        .from(schema.inventoryMoves)
        .where(inArray(schema.inventoryMoves.itemId, items.map((i) => i.id)))
        .orderBy(desc(schema.inventoryMoves.createdAt), desc(schema.inventoryMoves.id))
        .limit(1000)
    : [];
  const movesOf = (id: number) => moves.filter((m) => m.itemId === id).slice(0, 10);
  // Catalog items to link to: each format of a release, and each merch item.
  const catalog: CatalogOption[] = releaseRows
    .filter((r) => inScope(r.bandId))
    .flatMap((r) =>
      r.packages.length
        ? r.packages.map((p) => ({ value: `${r.id}:${p.bandcampId}`, label: r.kind === "merch" ? p.title : `${r.title} — ${p.title}`, bandId: r.bandId }))
        : r.kind === "merch"
          ? [{ value: `${r.id}:`, label: r.title, bandId: r.bandId }]
          : [],
    );

  const products = items.filter((i) => i.kind === "product");
  const supplies = items.filter((i) => i.kind === "supply");
  const low = items.filter(isLow);
  const units = items.reduce((a, i) => a + i.onHand, 0);
  const value = new Map<string, number>();
  for (const i of items) if (i.unitCostCents) value.set(i.currency, (value.get(i.currency) ?? 0) + i.unitCostCents * i.onHand);
  const bandsWithItems = bands.filter((b) => allItems.some((i) => i.bandId === b.id));

  return (
    <>
      <PageHeader title="Inventory" />

      {bandsWithItems.length > 1 && <BandFilter path="/inventory" bands={bandsWithItems} current={band} all="everything" />}

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="Items" value={String(items.length)} />
        <Tile label="Units on hand" value={String(units)} />
        <Tile label="Running low" value={String(low.length)} warn={low.length > 0} />
        <Tile label="Value at cost" value={value.size ? [...value].map(([cur, c]) => formatCents(c, cur)).join(" · ") : "–"} />
      </div>

      {low.length > 0 && (
        <Callout>
          Running low: {low.map((i, n) => (
            <span key={i.id}>
              {n > 0 && ", "}
              <b>{itemLabel(i)}</b> ({i.onHand} left)
            </span>
          ))}
          .
        </Callout>
      )}

      {canEdit && (
        <div className="mb-8 flex flex-wrap items-start gap-3">
          <Disclosure summary="+ Add an item">
            <ItemForm bands={bands} catalog={catalog} defaultBand={band} ownBandsOnly={!!scope} />
          </Disclosure>
          <ActionForm action={addFromCatalog} className="flex flex-wrap items-center gap-2" keepOpen>
            {band && <input type="hidden" name="bandId" value={band} />}
            <SubmitButton variant="secondary" size="sm">
              Add from the catalog
            </SubmitButton>
          </ActionForm>
        </div>
      )}

      <Card title={`For sale (${products.length})`}>
        {products.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <ItemTable items={products} bandName={bandName} movesOf={movesOf} canEdit={canEdit} canCount={canCount} bands={bands} catalog={catalog} ownBandsOnly={!!scope} />
        )}
      </Card>

      <Card title={`Supplies (${supplies.length})`}>
        {supplies.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <ItemTable items={supplies} bandName={bandName} movesOf={movesOf} canEdit={canEdit} canCount={canCount} bands={bands} catalog={catalog} ownBandsOnly={!!scope} />
        )}
      </Card>
    </>
  );
}

const itemLabel = (i: Item) => `${i.name}${i.option ? ` (${i.option})` : ""}`;

function Tile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`border bg-surface px-4 py-3 ${warn ? "border-warn" : "border-border"}`}>
      <div className={`text-2xl font-bold tabular-nums ${warn ? "text-warn" : ""}`}>{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function ItemTable({
  items,
  bandName,
  movesOf,
  canEdit,
  canCount,
  bands,
  catalog,
  ownBandsOnly,
}: {
  items: Item[];
  bandName: Map<number, string>;
  movesOf: (id: number) => Move[];
  canEdit: boolean;
  canCount: boolean;
  bands: Option[];
  catalog: CatalogOption[];
  ownBandsOnly: boolean;
}) {
  return (
    <ul className="divide-y divide-border border-b border-border">
      {items.map((i) => (
        <li key={i.id} className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_7rem]">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{i.name}</span>
              {i.option && <Badge>{i.option}</Badge>}
              {isLow(i) && <Badge tone="warn">running low</Badge>}
            </div>
            <div className="text-xs text-muted">
              {[i.bandId && bandName.get(i.bandId), i.sku && `SKU ${i.sku}`, i.location && `kept at ${i.location}`, i.priceCents !== null && `${formatCents(i.priceCents, i.currency)} each`, i.unitCostCents !== null && `costs ${formatCents(i.unitCostCents, i.currency)}`]
                .filter(Boolean)
                .join(" · ") || "–"}
            </div>
            {i.notes && <p className="text-xs text-muted">{i.notes}</p>}
            <div className="flex flex-wrap items-start gap-2 pt-1">
              {canCount && (
                <Disclosure summary="Change count">
                  <AdjustForm item={i} />
                </Disclosure>
              )}
              <Disclosure summary="History">
                <History moves={movesOf(i.id)} />
              </Disclosure>
              {canEdit && (
                <Disclosure summary="Edit">
                  <ItemForm item={i} bands={bands} catalog={catalog} ownBandsOnly={ownBandsOnly} />
                  <form action={archiveInventoryItem} className="mt-3">
                    <input type="hidden" name="id" value={i.id} />
                    <SubmitButton variant="ghost" size="sm" confirm={`Remove ${itemLabel(i)} from the inventory? Its history is kept.`}>
                      Remove from inventory
                    </SubmitButton>
                  </form>
                </Disclosure>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className={`text-2xl font-bold tabular-nums ${isLow(i) ? "text-warn" : i.onHand === 0 ? "text-muted" : ""}`}>{i.onHand}</div>
            <div className="text-xs text-muted">on hand{i.lowAt !== null ? ` · low at ${i.lowAt}` : ""}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AdjustForm({ item }: { item: Item }) {
  return (
    <ActionForm action={adjustInventory} className="grid gap-3 sm:grid-cols-3">
      <input type="hidden" name="id" value={item.id} />
      <Field label="What happened">
        <select name="reason" defaultValue="received">
          {MOVE_REASONS.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="How many" hint="For a recount, the new total.">
        <input name="amount" type="number" inputMode="numeric" step={1} required className="!w-28" />
      </Field>
      <Field label="Note (optional)">
        <input name="note" placeholder="e.g. from the pressing plant" maxLength={300} />
      </Field>
      <div className="sm:col-span-3">
        <SubmitButton size="sm">Save</SubmitButton>
      </div>
    </ActionForm>
  );
}

const REASON_LABEL = new Map<string, string>(MOVE_REASONS.map((r) => [r.key, r.label]));

function History({ moves }: { moves: Move[] }) {
  if (!moves.length) return <p className="text-sm text-muted">No changes yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th className="num">Change</th>
            <th className="num">After</th>
          </tr>
        </thead>
        <tbody>
          {moves.map((m) => (
            <tr key={m.id}>
              <td className="text-xs text-muted">{m.createdAt.slice(0, 10)}</td>
              <td>
                {REASON_LABEL.get(m.reason) ?? m.reason}
                {m.note && <span className="text-muted"> · {m.note}</span>}
              </td>
              <td className={`num ${m.delta < 0 ? "text-bad" : m.delta > 0 ? "text-good" : ""}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
              <td className="num">{m.onHandAfter}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemForm({
  item,
  bands,
  catalog,
  defaultBand,
  ownBandsOnly = false,
}: {
  item?: Item;
  bands: Option[];
  catalog: CatalogOption[];
  defaultBand?: number | null;
  /** Limited to their own bands: no "label / shared" choice. */
  ownBandsOnly?: boolean;
}) {
  const linked = item?.releaseId ? `${item.releaseId}:${item.packageId ?? ""}` : "";
  return (
    <ActionForm action={saveInventoryItem} className="grid gap-4 sm:grid-cols-3" keepOpen={!item}>
      {item && <input type="hidden" name="id" value={item.id} />}
      <Field label="Kind">
        <select name="kind" defaultValue={item?.kind ?? "product"}>
          <option value="product">For sale (merch, music)</option>
          <option value="supply">Supply (not for sale)</option>
        </select>
      </Field>
      <Field label="Name" className="sm:col-span-2">
        <input name="name" required defaultValue={item?.name} placeholder="e.g. Jewel cases, Logo shirt, Flags of the World CD" maxLength={200} />
      </Field>
      <Field label="Catalog item (optional)" className="sm:col-span-2">
        <select name="catalog" defaultValue={linked}>
          <option value="">Not in the catalog</option>
          {catalog.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      {/* Only one band it can be (a band's own group): nothing to choose. */}
      {ownBandsOnly && bands.length === 1 ? (
        <input type="hidden" name="bandId" value={bands[0].id} />
      ) : (
        <Field label={ownBandsOnly ? "Band" : "Band (optional)"}>
          <select name="bandId" defaultValue={item?.bandId ?? defaultBand ?? (ownBandsOnly ? bands[0]?.id : "")}>
            {!ownBandsOnly && <option value="">The label / shared</option>}
            {bands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Size or option">
        <input name="option" defaultValue={item?.option ?? ""} placeholder="e.g. M" maxLength={100} />
      </Field>
      <Field label="SKU">
        <input name="sku" defaultValue={item?.sku ?? ""} maxLength={100} />
      </Field>
      {!item ? (
        <Field label="On hand now">
          <input name="onHand" type="number" inputMode="numeric" min={0} step={1} defaultValue={0} />
        </Field>
      ) : (
        <div />
      )}
      <Field label="Running low at">
        <input name="lowAt" type="number" inputMode="numeric" min={0} step={1} defaultValue={item?.lowAt ?? ""} />
      </Field>
      <Field label="Price each (optional)">
        <input name="price" inputMode="decimal" defaultValue={item?.priceCents != null ? (item.priceCents / 100).toFixed(2) : ""} placeholder="3.00" />
      </Field>
      <Field label="Cost each (optional)">
        <input name="unitCost" inputMode="decimal" defaultValue={item?.unitCostCents != null ? (item.unitCostCents / 100).toFixed(2) : ""} placeholder="0.85" />
      </Field>
      <Field label="Kept at">
        <input name="location" defaultValue={item?.location ?? ""} placeholder="e.g. Alex’s garage" maxLength={200} />
      </Field>
      <Field label="Notes" className="sm:col-span-3">
        <input name="notes" defaultValue={item?.notes ?? ""} maxLength={1000} />
      </Field>
      <div className="sm:col-span-3">
        {item ? (
          <SaveWhenChanged>
            <SubmitButton>Save</SubmitButton>
          </SaveWhenChanged>
        ) : (
          <SubmitButton>Add item</SubmitButton>
        )}
      </div>
    </ActionForm>
  );
}
