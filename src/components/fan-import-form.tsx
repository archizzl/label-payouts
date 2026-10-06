"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { commitFans, type FanPreview, previewFans } from "@/server/fan-actions";
import { buttonClass } from "./ui";

/** Drop in Bandcamp's mailing-list export, see what's in it, then import. */
export function FanImportForm({ bands, isBandAccount }: { bands: { id: number; name: string }[]; isBandAccount: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<FanPreview | null>(null);
  const [bandId, setBandId] = useState(isBandAccount && bands.length === 1 ? String(bands[0].id) : "");
  const [result, setResult] = useState<{ ok?: string; error?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const choose = (f: File | null) => {
    setFile(f);
    setPreview(null);
    setResult(null);
    if (!f) return;
    const fd = new FormData();
    fd.set("file", f);
    start(async () => setPreview(await previewFans(fd)));
  };

  const commit = () => {
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    fd.set("bandId", bandId);
    start(async () => {
      const res = await commitFans(fd);
      setResult(res);
      if (res?.ok) {
        setFile(null);
        setPreview(null);
        router.refresh();
      }
    });
  };

  const plan = preview && "sources" in preview ? preview : null;
  const unmatched = plan ? plan.sources.filter((s) => s.bandId === null) : [];
  const perRow = !!plan && plan.sources.length > 0;

  return (
    <div className="space-y-4">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files[0] ?? null);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition ${
          dragging ? "border-accent bg-accent/5" : "border-border hover:bg-surface-2"
        }`}
      >
        <input type="file" accept=".csv,.txt,text/csv" className="sr-only" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
        <span className="font-medium">{file ? file.name : "Drop your Bandcamp mailing list here"}</span>
        <span className="mt-1 text-sm text-muted">{file ? "Choose a different file" : "or click to choose a .csv file"}</span>
      </label>

      {pending && !preview && <p className="text-sm text-muted">Reading file…</p>}
      {result?.ok && <p className="text-sm text-good">{result.ok}</p>}

      {preview && (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm">
          {!plan ? (
            <p className="font-medium text-bad">{"error" in preview ? preview.error : ""}</p>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-3 gap-4">
                <Stat label="Fans in file" value={plan.total} />
                <Stat label="New" value={plan.fresh} />
                <Stat label="Already on the list" value={plan.known} />
              </div>
              {plan.dateRange && (
                <p className="mb-3 text-muted">
                  Signed up {plan.dateRange[0]} → {plan.dateRange[1]}
                </p>
              )}
              {(plan.skipped > 0 || plan.repeats > 0) && (
                <p className="mb-3 text-muted">
                  {plan.skipped > 0 && `${plan.skipped} row(s) without a valid email skipped. `}
                  {plan.repeats > 0 && `${plan.repeats} repeated email(s) merged.`}
                </p>
              )}
              {perRow && (
                <p className="mb-3 text-muted">
                  The file says which artist each fan signed up through:{" "}
                  {plan.sources
                    .slice(0, 8)
                    .map((s) => `${s.name} (${s.count})${s.bandId === null ? " – no matching band" : ""}`)
                    .join(", ")}
                  {plan.sources.length > 8 && "…"}
                </p>
              )}
              {(!perRow || unmatched.length > 0) && (
                <label className="mb-4 block max-w-sm">
                  <span className="mb-1 block text-xs text-muted">
                    {perRow ? "Fans of artists without a matching band go on" : "Whose list is this?"}
                  </span>
                  <select value={bandId} onChange={(e) => setBandId(e.target.value)}>
                    <option value="">{isBandAccount ? "The band’s own list" : "The label’s own list"}</option>
                    {bands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="flex gap-2">
                <button className={buttonClass("primary")} disabled={pending} onClick={commit}>
                  {pending ? "Importing…" : plan.fresh ? `Import ${plan.fresh} new fan${plan.fresh === 1 ? "" : "s"}` : "Update the list"}
                </button>
                <button className={buttonClass("ghost")} onClick={() => choose(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {result?.error && <p className="mt-3 text-bad">{result.error}</p>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
