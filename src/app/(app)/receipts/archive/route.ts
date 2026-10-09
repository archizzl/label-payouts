import { zipSync } from "fflate";
import type { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { inArray } from "drizzle-orm";
import { archiveNames, BATCH_BYTES } from "@/lib/receipt-cleanup";
import { requireAccess } from "@/server/context";
import { clearableFiles } from "@/server/receipt-cleanup";
import { readStoredFile } from "@/server/receipt-store";

/**
 * A zip of settled receipts' files (?ids=1,2,3, one part of the clear-out on the Receipts page), to
 * keep before they're removed from storage. Only files of settled receipts in this account.
 */
export async function GET(req: NextRequest) {
  const { orgId, org } = await requireAccess("receipts", "edit");
  const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").map(Number).filter(Number.isInteger).slice(0, 2000);
  const { files } = await clearableFiles(orgId, ids);
  if (!files.length) return new Response("Nothing to download: these receipts' files may have been cleared already.", { status: 404 });
  if (files.reduce((a, f) => a + f.size, 0) > BATCH_BYTES * 1.5) return new Response("Too much for one download. Use the parts on the Receipts page.", { status: 400 });

  const stored = await db
    .select({ id: schema.expenseFiles.id, storageKey: schema.expenseFiles.storageKey, data: schema.expenseFiles.data })
    .from(schema.expenseFiles)
    .where(inArray(schema.expenseFiles.id, files.map((f) => f.id)));
  const byId = new Map(stored.map((s) => [s.id, s]));
  const names = archiveNames(files);
  const entries: Record<string, Uint8Array> = {};
  for (const [i, f] of files.entries()) {
    const body = await readStoredFile(byId.get(f.id)!);
    if (!body) continue;
    // Stored as-is: photos and PDFs are already compressed.
    entries[names[i]] = new Uint8Array(await new Response(body).arrayBuffer());
  }
  const zip = zipSync(entries, { level: 0 });
  const slug = org.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "receipts";
  return new Response(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.byteLength),
      "Content-Disposition": `attachment; filename="${slug}-receipts-${files[0].date}-to-${files.at(-1)!.date}.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}
