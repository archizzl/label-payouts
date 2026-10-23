import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { AREAS } from "@/lib/permissions";
import {
  cancelInvite,
  deleteMemberType,
  inviteMember,
  linkMyself,
  removeAccountMember,
  saveAccountSettings,
  saveBandSettings,
  saveManagedBands,
  saveMemberType,
  saveMyDetails,
  setMemberRole,
  testBandcampConnection,
} from "../../account-actions";
import { resetInviteLink } from "../../band-invite-actions";
import { myDetails } from "../../people";
import { projectsEnabled } from "../../features";
import { cancelBandAccountInvite, inviteToBandAccount, unlink } from "../../link-actions";
import { deleteProject, saveProject } from "../../project-actions";
import { actionTool } from "../tool";
import { amount, current, currency, date, id, or, toAmount } from "./shared";

/*
 * The group's settings and who can sign in (admins), your own details, and projects. Bandcamp's API
 * client ID and secret aren't here: a secret doesn't belong in a chat, so that's on Settings.
 */

const roleChoice = z.string().describe('"admin", "member" (sees only their own earnings), or "type:ID" for a member type (who_can_sign_in lists them)');

const groupSettings = actionTool({
  name: "save_group_settings",
  label: "Change the group's settings",
  description: "Change the group's name and where it is: its Bandcamp, Spotify and Apple Music addresses. Only the fields given change.",
  params: z.object({
    name: z.string().min(1).max(120).optional(),
    bandcampUrl: z.string().max(300).optional(),
    spotifyUrl: z.string().max(300).optional(),
    appleMusicUrl: z.string().max(300).optional(),
  }),
  needs: "admin",
  available: (ctx) => ctx.org.kind === "label",
  action: (fd) => saveAccountSettings(null, fd),
});

const bandGroupSettings = actionTool({
  name: "save_band_settings",
  label: "Change the band's settings",
  description: "Change this band group's name, its other spellings, and its Bandcamp, Spotify and Apple Music addresses. Only the fields given change.",
  params: z.object({
    name: z.string().min(1).max(200).optional(),
    otherNames: z.array(z.string().min(1).max(200)).optional(),
    bandcampUrl: z.string().max(300).optional(),
    spotifyUrl: z.string().max(300).optional(),
    appleMusicUrl: z.string().max(300).optional(),
  }),
  needs: "admin",
  available: (ctx) => ctx.org.kind === "band",
  action: (fd) => saveBandSettings(null, fd),
  fields: async (ctx, a) => {
    // The band's record: in the label's books for a band group the label made, else its own.
    const booksId = ctx.managedBy ? ctx.managedBy.labelOrgId : ctx.orgId;
    const [band] = ctx.managedBy
      ? await db.select().from(schema.bands).where(and(eq(schema.bands.orgId, booksId), eq(schema.bands.id, ctx.managedBy.bandId)))
      : await db.select().from(schema.bands).where(and(eq(schema.bands.orgId, booksId), eq(schema.bands.isLabel, false))).limit(1);
    const [settings] = await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, ctx.org.id));
    return {
      name: or(a.name, band?.name),
      aliases: or(a.otherNames, band?.aliases ?? []).join(","),
      bandcampUrl: or(a.bandcampUrl, settings?.bandcampUrl ?? ""),
      spotifyUrl: or(a.spotifyUrl, settings?.spotifyUrl ?? ""),
      appleMusicUrl: or(a.appleMusicUrl, settings?.appleMusicUrl ?? ""),
    };
  },
});

const testConnection = actionTool({
  name: "test_bandcamp_connection",
  label: "Test the Bandcamp connection",
  description: "Sign in to Bandcamp's API with the group's access and say which Bandcamp accounts it reaches.",
  params: z.object({}),
  needs: "admin",
  action: () => testBandcampConnection(),
});

const invite = actionTool({
  name: "invite_to_group",
  label: "Invite someone to sign in",
  description: "Invite someone by email to sign in to this group, as an admin, a member, or a member type; personId links them to their payee record.",
  params: z.object({ email: z.string().email(), role: roleChoice, personId: id.optional() }),
  needs: "admin",
  action: (fd) => inviteMember(null, fd),
});

