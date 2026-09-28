"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { saveSplitRule } from "@/server/actions";
import { buttonClass } from "./ui";

export type PersonOption = { id: number; name: string; roles?: string[]; inBand?: boolean };

type Props = {
  scope: "label_default" | "band_default" | "band_item_type" | "release" | "track";
  bandId?: number | null;
  releaseId?: number | null;
  trackId?: number | null;
  itemCategory?: string | null;
  ruleId?: number;
  people: PersonOption[];
  initial?: { personId: number; bps: number }[];
  effectiveFrom?: string;
  overridesCatalog?: boolean;
  showOverride?: boolean;
};

const toPct = (bps: number) => (bps / 100).toString();
const toBps = (pct: string) => Math.round((Number.parseFloat(pct) || 0) * 100);

export function SplitEditor(props: Props) {
  const [state, action, pending] = useActionState(saveSplitRule, null);
  // The label-wide default takes optional carve-outs; the rest goes evenly to each band's members.
  const carveOuts = props.scope === "label_default";
  const initialRows = useMemo(() => {
    const byPerson = new Map((props.initial ?? []).map((s) => [s.personId, s.bps]));
    // Band members first, then anyone already in the split.
    const ids = [
      ...props.people.filter((p) => p.inBand !== false).map((p) => p.id),
      ...[...byPerson.keys()],
    ].filter((id, i, a) => a.indexOf(id) === i);
    return ids.map((id) => ({ personId: id, pct: byPerson.has(id) ? toPct(byPerson.get(id)!) : "" }));
  }, [props.people, props.initial]);

  const [rows, setRows] = useState(initialRows);
  const formRef = useRef<HTMLFormElement>(null);
  // Collapse the surrounding disclosure after a successful save so it can't be submitted twice.
  useEffect(() => {
    if (state?.ok) formRef.current?.closest("details")?.removeAttribute("open");
  }, [state]);
  const [adding, setAdding] = useState("");
  const total = rows.reduce((a, r) => a + toBps(r.pct), 0);
  const nameOf = (id: number) => props.people.find((p) => p.id === id)?.name ?? `#${id}`;
  const rolesOf = (id: number) => props.people.find((p) => p.id === id)?.roles ?? [];
  const others = props.people.filter((p) => !rows.some((r) => r.personId === p.id));

  /** 100% divided equally between everyone listed; leftover basis points go to the first rows. */
  const splitEvenly = () => {
    const n = rows.length;
    if (!n) return;
    const base = Math.floor(10000 / n);
    let extra = 10000 - base * n;
    setRows(rows.map((r) => ({ ...r, pct: toPct(base + (extra-- > 0 ? 1 : 0)) })));
  };

  const shares = rows.map((r) => ({ personId: r.personId, bps: toBps(r.pct) })).filter((s) => s.bps > 0);

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <input type="hidden" name="scope" value={props.scope} />
      {props.bandId != null && <input type="hidden" name="bandId" value={props.bandId} />}
      {props.releaseId != null && <input type="hidden" name="releaseId" value={props.releaseId} />}
      {props.trackId != null && <input type="hidden" name="trackId" value={props.trackId} />}
      {props.itemCategory && <input type="hidden" name="itemCategory" value={props.itemCategory} />}
      {props.ruleId && <input type="hidden" name="ruleId" value={props.ruleId} />}
      <input type="hidden" name="shares" value={JSON.stringify(shares)} />

      <div className="space-y-1.5">
        {rows.length === 0 &&
          (carveOuts ? (
            <p className="text-sm text-muted">No carve-outs: each band’s members share everything evenly.</p>
          ) : (
            <p className="text-sm text-muted">No band members yet. Add people below or on the band page.</p>
          ))}
        {rows.map((r, i) => (
          <div key={r.personId} className="flex items-center gap-3">
            <div className="min-w-0 flex-1 text-sm">
              {nameOf(r.personId)}
              {rolesOf(r.personId).length > 0 && <span className="ml-2 text-xs text-muted">{rolesOf(r.personId).join(", ")}</span>}
            </div>
            <div className="flex w-28 items-center gap-1">
              <input
                inputMode="decimal"
                aria-label={`${nameOf(r.personId)} share percent`}
                value={r.pct}
                placeholder="0"
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))}
                className="text-right"
              />
              <span className="text-sm text-muted">%</span>
            </div>
            <button
              type="button"
              aria-label={`Remove ${nameOf(r.personId)} from this split`}
              title="Remove from this split"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
              className="flex h-7 w-7 shrink-0 items-center justify-center text-lg leading-none text-muted hover:text-bad"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {others.length > 0 && (
          <>
            <select value={adding} onChange={(e) => setAdding(e.target.value)} className="!w-auto" aria-label="Add a person to this split">
              <option value="">{carveOuts ? "+ Carve out a share for…" : "+ Add someone…"}</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {adding && (
              <button
                type="button"
                className={buttonClass("secondary", "sm")}
                onClick={() => {
                  setRows([...rows, { personId: Number(adding), pct: "" }]);
                  setAdding("");
                }}
              >
                Add
              </button>
            )}
          </>
        )}
        {!carveOuts && (
          <button
            type="button"
            className={buttonClass("ghost", "sm")}
            onClick={splitEvenly}
            title="Divide 100% equally between everyone listed"
          >
            Split evenly
          </button>
        )}
        {carveOuts ? (
          <span className={`ml-auto text-sm font-medium tabular-nums ${total <= 10000 ? "text-good" : "text-bad"}`}>
            {total > 10000
              ? `Carve-outs total ${(total / 100).toFixed(2)}%, more than 100%`
              : `${((10000 - total) / 100).toFixed(2)}% split evenly between each band’s members`}
          </span>
        ) : (
          <span className={`ml-auto text-sm font-medium tabular-nums ${total === 10000 ? "text-good" : "text-bad"}`}>
            Total {(total / 100).toFixed(2)}%
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Effective from</span>
          <input type="date" name="effectiveFrom" defaultValue={props.effectiveFrom && props.effectiveFrom !== "2000-01-01" ? props.effectiveFrom : ""} className="!w-40" />
        </label>
        {props.showOverride && (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="overridesCatalog" defaultChecked={props.overridesCatalog} />
            Use this even when the release/track has its own split
          </label>
        )}
        <button type="submit" disabled={pending || (carveOuts ? total > 10000 : total !== 10000)} className={`${buttonClass("primary")} ml-auto`}>
          {pending ? "Saving…" : "Save split"}
        </button>
      </div>
      <p className="text-xs text-muted">Leave the date blank for “always”. Add a newer split with a later date to change shares going forward without rewriting past periods.</p>
      {state?.error && <p className="text-sm text-bad">{state.error}</p>}
      {state?.ok && <p className="text-sm text-good">{state.ok}</p>}
    </form>
  );
}
