import "server-only";
import { z } from "zod";
import { schema } from "@/db";
import {
  addMember,
  clearOutsideArtistContact,
  deleteBand,
  deletePerson,
  mergePeopleAction,
  removeMember,
  saveBand,
  saveOutsideArtistContact,
  savePerson,
  setOutsideArtistDismissed,
  updateMembership,
} from "../../actions";
import { actionTool } from "../tool";
import { current, id, or } from "./shared";

/* Bands, people (payees) and who plays in which band. */

const words = z.array(z.string().min(1).max(200));

const saveBandTool = actionTool({
  name: "save_band",
  label: "Save a band",
  description:
    "Add a band, or change one (give its id; only the fields given change). otherNames: other spellings its sales may use; bandcampAddresses: the first part of its Bandcamp addresses, to match sales by.",
  params: z.object({
    id: id.optional(),
    name: z.string().min(1).max(200).optional(),
    otherNames: words.optional(),
    bandcampAddresses: words.optional(),
    notes: z.string().max(1000).optional(),
  }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => saveBand(fd),
  fields: async (ctx, a) => {
    const b = a.id ? await current(schema.bands, ctx.orgId, a.id, "band") : null;
    return {
      id: a.id,
      name: or(a.name, b?.name),
      aliases: or(a.otherNames, b?.aliases ?? []).join(","),
      urlPatterns: or(a.bandcampAddresses, b?.urlPatterns ?? []).join(","),
      notes: or(a.notes, b?.notes ?? undefined),
    };
  },
  done: "Band saved.",
});

const deleteBandTool = actionTool({
  name: "delete_band",
  label: "Delete a band",
  description: "Delete a band (not one with payouts of its own).",
  params: z.object({ bandId: id }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => deleteBand(fd),
  fields: (_ctx, a) => ({ id: a.bandId }),
  done: "Band deleted.",
});

const savePersonTool = actionTool({
  name: "save_person",
  label: "Save a person",
  description:
    "Add a person who gets paid (with the bands they're in, for someone new), or change one's details (give their id; only the fields given change). venmo is a username, cashtag a Cash App $cashtag.",
  params: z.object({
    id: id.optional(),
    name: z.string().min(1).max(120).optional(),
    email: z.string().max(200).optional(),
    paypalMe: z.string().max(200).optional(),
    venmo: z.string().max(100).optional(),
    cashtag: z.string().max(100).optional(),
    notes: z.string().max(1000).optional(),
    bandIds: z.array(id).optional().describe("For someone new: the bands they're in"),
  }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => savePerson(fd),
  fields: async (ctx, a) => {
    const p = a.id ? await current(schema.people, ctx.orgId, a.id, "person") : null;
    return {
      id: a.id,
      name: or(a.name, p?.name),
      email: or(a.email, p?.email ?? undefined),
      paypalMe: or(a.paypalMe, p?.paypalMe ?? undefined),
      venmo: or(a.venmo, p?.venmo ?? undefined),
      cashtag: or(a.cashtag, p?.cashtag ?? undefined),
      notes: or(a.notes, p?.notes ?? undefined),
      bandIds: a.id ? undefined : a.bandIds,
    };
  },
  done: "Saved.",
});

const mergePeople = actionTool({
  name: "merge_people",
  label: "Merge people",
  description: "Merge duplicate people into one (intoId keeps their details; the others' payouts, splits and memberships move to them).",
  params: z.object({ intoId: id, fromIds: z.array(id).min(1) }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => mergePeopleAction(fd),
  fields: (_ctx, a) => ({ intoId: a.intoId, fromId: a.fromIds }),
  done: "Merged.",
});

const deletePersonTool = actionTool({
  name: "delete_person",
  label: "Delete a person",
  description: "Delete a person (not one with payout history or a deduction paid to them).",
  params: z.object({ personId: id }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => deletePerson(null, fd),
  fields: (_ctx, a) => ({ id: a.personId }),
});

const addMemberTool = actionTool({
  name: "add_band_member",
  label: "Add someone to a band",
  description: "Add a person to a band: an existing person (personId), or someone new (name, and email and paypalMe if known).",
  params: z.object({
    bandId: id,
    personId: id.optional(),
    name: z.string().max(120).optional(),
    email: z.string().max(200).optional(),
    paypalMe: z.string().max(200).optional(),
    roles: words.optional().describe("Like guitar, vocals"),
  }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => addMember(fd),
  fields: (_ctx, a) => ({ ...a, roles: a.roles?.join(",") }),
  done: "Added.",
});

const updateMember = actionTool({
  name: "update_band_member",
  label: "Change a band member",
  description: "Change someone's roles in a band, or mark them a former member (active false). list_bands with members gives membership ids.",
  params: z.object({ membershipId: id, roles: words.optional(), active: z.boolean().optional() }),
  needs: { area: "roster", level: "edit" },
  items: { membershipId: "band membership" },
  action: (fd) => updateMembership(fd),
  fields: async (ctx, a) => {
    const m = await current(schema.bandMemberships, ctx.orgId, a.membershipId, "band membership");
    return { membershipId: a.membershipId, roles: or(a.roles, m.roles).join(","), active: or(a.active, m.active) };
  },
  done: "Saved.",
});

const removeMemberTool = actionTool({
  name: "remove_band_member",
  label: "Take someone off a band",
  description: "Take someone off a band entirely (to keep them as a former member, use update_band_member with active false).",
  params: z.object({ membershipId: id }),
  needs: { area: "roster", level: "edit" },
  items: { membershipId: "band membership" },
  action: (fd) => removeMember(fd),
});

const outsideContact = actionTool({
  name: "save_outside_artist_contact",
  label: "Set who to pay for an outside artist",
  description: "For an artist who isn't on the label (outside_artists): who to pay for their tracks, by name and email.",
  params: z.object({ artistId: id, name: z.string().min(1).max(120), email: z.string().max(200).optional() }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => saveOutsideArtistContact(fd),
});

const outsideClear = actionTool({
  name: "clear_outside_artist_contact",
  label: "Clear who to pay for an outside artist",
  description: "Clear who to pay for an outside artist's tracks.",
  params: z.object({ artistId: id }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => clearOutsideArtistContact(fd),
});

const outsideDismiss = actionTool({
  name: "dismiss_outside_artist",
  label: "Hide or show an outside artist",
  description: "Hide an outside artist from the list of who needs a contact (dismissed true), or show them again.",
  params: z.object({ artistId: id, dismissed: z.boolean() }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => setOutsideArtistDismissed(fd),
});

export const ROSTER_TOOLS = [
  saveBandTool,
  deleteBandTool,
  savePersonTool,
  mergePeople,
  deletePersonTool,
  addMemberTool,
  updateMember,
  removeMemberTool,
  outsideContact,
  outsideClear,
  outsideDismiss,
];
