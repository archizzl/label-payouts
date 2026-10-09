"use client";

import { useState } from "react";
import { clearReceiptFiles } from "@/server/expense-actions";
import { ActionForm, SubmitButton } from "./client";
import { buttonClass } from "./ui";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** One part of the clear-out: download it, say it's kept, then remove those files from storage. */
export function ClearFilesPart({ label, ids, count, bytes, receipts }: { label: string; ids: number[]; count: number; bytes: number; receipts: number }) {
  const [downloaded, setDownloaded] = useState(false);
  const [kept, setKept] = useState(false);
  return (
    <ActionForm action={clearReceiptFiles} className="space-y-2 border-t border-border py-3 first:border-t-0">
      <input type="hidden" name="ids" value={ids.join(",")} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm text-muted">
          {count} file{count === 1 ? "" : "s"} from {receipts} receipt{receipts === 1 ? "" : "s"}, {mb(bytes)}
        </span>
        <a href={`/receipts/archive?ids=${ids.join(",")}`} className={buttonClass("secondary", "sm")} onClick={() => setDownloaded(true)} download>
          Download (.zip)
        </a>
      </div>
      <label className={`flex items-center gap-2 text-sm ${downloaded ? "" : "text-muted"}`}>
        <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} disabled={!downloaded} />
        I’ve opened the download and kept it somewhere safe
      </label>
      <SubmitButton variant="danger" size="sm" disabled={!kept} confirm={`Remove these ${count} files from storage? The receipts stay; only your download will have the files.`}>
        Remove these files from storage
      </SubmitButton>
    </ActionForm>
  );
}
