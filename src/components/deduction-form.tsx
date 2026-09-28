"use client";

import { useState } from "react";
import type { deductions as deductionsTable } from "@/db/schema";
import { ITEM_CATEGORIES } from "@/lib/bandcamp-csv";
import { saveDeduction } from "@/server/actions";
import { SubmitButton } from "./client";
import { Field } from "./ui";

type Deduction = typeof deductionsTable.$inferSelect;
type Option = { id: number; name: string };
/** A release, with its physical formats so a cost can target just one of them. */
export type ReleaseOption = Option & { bandId: number; formats?: { id: number; title: string }[] };

const KIND_HELP = {
  percent: "Comes off what’s left after any earlier deductions.",
  per_unit: "Taken from every matching item sold (× quantity), e.g. $3.42 per CD, before the profit is split. Never more than the sale; refunds reverse it.",
  fixed: "Taken from matching sales, oldest first, until the total is paid off (e.g. a $300 mastering bill), then it stops.",
} as const;

/**
 * Add or edit a deduction. Only the fields that matter for the chosen type and destination are
 * shown; the optional "limit to…" filters are tucked away unless one is already set.
 */
export function DeductionForm({
  deduction: existing,
  bands,
  releases,
  people,
  fixedBandId,
}: {
  deduction?: Deduction;
  bands: Option[];
  releases: ReleaseOption[];
  people: Option[];
  /** On a band's page: the deduction always belongs to that band. */
  fixedBandId?: number;
}) {
  const d = existing;
  const [kind, setKind] = useState<Deduction["kind"]>(d?.kind ?? "percent");
  const [destination, setDestination] = useState<Deduction["destination"]>(d?.destination ?? (fixedBandId ? "band_fund" : "label"));
  const releaseOptions = fixedBandId ? releases.filter((r) => r.bandId === fixedBandId) : releases;
  const formatOptions = releaseOptions.flatMap((r) => (r.formats ?? []).map((f) => ({ key: `${r.id}:${f.id}`, label: `${r.name} — ${f.title}` })));
  const hasLimits = !!(
    (!fixedBandId && d?.bandId) ||
    d?.releaseId ||
    d?.itemCategory ||
    d?.packageId ||
    d?.formatMatch ||
    d?.effectiveFrom ||
    d?.effectiveTo ||
    d?.sortOrder
  );

  return (
    <form action={saveDeduction} className="space-y-4">
      {d && <input type="hidden" name="id" value={d.id} />}
      {fixedBandId && <input type="hidden" name="bandId" value={fixedBandId} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input name="label" required defaultValue={d?.label} placeholder={fixedBandId ? "Band fund, Van repair…" : "Label cut"} />
        </Field>
        <Field label="Type" hint={KIND_HELP[kind]}>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as Deduction["kind"])}>
            <option value="percent">Percentage of each sale</option>
            <option value="per_unit">Fixed amount per item sold</option>
            <option value="fixed">Fixed total, recouped until paid off</option>
          </select>
        </Field>

        {kind === "percent" ? (
          <Field label="Percent">
            <input name="percent" inputMode="decimal" required defaultValue={d?.percentBps != null ? d.percentBps / 100 : ""} placeholder="20" />
          </Field>
        ) : (
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label={kind === "per_unit" ? "Amount per item" : "Total amount"}>
              <input name="amount" inputMode="decimal" required defaultValue={d?.amountCents != null ? d.amountCents / 100 : ""} placeholder={kind === "per_unit" ? "3.42" : "300"} />
            </Field>
            <Field label="Currency">
              <input name="currency" defaultValue={d?.currency ?? "USD"} maxLength={3} />
            </Field>
          </div>
        )}

        <Field label="Where the money goes">
          <select name="destination" value={destination} onChange={(e) => setDestination(e.target.value as Deduction["destination"])}>
            <option value="label">Kept by the label</option>
            <option value="band_fund">Band fund</option>
            <option value="expense">Withheld to pay a cost</option>
            <option value="person">Paid to a person</option>
          </select>
        </Field>
        {destination === "person" && (
          <Field label="Paid to">
            <select name="personId" required defaultValue={d?.personId ?? ""}>
              <option value="" disabled>
                Choose a person
              </option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <details open={hasLimits} className="border-t border-border pt-3">
        <summary className="text-sm text-link">limit to certain sales or dates (optional)</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {!fixedBandId && (
            <Field label="Only for band">
              <select name="bandId" defaultValue={d?.bandId ?? ""}>
                <option value="">All bands</option>
                {bands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Only for release">
            <select name="releaseId" defaultValue={d?.releaseId ?? ""}>
              <option value="">Any release</option>
              {releaseOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Only for item type">
            <select name="itemCategory" defaultValue={d?.itemCategory ?? ""}>
              <option value="">Any item type</option>
              {ITEM_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          {kind !== "percent" && formatOptions.length > 0 && (
            <Field label="Only for one format" hint="E.g. just the Triple Single CD, not its vinyl.">
              <select name="formatKey" defaultValue={d?.packageId && d.releaseId ? `${d.releaseId}:${d.packageId}` : ""}>
                <option value="">Any format</option>
                {formatOptions.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Only for formats matching words" hint="E.g. “CD” or “cassette, tape”. Digital sales never match.">
            <input name="formatMatch" defaultValue={d?.formatMatch ?? ""} placeholder="CD" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <input type="date" name="effectiveFrom" defaultValue={d?.effectiveFrom ?? ""} />
            </Field>
            <Field label="Until">
              <input type="date" name="effectiveTo" defaultValue={d?.effectiveTo ?? ""} />
            </Field>
          </div>
          <Field label="Order" hint="When several deductions apply, lower numbers come off first. Label-wide ones always come before band ones.">
            <input name="sortOrder" type="number" defaultValue={d?.sortOrder ?? 0} />
          </Field>
        </div>
      </details>

      <SubmitButton>{d ? "Save" : "Add deduction"}</SubmitButton>
    </form>
  );
}
