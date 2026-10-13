"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { readApplication } from "@/lib/applications";
import { approveApplication, latestApplication, rejectApplication } from "./applications";
import { getSession } from "./context";
import { requireSiteAdmin } from "./site-admin";

export type ApplyState = { error?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const all = (fd: FormData, k: string) => fd.getAll(k).map(String);

/** Ask for a new label or band account. One waiting application at a time. */
export async function applyForAccount(_: ApplyState, fd: FormData): Promise<ApplyState> {
  const session = await getSession();
  if (!session) redirect("/login?next=/welcome");
  const current = await latestApplication(session.user.id);
  if (current?.status === "pending") return { error: "Your application is already waiting for review." };
  const r = readApplication({
    kind: str(fd, "kind"),
    name: str(fd, "name"),
    bandcampUrl: str(fd, "bandcampUrl"),
    website: str(fd, "website"),
    about: str(fd, "about"),
    memberName: all(fd, "memberName"),
    memberRole: all(fd, "memberRole"),
    memberEmail: all(fd, "memberEmail"),
    artistName: all(fd, "artistName"),
    artistUrl: all(fd, "artistUrl"),
    teamName: all(fd, "teamName"),
    teamEmail: all(fd, "teamEmail"),
  });
  if (!r.ok) return { error: r.error };
  await db.insert(schema.accountApplications).values({ userId: session.user.id, ...r.value });
  revalidatePath("/welcome");
  redirect("/welcome");
}

/** Site admin: approve an application, setting the account up. */
export async function approveAccountApplication(fd: FormData) {
  const session = await requireSiteAdmin();
  await approveApplication(Number(str(fd, "id")), session.user.id);
  revalidatePath("/admin");
}

/** Site admin: turn an application down, with a note the applicant sees. */
export async function rejectAccountApplication(fd: FormData) {
  const session = await requireSiteAdmin();
  await rejectApplication(Number(str(fd, "id")), session.user.id, str(fd, "note").trim().slice(0, 1000) || null);
  revalidatePath("/admin");
}