const cancelInviteTool = actionTool({
  name: "cancel_invite",
  label: "Cancel an invite",
  description: "Cancel an invite that hasn't been used (who_can_sign_in lists them).",
  params: z.object({ inviteId: z.string().min(1) }),
  needs: "admin",
  action: (fd) => cancelInvite(fd),
  fields: (_ctx, a) => ({ id: a.inviteId }),
});

const setRole = actionTool({
  name: "set_member_role",
  label: "Change what someone can do",
  description: "Change what someone who signs in here can do: admin, member, or a member type (not the owner).",
  params: z.object({ memberId: z.string().min(1), role: roleChoice }),
  needs: "admin",
  action: (fd) => setMemberRole(fd),
});

const managedBands = actionTool({
  name: "set_managed_bands",
  label: "Set the bands someone looks after",
  description: "For someone whose member type is limited to their own bands: the bands they look after (bandIds), or leave out bandIds for the bands they play in.",
  params: z.object({ userId: z.string().min(1), bandIds: z.array(id).optional() }),
  needs: "admin",
  action: (fd) => saveManagedBands(fd),
  fields: (_ctx, a) => ({ userId: a.userId, mode: a.bandIds ? "picked" : "member", bandId: a.bandIds }),
});

const area = z.enum(AREAS.map((a) => a.key) as [string, ...string[]]);
const memberType = actionTool({
  name: "save_member_type",
  label: "Save a member type",
  description: `Add a member type (what a kind of member can see and change), or change one (give its id: its sections are replaced by the ones given). Sections: ${AREAS.map((a) => `${a.key} (${a.label})`).join(", ")}. ownBandsOnly: sections limited to their own bands.`,
  params: z.object({
    id: id.optional(),
    name: z.string().min(1).max(60),
    sections: z.array(z.object({ section: area, level: z.enum(["view", "edit"]) })),
    ownBandsOnly: z.array(area).optional(),
  }),
  needs: "admin",
  items: { id: "member type" },
  action: (fd) => saveMemberType(null, fd),
  fields: (_ctx, a) => ({
    id: a.id,
    name: a.name,
    ...Object.fromEntries(a.sections.map((s) => [`perm:${s.section}`, s.level])),
    ...Object.fromEntries((a.ownBandsOnly ?? []).map((k) => [`bands:${k}`, true])),
  }),
});

const deleteType = actionTool({
  name: "delete_member_type",
  label: "Delete a member type",
  description: "Delete a member type. Anyone who had it goes back to seeing just their own earnings.",
  params: z.object({ id }),
  needs: "admin",
  items: { id: "member type" },
  action: (fd) => deleteMemberType(fd),
});

const removeLogin = actionTool({
  name: "remove_from_group",
  label: "Stop someone signing in here",
  description: "Remove someone's login from this group (their payee record stays).",
  params: z.object({ memberId: z.string().min(1) }),
  needs: "admin",
  action: (fd) => removeAccountMember(fd),
});

const linkMe = actionTool({
  name: "link_myself",
  label: "Link your login to a person",
  description: "Link your own login to the person who gets paid as you here (or unlink it: leave out personId).",
  params: z.object({ personId: id.optional() }),
  needs: "admin",
  action: (fd) => linkMyself(fd),
});

const saveMyDetailsTool = actionTool({
  name: "save_my_details",
  label: "Change your details",
  description: "Change your own name and how you're paid (email, PayPal.me, Venmo, Cash App), everywhere you're paid. Only the fields given change.",
  params: z.object({
    name: z.string().min(1).max(120).optional(),
    email: z.string().max(200).optional(),
    paypalMe: z.string().max(200).optional(),
    venmo: z.string().max(100).optional(),
    cashtag: z.string().max(100).optional(),
  }),
  needs: "anyone",
  action: (fd) => saveMyDetails(null, fd),
  // The action writes every field to all their payee records, so start from what's there now.
  fields: async (ctx, a) => {
    const now = await myDetails(ctx.user.id, ctx.user.name);
    return {
      name: or(a.name, now.name),
      email: or(a.email, now.email ?? ""),
      paypalMe: or(a.paypalMe, now.paypalMe ?? ""),
      venmo: or(a.venmo, now.venmo ?? ""),
      cashtag: or(a.cashtag, now.cashtag ?? ""),
    };
  },
});

