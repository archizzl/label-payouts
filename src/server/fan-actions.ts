"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { parseFanCsv } from "@/lib/fan-csv";
import { requireAccess } from "./context";
import { type FanImportPlan, importFans, planFanImport } from "./fans";

/*
 * The mailing list (Fans page): bring in Bandcamp's mailing-list export, and remove people who ask
 * to be taken off. Admins only: it's fans' personal data.
 */

export type FanPreview = (FanImportPlan & { skipped: number; repeats: number }) | { error: string };
export type FanImportState = { ok?: string; error?: string } | null;

const MAX_BYTES = 20 * 1024 * 1024;

async function readFile(fd: FormData) {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a mailing-list file to import." } as const;
  if (file.size > MAX_BYTES) return { error: "That file is too big (over 20 MB)." } as const;
  const parsed = parseFanCsv(new Uint8Array(await file.arrayBuffer()));
  if (parsed.error) return { error: parsed.error } as const;
  if (!parsed.fans.length) return { error: "No email addresses found in this file." } as const;
  return { file, parsed } as const;
}

/** What the file holds and what importing it would do. Nothing is saved. */
export async function previewFans(fd: FormData): Promise<FanPreview> {
  const { orgId } = await requireAccess("fans", "edit");
  const read = await readFile(fd);
  if ("error" in read) return { error: read.error! };
  const plan = await planFanImport(orgId, read.parsed.fans);
  return { ...plan, skipped: read.parsed.skipped, repeats: read.parsed.repeats };
}

export async function commitFans(fd: FormData): Promise<FanImportState> {
  const { orgId, user } = await requireAccess("fans", "edit");
  const read = await readFile(fd);
  if ("error" in read) return { error: read.error };
  const raw = Number(fd.get("bandId"));
  let bandId: number | null = null;
  if (raw) {
    const [band] = await db
      .select()
      .from(schema.bands)
      .where(and(eq(schema.bands.orgId, orgId), eq(schema.bands.id, raw)));
    if (!band) return { error: "Unknown band." };
    bandId = band.id;
  }
  const { added, updated } = await importFans(orgId, read.parsed.fans, { filename: read.file.name, bandId, userId: user.id });
  revalidatePath("/fans");
  return { ok: `Added ${added} new fan${added === 1 ? "" : "s"}${updated ? `, updated ${updated} already on the list` : ""}.` };
}

/** Take someone off the list entirely (e.g. they asked to be removed). */
export async function deleteFans(fd: FormData) {
  const { orgId } = await requireAccess("fans", "edit");
  const ids = fd
    .getAll("id")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) await db.delete(schema.fans).where(and(eq(schema.fans.orgId, orgId), inArray(schema.fans.id, ids)));
  revalidatePath("/fans");
}
