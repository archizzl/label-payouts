"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  finishReleaseImport,
  findLabelReleases,
  importBandcampReleases,
  type LabelReleaseRow,
  type ReleaseImportResult,
} from "@/server/actions";
import { describeActionError } from "@/lib/action-errors";
import { LABEL_URL_STORAGE_KEY } from "./label-import";
import { Badge, buttonClass } from "./ui";

/** Releases per request. The server fetches a few of each batch at a time. */
const BATCH = 6;

type Lookup = { label: string | null; source: string; labelHost: string; releases: LabelReleaseRow[] };
type Progress = {
  done: number;
  total: number;
  current: string[];
  results: ReleaseImportResult[];
  running: boolean;
  needContacts?: number;
};

export function ReleaseImport() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "new" | "imported" | "merch">("all");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [finding, startFinding] = useTransition();
  // Local state, so the panel doesn't snap shut (hiding the results) when the page refreshes.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LABEL_URL_STORAGE_KEY);
      if (saved && inputRef.current && !inputRef.current.value) inputRef.current.value = saved;
    } catch {
      // storage unavailable
    }
  }, []);

  const find = () => {
    const url = inputRef.current?.value ?? "";
    startFinding(async () => {
      setError(null);
      setLookup(null);
      setProgress(null);
      let r: Awaited<ReturnType<typeof findLabelReleases>>;
      try {
        r = await findLabelReleases(url);
      } catch (e) {
        return setError(describeActionError(e));
      }
      if ("error" in r) return setError(r.error);
      try {
        localStorage.setItem(LABEL_URL_STORAGE_KEY, url);
      } catch {}
      setLookup(r);
      setSelected(new Set(r.releases.filter((x) => x.status === "new").map((x) => x.url)));
    });
  };

  const groups = useMemo(() => {
    if (!lookup) return [];
    const byBand = new Map<string, LabelReleaseRow[]>();
    for (const r of lookup.releases) {
      if (filter === "merch" ? r.kind !== "merch" : filter !== "all" && r.status !== filter) continue;
      byBand.set(r.bandName, [...(byBand.get(r.bandName) ?? []), r]);
    }
    return [...byBand].sort((a, b) => a[0].localeCompare(b[0]));
  }, [lookup, filter]);

  const run = async (rows: LabelReleaseRow[]) => {
    if (!lookup || rows.length === 0) return;
    cancelled.current = false;
    const state: Progress = { done: 0, total: rows.length, current: [], results: [], running: true };
    setProgress({ ...state });
    for (let i = 0; i < rows.length && !cancelled.current; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      state.current = batch.map((r) => r.title);
      setProgress({ ...state });
      let results: ReleaseImportResult[];
      try {
        results = await importBandcampReleases(
          batch.map((r) => ({ url: r.url, title: r.title, artist: r.artist, bandName: r.bandName, bandId: r.bandId, releaseId: r.releaseId })),
          lookup.labelHost,
          lookup.label,
        );
      } catch (e) {
        results = batch.map((r) => ({ ok: false as const, title: r.title, error: describeActionError(e) }));
      }
      state.done += batch.length;
      state.results = [...state.results, ...results];
      setProgress({ ...state });
    }
    state.current = [];
    try {
      state.needContacts = (await finishReleaseImport()).needContacts;
    } catch (e) {
      setError(describeActionError(e));
    }
    state.running = false;
    setProgress({ ...state });
    setLookup(null);
    router.refresh();
  };

  const selectedRows = lookup?.releases.filter((r) => selected.has(r.url)) ?? [];
  const newBands = lookup ? new Set(lookup.releases.filter((r) => r.bandId === null && !r.labelRelease).map((r) => r.bandName)) : new Set();
  const failures = progress?.results.filter((r): r is Extract<ReleaseImportResult, { ok: false }> => !r.ok) ?? [];
  const createdBands = [...new Set(progress?.results.flatMap((r) => (r.ok && r.createdBand ? [r.createdBand] : [])) ?? [])];

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="mb-10 border border-border bg-surface-2 px-4 py-3">
      <summary className="font-bold">
        grab releases &amp; merch from your Bandcamp label page{" "}
        <span className="font-normal text-muted">(tracks, dates, catalog numbers, formats, sizes, artwork)</span>
      </summary>

      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          find();
        }}
      >
        <input ref={inputRef} required placeholder="mylabel.bandcamp.com" aria-label="Your label's Bandcamp address" className="!w-80 max-w-full" />
        <button type="submit" disabled={finding || progress?.running} className={buttonClass("primary")}>
          {finding ? "looking…" : "find releases & merch"}
        </button>
      </form>
      <p className="mt-1.5 text-xs text-muted">
        Reads your label’s public “music” and “merch” pages, then each item you choose. Nothing is changed on Bandcamp. Splits and
        anything you’ve edited here are kept when you re-import.
      </p>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}

      {lookup && !progress && (
        <div className="mt-4">
          <p className="mb-2 text-sm">
            Found <b>{lookup.releases.filter((r) => r.kind !== "merch").length}</b> releases and{" "}
            <b>{lookup.releases.filter((r) => r.kind === "merch").length}</b> merch items on {lookup.label ?? "your label"}:{" "}
            {lookup.releases.filter((r) => r.status === "new").length} new,{" "}
            {lookup.releases.filter((r) => r.status === "imported").length} already here.
            {newBands.size > 0 && (
              <>
                {" "}
                {newBands.size} artist{newBands.size === 1 ? " isn’t a band" : "s aren’t bands"} yet and will be added.
              </>
            )}
          </p>
          <div className="mb-2 flex flex-wrap items-center gap-4 text-xs">
            {(["all", "new", "imported", "merch"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`border-b-2 pb-0.5 ${filter === f ? "border-accent font-bold text-text" : "border-transparent text-muted"}`}
              >
                {f === "imported" ? "already here" : f}
              </button>
            ))}
            <span className="ml-auto flex gap-3">
              <button type="button" className="text-link hover:underline" onClick={() => setSelected(new Set(lookup.releases.map((r) => r.url)))}>
                select all
              </button>
              <button
                type="button"
                className="text-link hover:underline"
                onClick={() => setSelected(new Set(lookup.releases.filter((r) => r.status === "new").map((r) => r.url)))}
              >
                only new
              </button>
              <button type="button" className="text-link hover:underline" onClick={() => setSelected(new Set())}>
                none
              </button>
            </span>
          </div>

          <div className="max-h-[28rem] overflow-y-auto border border-border bg-surface">
            {groups.map(([bandName, rows]) => {
              const allOn = rows.every((r) => selected.has(r.url));
              return (
                <section key={bandName}>
                  <label className="sticky top-0 z-10 flex cursor-pointer items-center gap-3 border-b border-border bg-surface-2 px-3 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={allOn}
                      onChange={() => {
                        const next = new Set(selected);
                        for (const r of rows) {
                          if (allOn) next.delete(r.url);
                          else next.add(r.url);
                        }
                        setSelected(next);
                      }}
                    />
                    <b>{bandName}</b>
                    <span className="text-xs text-muted">{rows.length}</span>
                    {rows[0].labelRelease ? (
                      <Badge tone="accent">label releases</Badge>
                    ) : (
                      rows[0].bandId === null && <Badge tone="accent">new band</Badge>
                    )}
                  </label>
                  <ul className="divide-y divide-border">
                    {rows.map((r) => (
                      <li key={r.url}>
                        <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 pl-9">
                          <input
                            type="checkbox"
                            checked={selected.has(r.url)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(r.url);
                              else next.delete(r.url);
                              setSelected(next);
                            }}
                          />
                          {r.artUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={r.artUrl} alt="" loading="lazy" className="h-9 w-9 shrink-0 bg-surface-2 object-cover" />
                          ) : (
                            <span className="h-9 w-9 shrink-0 bg-surface-2" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {r.title}
                            {r.kind === "track" && <span className="ml-2 text-xs text-muted">single</span>}
                            {r.kind === "merch" && <span className="ml-2 text-xs text-muted">merch</span>}
                          </span>
                          {r.status === "imported" && <Badge>will refresh</Badge>}
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" disabled={selectedRows.length === 0} onClick={() => run(selectedRows)} className={buttonClass("primary")}>
              {selectedRows.length === 0 ? "nothing selected" : `import ${selectedRows.length} item${selectedRows.length === 1 ? "" : "s"}`}
            </button>
            <button type="button" className={buttonClass("ghost")} onClick={() => setLookup(null)}>
              cancel
            </button>
            {selectedRows.length > 40 && (
              <span className="text-xs text-muted">About {Math.max(1, Math.round((selectedRows.length * 0.5) / 60))} min. You can keep using the app in another tab.</span>
            )}
          </div>
        </div>
      )}

      {progress && (
        <div className="mt-4 text-sm">
          <div className="mb-1 flex justify-between">
            <span>
              {progress.running ? "importing" : progress.done < progress.total ? "stopped" : "done"}: {progress.done} of {progress.total}
            </span>
            {progress.running && (
              <button type="button" className="text-link hover:underline" onClick={() => (cancelled.current = true)}>
                stop
              </button>
            )}
          </div>
          <div className="h-1.5 w-full bg-border">
            <div className="h-1.5 bg-accent transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          {progress.running && progress.current.length > 0 && <p className="mt-1 truncate text-xs text-muted">{progress.current.join(" · ")}</p>}
          {!progress.running && (
            <div className="mt-3 space-y-1">
              <p className={progress.results.some((r) => r.ok) ? "text-good" : "text-muted"}>
                Imported {progress.results.filter((r) => r.ok).length} item(s):{" "}
                {progress.results.filter((r) => r.ok && r.created).length} new,{" "}
                {progress.results.filter((r) => r.ok && !r.created).length} updated,{" "}
                {progress.results.reduce((a, r) => a + (r.ok ? r.tracks : 0), 0)} tracks.
              </p>
              {progress.results.some((r) => r.ok && r.compilation) && (
                <p>
                  Compilations: {progress.results.filter((r) => r.ok && r.compilation).map((r) => r.title).join(", ")}. Tracks by
                  your artists go to their bands, and album sales are shared across the tracks.
                </p>
              )}
              {!!progress.needContacts && (
                <p className="font-bold text-warn">
                  {progress.needContacts} artist{progress.needContacts === 1 ? " who isn’t" : "s who aren’t"} on the label appear on your releases.{" "}
                  <a href="#outside-artists">Add a contact for each</a> so they can be paid.
                </p>
              )}
              {createdBands.length > 0 && (
                <p>
                  New bands: {createdBands.join(", ")}. Add their members and splits on the Bands page.
                </p>
              )}
              {failures.length > 0 && failures.length === progress.results.length && (
                <p className="font-bold text-bad">Nothing was imported: {failures[0].error}</p>
              )}
              {failures.length > 0 && (
                <details className="text-bad" open={failures.length <= 5}>
                  <summary>{failures.length} couldn’t be imported</summary>
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {failures.map((f) => (
                      <li key={f.title}>
                        {f.title}: {f.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </details>
  );
}
