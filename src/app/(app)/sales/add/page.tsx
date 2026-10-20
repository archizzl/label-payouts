import { count, desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ManualSaleForm } from "@/components/manual-sale";
import { SalesTabs } from "@/components/sales-tabs";
import { Card, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { can } from "@/lib/permissions";
import { merchChoices, merchSources, saleAdder } from "@/server/manual-sales";

export const metadata = { title: "add a sale" };

/** A sale added by hand (a show, merch sold in person): for anyone who can change sales, and any band member for their bands. */
export default async function AddSalePage() {
  await connection();
  const adder = await saleAdder();
  if (!adder) redirect("/sales");
  const { ctx, bands, onlyBands } = adder;
  const m = ctx.managedBy;
  const [merch, [usual]] = await Promise.all([
    merchSources({ orgId: ctx.orgId, managed: m ? { labelOrgId: m.labelOrgId, bandId: m.bandId } : null, onlyBands }),
    db
      .select({ currency: schema.sales.currency })
      .from(schema.sales)
      .where(eq(schema.sales.orgId, m ? m.labelOrgId : ctx.orgId))
      .groupBy(schema.sales.currency)
      .orderBy(desc(count()))
      .limit(1),
  ]);
  return (
    <>
      {/* (A band member who doesn't see Sales comes here from their own page.) */}
      {can(ctx.access, "sales") ? (
        <>
          <PageHeader title="Sales" />
          <SalesTabs active="add" canImport={can(ctx.access, "sales", "edit")} />
        </>
      ) : (
        <PageHeader title="Add a sale" />
      )}
      <Card title={can(ctx.access, "sales") ? "Add a sale by hand" : undefined}>
        <ManualSaleForm bands={bands} merch={merchChoices(merch)} currency={usual?.currency ?? "USD"} />
      </Card>
    </>
  );
}
