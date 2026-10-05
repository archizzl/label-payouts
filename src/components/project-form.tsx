import { ActionForm, SubmitButton } from "@/components/client";
import { Field } from "@/components/ui";
import type { schema } from "@/db";
import { centsToDecimal } from "@/lib/money";
import { saveProject } from "@/server/project-actions";

type Band = Pick<typeof schema.bands.$inferSelect, "id" | "name">;
type Release = Pick<typeof schema.releases.$inferSelect, "id" | "title" | "bandId" | "kind" | "releaseDate">;

/** Create or edit a project: name, band, the releases whose sales count, budget, status. */
export function ProjectForm({
  project,
  releaseIds = [],
  bands,
  releases,
  bandId,
}: {
  project?: typeof schema.projects.$inferSelect;
  releaseIds?: number[];
  bands: Band[];
  releases: Release[];
  bandId?: number;
}) {
  const p = project;
  const forBand = p?.bandId ?? bandId ?? null;
  // The project's band's releases first, then the rest.
  const ordered = [...bands].sort((a, b) => Number(b.id === forBand) - Number(a.id === forBand) || a.name.localeCompare(b.name));
  return (
    <ActionForm action={saveProject} className="grid gap-4 sm:grid-cols-3">
      {p && <input type="hidden" name="id" value={p.id} />}
      <Field label="Project name" className="sm:col-span-2">
        <input name="name" required defaultValue={p?.name} placeholder="Triple Single (album)" />
      </Field>
      <Field label="For">
        <select name="bandId" defaultValue={forBand ?? ""}>
          <option value="">The whole label</option>
          {bands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Budget (optional)">
        <span className="flex gap-2">
          <input name="budget" inputMode="decimal" defaultValue={p?.budgetCents ? centsToDecimal(p.budgetCents) : ""} placeholder="5000.00" />
          <input name="currency" defaultValue={p?.currency ?? "USD"} className="!w-20" aria-label="Currency" />
        </span>
      </Field>
      <Field label="Started (optional)">
        <input name="startDate" type="date" defaultValue={p?.startDate ?? ""} />
      </Field>
      <Field label="Status">
        <select name="status" defaultValue={p?.status ?? "active"}>
          <option value="active">In progress</option>
          <option value="done">Done</option>
        </select>
      </Field>
      <fieldset className="sm:col-span-3">
        <legend className="mb-1 text-sm font-medium">Releases and merch whose sales count toward it</legend>
        <p className="mb-2 text-xs text-muted">Their physical formats count too. Add singles, the album, a shirt made for it…</p>
        <div className="max-h-64 space-y-3 overflow-y-auto rounded-sm border border-border p-3">
          {ordered.map((b) => {
            const mine = releases.filter((r) => r.bandId === b.id);
            if (!mine.length) return null;
            return (
              <div key={b.id}>
                <div className="mb-1 text-xs font-medium text-muted">{b.name}</div>
                <div className="grid gap-1 sm:grid-cols-2">
                  {mine.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="releaseIds" value={r.id} defaultChecked={releaseIds.includes(r.id)} />
                      <span className="truncate">
                        {r.title}
                        <span className="text-xs text-muted">
                          {r.kind === "merch" ? " · merch" : r.kind === "track" ? " · single" : ""}
                          {r.releaseDate ? ` · ${r.releaseDate.slice(0, 4)}` : ""}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>
      <Field label="Notes (optional)" className="sm:col-span-3">
        <input name="notes" defaultValue={p?.notes ?? ""} placeholder="Recorded at …, mixed by …" />
      </Field>
      <div className="sm:col-span-3">
        <SubmitButton>{p ? "Save" : "Create project"}</SubmitButton>
      </div>
    </ActionForm>
  );
}
