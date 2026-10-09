import "server-only";
import { randomUUID } from "node:crypto";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { onCloudflare } from "@/db";

/*
 * Where receipt photos and PDFs live. On the live site: Cloudflare R2 (the RECEIPTS bucket), with
 * the database keeping just the details and the file's key. Locally and in tests, or if the bucket
 * isn't set up: in the database itself (expense_files.data). Either way files are private: they're
 * only ever served through /receipts/file/[id], which checks who's asking.
 */

/** The bits of R2 used here. */
type Bucket = {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(keys: string | string[]): Promise<void>;
};

function bucket(): Bucket | null {
  if (!onCloudflare) return null;
  return (getCloudflareContext().env as unknown as { RECEIPTS?: Bucket }).RECEIPTS ?? null;
}

/** A receipt file from a form, checked but not yet read. */
export type ReceiptUpload = { file: File; filename: string; contentType: string; size: number };

/** A file ready to save with its receipt: either its key in R2, or its bytes. */
export type StoredFile = { filename: string; contentType: string; size: number; storageKey: string | null; data: Uint8Array | null };

/**
 * Put the files where they're kept, one at a time (so a big upload never holds more than one extra
 * copy in memory). Call before saving the receipt; if that fails, pass these to discardStoredFiles.
 */
export async function storeReceiptFiles(orgId: string, uploads: ReceiptUpload[]): Promise<StoredFile[]> {
  const store = bucket();
  const out: StoredFile[] = [];
  try {
    for (const u of uploads) {
      const bytes = await u.file.arrayBuffer();
      const base = { filename: u.filename, contentType: u.contentType, size: u.size };
      if (store) {
        const storageKey = `receipts/${orgId}/${randomUUID()}`;
        await store.put(storageKey, bytes, { httpMetadata: { contentType: u.contentType } });
        out.push({ ...base, storageKey, data: null });
      } else {
        out.push({ ...base, storageKey: null, data: new Uint8Array(bytes) });
      }
    }
  } catch (e) {
    await discardStoredFiles(out);
    throw e;
  }
  return out;
}

/** Remove files from storage (after their rows are deleted, or when saving the receipt failed). */
export async function discardStoredFiles(files: { storageKey: string | null }[]) {
  const keys = files.map((f) => f.storageKey).filter((k): k is string => !!k);
  if (!keys.length) return;
  const store = bucket();
  if (!store) return;
  try {
    await store.delete(keys);
  } catch (e) {
    // A leftover file is harmless (nothing points to it); don't fail the delete over it.
    console.error("Couldn't remove receipt files from storage:", e);
  }
}

/** A saved file's contents, to send back. */
export async function readStoredFile(file: { storageKey: string | null; data: Uint8Array | null }): Promise<BodyInit | null> {
  if (!file.storageKey) return file.data ? Buffer.from(file.data) : null;
  const store = bucket();
  const obj = store ? await store.get(file.storageKey) : null;
  return obj?.body ?? null;
}
