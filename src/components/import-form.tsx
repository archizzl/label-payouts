"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatCents } from "@/lib/money";
import { commitImport, type ImportPreview, previewImport } from "@/server/actions";
import { buttonClass } from "./ui";

export function ImportForm() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const choose = (f: File | null) => {
    setFile(f);
    setPreview(null);
    setError(null);
    if (!f) return;
    const fd = new FormData();
    fd.set("file", f);
    start(async () => setPreview(await previewImport(null, fd)));
  };

  const commit = () => {
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    start(async () => {
      try {
        const res = await commitImport(fd);
        if (res.error) return setError(res.error);
        setFile(null);
        setPreview(null);
        router.push(`/sales/import?imported=${res.importId}`);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  };

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
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition ${
          dragging ? "border-accent bg-accent/5" : "border-border hover:bg-surface-2"
        }`}
      >
        <input type="file" accept=".csv,.txt,text/csv" className="sr-only" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
        <span className="font-medium">{file ? file.name : "Drop your Bandcamp sales report here"}</span>
        <span className="mt-1 text-sm text-muted">{file ? "Choose a different file" : "or click to choose a .csv file"}</span>
      </label>

      {pending && !preview && <p className="text-sm text-muted">Reading file…</p>}

      {preview && (
        <div className="rounded-lg border border-border bg-surface p-4">
          {preview.error ? (
            <div className="text-sm">
              <p className="font-medium text-bad">{preview.error}</p>
              {preview.missingColumns && (
                <p className="mt-2 text-muted">
                  Missing columns: {preview.missingColumns.join(", ")}.
                  {preview.headers && preview.headers.length > 0 && <> Found: {preview.headers.slice(0, 20).join(", ")}…</>}
                </p>
              )}
            </div>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <Stat label="Sales in file" value={preview.total} />
                <Stat label="New" value={preview.fresh} />
                <Stat label="Already imported" value={preview.duplicates} />
                <Stat label="Needs routing" value={preview.unrouted} tone={preview.unrouted ? "warn" : undefined} />
              </div>
              {preview.dateRange && (
                <p className="mb-3 text-sm text-muted">
                  Dates {preview.dateRange[0]} → {preview.dateRange[1]}
                </p>
              )}
              {preview.byBand.length > 0 && (
                <table className="data mb-4">
                  <thead>
                    <tr>
                      <th>Band</th>
                      <th className="num">New sales</th>
                      <th className="num">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.byBand.map((b) => (
                      <tr key={b.band}>
                        <td className={b.band.startsWith("⚠") ? "text-warn" : ""}>{b.band}</td>
                        <td className="num">{b.count}</td>
                        <td className="num">
                          {Object.entries(b.totals)
                            .map(([c, v]) => formatCents(v, c))
                            .join(" · ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {preview.skipped.length > 0 && (
                <details className="mb-4 text-sm text-muted">
                  <summary>{preview.skipped.length} row(s) skipped (payouts, blank or summary rows)</summary>
                  <ul className="mt-2 list-disc pl-5">
                    {preview.skipped.slice(0, 30).map((s) => (
                      <li key={s.row}>
                        Row {s.row}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {preview.unrouted > 0 && (
                <p className="mb-4 text-sm text-warn">
                  {preview.unrouted} sale(s) couldn’t be matched to a band. Import anyway and assign them below; the app remembers
                  your choices for next time.
                </p>
              )}
              <div className="flex gap-2">
                <button className={buttonClass("primary")} disabled={pending || preview.fresh === 0} onClick={commit}>
                  {pending ? "Importing…" : preview.fresh === 0 ? "Nothing new to import" : `Import ${preview.fresh} sale${preview.fresh === 1 ? "" : "s"}`}
                </button>
                <button className={buttonClass("ghost")} onClick={() => choose(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {error && <p className="mt-3 text-sm text-bad">{error}</p>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${tone === "warn" ? "text-warn" : ""}`}>{value}</div>
    </div>
  );
}
