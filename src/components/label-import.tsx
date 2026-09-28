"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { describeActionError } from "@/lib/action-errors";
import { addLabelArtists, findLabelArtists, type LabelArtistRow } from "@/server/actions";
import { Badge, buttonClass } from "./ui";

export const LABEL_URL_STORAGE_KEY = "label-payouts:label-url";

export function LabelImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ label: string | null; source: string; artists: LabelArtistRow[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  // Local state, so the panel doesn't snap shut when the page re-renders after adding bands.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LABEL_URL_STORAGE_KEY);
      if (saved && inputRef.current && !inputRef.current.value) inputRef.current.value = saved;
    } catch {
      // storage unavailable; the field just starts empty
    }
  }, []);

  const find = () => {
    const url = inputRef.current?.value ?? "";
    start(async () => {
      setMessage(null);
      setResult(null);
      let r: Awaited<ReturnType<typeof findLabelArtists>>;
      try {
        r = await findLabelArtists(url);
      } catch (e) {
        return setMessage({ tone: "bad", text: describeActionError(e) });
      }
      if ("error" in r) return setMessage({ tone: "bad", text: r.error });
      try {
        localStorage.setItem(LABEL_URL_STORAGE_KEY, url);
      } catch {}
      setResult(r);
      setSelected(new Set(r.artists.filter((a) => a.status !== "linked").map((a) => a.url)));
    });
  };

  const add = () =>
    start(async () => {
      if (!result) return;
      const rows = result.artists.filter((a) => selected.has(a.url) && a.status !== "linked");
      let res: Awaited<ReturnType<typeof addLabelArtists>>;
      try {
        res = await addLabelArtists(rows);
      } catch (e) {
        return setMessage({ tone: "bad", text: describeActionError(e) });
      }
      const { added, updated } = res;
      setMessage({
        tone: "good",
        text: `Added ${added} band${added === 1 ? "" : "s"}${updated ? `, linked ${updated} existing band${updated === 1 ? "" : "s"} to Bandcamp` : ""}. Next: add members and a default split for each.`,
      });
      setResult(null);
    });

  const choosable = result?.artists.filter((a) => a.status !== "linked") ?? [];
  const count = choosable.filter((a) => selected.has(a.url)).length;

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="mb-10 border border-border bg-surface-2 px-4 py-3">
      <summary className="font-bold">
        grab bands from your Bandcamp label page <span className="font-normal text-muted">(fills in names and URLs for you)</span>
      </summary>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          find();
        }}
      >
        <input
          ref={inputRef}
          required
          placeholder="mylabel.bandcamp.com"
          aria-label="Your label's Bandcamp address"
          className="!w-80 max-w-full"
        />
        <button type="submit" disabled={pending} className={buttonClass("primary")}>
          {pending && !result ? "looking…" : "find artists"}
        </button>
      </form>
      <p className="mt-1.5 text-xs text-muted">Reads the public “artists” tab of your label page. Nothing is changed on Bandcamp.</p>

      {message && <p className={`mt-3 text-sm ${message.tone === "good" ? "text-good" : "text-bad"}`}>{message.text}</p>}

      {result && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              Found <b>{result.artists.length}</b> artists on {result.label ?? "your label"}.
            </p>
            {choosable.length > 0 && (
              <div className="flex gap-3 text-xs">
                <button type="button" className="text-link hover:underline" onClick={() => setSelected(new Set(choosable.map((a) => a.url)))}>
                  select all
                </button>
                <button type="button" className="text-link hover:underline" onClick={() => setSelected(new Set())}>
                  select none
                </button>
              </div>
            )}
          </div>
          <ul className="max-h-96 divide-y divide-border overflow-y-auto border border-border bg-surface">
            {result.artists.map((a) => (
              <li key={a.url}>
                <label className={`flex items-center gap-3 px-3 py-2 ${a.status === "linked" ? "opacity-60" : "cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    disabled={a.status === "linked"}
                    checked={a.status === "linked" || selected.has(a.url)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(a.url);
                      else next.delete(a.url);
                      setSelected(next);
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-bold">{a.name}</span>
                    {a.location && <span className="ml-2 text-xs text-muted">{a.location}</span>}
                    <span className="block truncate text-xs text-muted">{a.url.replace(/^https:\/\//, "")}</span>
                  </span>
                  {a.status === "linked" && <Badge tone="good">already added</Badge>}
                  {a.status === "add_url" && <Badge tone="accent">exists · will add URL</Badge>}
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-3">
            <button type="button" disabled={pending || count === 0} onClick={add} className={buttonClass("primary")}>
              {pending ? "adding…" : count === 0 ? "nothing selected" : `add ${count} band${count === 1 ? "" : "s"}`}
            </button>
            <button type="button" className={buttonClass("ghost")} onClick={() => setResult(null)}>
              cancel
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