const inviteBand = actionTool({
  name: "invite_to_band_group",
  label: "Invite a band to its group",
  description: "Invite someone by email to run a band's own group from the label (the whole band shares one login).",
  params: z.object({ bandId: id, email: z.string().email() }),
  needs: "admin",
  available: (ctx) => ctx.org.kind === "label",
  action: (fd) => inviteToBandAccount(null, fd),
});

const cancelBandInvite = actionTool({
  name: "cancel_band_group_invite",
  label: "Cancel a band group's invite",
  description: "Cancel an invite to a band's group from the label.",
  params: z.object({ bandId: id, inviteId: z.string().min(1) }),
  needs: "admin",
  available: (ctx) => ctx.org.kind === "label",
  action: (fd) => cancelBandAccountInvite(fd),
  fields: (_ctx, a) => ({ bandId: a.bandId, id: a.inviteId }),
});

const resetLink = actionTool({
  name: "reset_band_invite_link",
  label: "Reset a band's invite link",
  description: "Make a new standing invite link for a band's group (the old one stops working). In a band's own group, leave out bandId.",
  params: z.object({ bandId: id.optional() }),
  needs: "admin",
  action: (fd) => resetInviteLink(fd),
});

const unlinkTool = actionTool({
  name: "unlink_groups",
  label: "End a link between a label and a band",
  description: "End a link between this group and a label or band that runs its own group (group_links lists them).",
  params: z.object({ linkId: id }),
  needs: "admin",
  action: (fd) => unlink(fd),
  fields: (_ctx, a) => ({ id: a.linkId }),
});

const saveProjectTool = actionTool({
  name: "save_project",
  label: "Save a project",
  description:
    "Add a project (an album, tour or video: what it cost against what its releases made back), or change one (give its id; only the fields given change). status: active or done.",
  params: z.object({
    id: id.optional(),
    name: z.string().min(1).max(120).optional(),
    bandId: id.optional(),
    releaseIds: z.array(id).optional(),
    budget: amount.optional(),
    currency: currency.optional(),
    status: z.enum(["active", "done"]).optional(),
    startDate: date.optional(),
    notes: z.string().max(1000).optional(),
  }),
  needs: "admin",
  items: { id: "project" },
  available: () => projectsEnabled(),
  action: (fd) => saveProject(null, fd),
  fields: async (ctx, a) => {
    const p = a.id ? await current(schema.projects, ctx.orgId, a.id, "project") : null;
    const releases = a.id
      ? (await db.select({ id: schema.projectReleases.releaseId }).from(schema.projectReleases).where(eq(schema.projectReleases.projectId, a.id))).map((r) => r.id)
      : [];
    return {
      id: a.id,
      name: or(a.name, p?.name),
      bandId: or(a.bandId, p?.bandId ?? undefined),
      releaseIds: or(a.releaseIds, releases),
      budget: or(a.budget, toAmount(p?.budgetCents)),
      currency: or(a.currency, p?.currency),
      status: or(a.status, p?.status),
      startDate: or(a.startDate, p?.startDate ?? undefined),
      notes: or(a.notes, p?.notes ?? undefined),
    };
  },
});

const deleteProjectTool = actionTool({
  name: "delete_project",
  label: "Delete a project",
  description: "Delete a project (its expenses stay, no longer in a project).",
  params: z.object({ projectId: id }),
  needs: "admin",
  items: { projectId: "project" },
  available: () => projectsEnabled(),
  action: (fd) => deleteProject(fd),
  fields: (_ctx, a) => ({ id: a.projectId }),
});

export const SETTINGS_TOOLS = [
  groupSettings,
  bandGroupSettings,
  testConnection,
  invite,
  cancelInviteTool,
  setRole,
  managedBands,
  memberType,
  deleteType,
  removeLogin,
  linkMe,
  saveMyDetailsTool,
  inviteBand,
  cancelBandInvite,
  resetLink,
  unlinkTool,
  saveProjectTool,
  deleteProjectTool,
];
