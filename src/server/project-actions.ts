"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { parseCents } from "@/lib/money";
import { requireAdmin } from "./context";

const { projects, projectReleases, releases, bands } = schema;

export type ProjectState = { ok?: string; error?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Create or edit a project: its name, band, releases, budget and status. */
export async function saveProject(_: ProjectState, fd: FormData): Promise<ProjectState> {
  const { orgId } = await requireAdmin();
  const name = str(fd, "name");
  if (!name) return { error: "Give the project a name." };
  const bandId = Number(str(fd, "bandId")) || null;
  if (bandId) {
    const [b] = await db
      .select({ id: bands.id })
      .from(bands)
      .where(and(eq(bands.orgId, orgId), eq(bands.id, bandId)));
    if (!b) return { error: "That band isn't part of this account." };
  }
  const releaseIds = [...new Set(fd.getAll("releaseIds").map(Number).filter(Number.isFinite))];
  if (releaseIds.length) {
    const found = await db
      .select({ id: releases.id })
      .from(releases)
      .where(and(eq(releases.orgId, orgId), inArray(releases.id, releaseIds)));
    if (found.length !== releaseIds.length) return { error: "Some of those releases aren't part of this account." };
  }
  const budget = str(fd, "budget");
  const values = {
    name,
    bandId,
    status: (str(fd, "status") === "done" ? "done" : "active") as "active" | "done",
    budgetCents: budget ? parseCents(budget) || null : null,
    currency: (str(fd, "currency") || "USD").toUpperCase(),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(str(fd, "startDate")) ? str(fd, "startDate") : null,
    notes: str(fd, "notes") || null,
  };
  const id = Number(str(fd, "id")) || null;
  const projectId = await db.transaction(async (tx) => {
    let pid = id;
    if (pid) {
      const [row] = await tx
        .update(projects)
        .set(values)
        .where(and(eq(projects.orgId, orgId), eq(projects.id, pid)))
        .returning({ id: projects.id });
      if (!row) throw new Error("Project not found.");
      await tx.delete(projectReleases).where(eq(projectReleases.projectId, pid));
    } else {
      [{ id: pid }] = await tx
        .insert(projects)
        .values({ ...values, orgId })
        .returning({ id: projects.id });
    }
    if (releaseIds.length) await tx.insert(projectReleases).values(releaseIds.map((releaseId) => ({ orgId, projectId: pid!, releaseId })));
    return pid!;
  });
  revalidatePath("/", "layout");
  if (!id) redirect(`/projects/${projectId}`);
  return { ok: "Saved." };
}

/** Delete a project. Its expenses stay (they just aren't assigned to a project any more). */
export async function deleteProject(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db.delete(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, Number(fd.get("id")))));
  revalidatePath("/", "layout");
  redirect("/projects");
}
