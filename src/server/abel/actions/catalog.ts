import "server-only";
import { z } from "zod";
import { schema } from "@/db";
import { addTracks, deleteRelease, deleteTrack, refreshReleaseFromBandcamp, saveRelease, saveTrack } from "../../actions";
import { actionTool } from "../tool";
import { current, date, id, or } from "./shared";

/* The catalog: releases (albums, singles, merch) and their tracks. */

const saveReleaseTool = actionTool({
  name: "save_release",
  label: "Save a release",
  description:
    "Add a release for a band, or change one (give its id; only the fields given change). albumSplitMode: band_default (album sales split like the band's), or average_tracks (by its tracks' splits).",
  params: z.object({
    id: id.optional(),
    bandId: id.optional(),
    title: z.string().min(1).max(200).optional(),
    url: z.string().max(300).optional().describe("Its Bandcamp address"),
    catalogNumber: z.string().max(60).optional(),
    releaseDate: date.optional(),
    albumSplitMode: z.enum(["band_default", "average_tracks"]).optional(),
  }),
  needs: { area: "catalog", level: "edit" },
  action: (fd) => saveRelease(fd),
  fields: async (ctx, a) => {
    const r = a.id ? await current(schema.releases, ctx.orgId, a.id, "release") : null;
    return {
      id: a.id,
      bandId: or(a.bandId, r?.bandId),
      title: or(a.title, r?.title),
      url: or(a.url, r?.url ?? undefined),
      catalogNumber: or(a.catalogNumber, r?.catalogNumber ?? undefined),
      releaseDate: or(a.releaseDate, r?.releaseDate ?? undefined),
      albumSplitMode: or(a.albumSplitMode, r?.albumSplitMode ?? "band_default"),
    };
  },
  done: "Release saved.",
});

const deleteReleaseTool = actionTool({
  name: "delete_release",
  label: "Delete a release",
  description: "Delete a release and its tracks.",
  params: z.object({ releaseId: id }),
  needs: { area: "catalog", level: "edit" },
  action: (fd) => deleteRelease(fd),
  fields: (_ctx, a) => ({ id: a.releaseId }),
  done: "Release deleted.",
});

const addTracksTool = actionTool({
  name: "add_tracks",
  label: "Add tracks",
  description: "Add tracks to a release, in order, after any it has.",
  params: z.object({ releaseId: id, titles: z.array(z.string().min(1).max(200)).min(1) }),
  needs: { area: "catalog", level: "edit" },
  action: (fd) => addTracks(fd),
  fields: (_ctx, a) => ({ releaseId: a.releaseId, titles: a.titles.map((t) => t.replace(/\|/g, "/")).join("\n") }),
  done: "Tracks added.",
});

const saveTrackTool = actionTool({
  name: "save_track",
  label: "Change a track",
  description: "Change a track (only the fields given change). bandId: when the track is by another of the label's bands than its release. labelKeeps: the label keeps this track's money.",
  params: z.object({
    trackId: id,
    title: z.string().min(1).max(200).optional(),
    url: z.string().max(300).optional(),
    isrc: z.string().max(20).optional(),
    bandId: id.optional(),
    position: z.number().int().min(0).optional(),
    labelKeeps: z.boolean().optional(),
  }),
  needs: { area: "catalog", level: "edit" },
  action: (fd) => saveTrack(fd),
  fields: async (ctx, a) => {
    const t = await current(schema.tracks, ctx.orgId, a.trackId, "track");
    return {
      id: a.trackId,
      title: or(a.title, t.title),
      url: or(a.url, t.url ?? undefined),
      isrc: or(a.isrc, t.isrc ?? undefined),
      bandId: or(a.bandId, t.bandId ?? undefined),
      position: or(a.position, t.position),
      labelKeeps: or(a.labelKeeps, t.labelKeeps),
    };
  },
  done: "Track saved.",
});

const deleteTrackTool = actionTool({
  name: "delete_track",
  label: "Delete a track",
  description: "Delete a track from its release.",
  params: z.object({ trackId: id }),
  needs: { area: "catalog", level: "edit" },
  action: (fd) => deleteTrack(fd),
  fields: (_ctx, a) => ({ id: a.trackId }),
  done: "Track deleted.",
});

const refreshRelease = actionTool({
  name: "refresh_release_from_bandcamp",
  label: "Read a release from Bandcamp again",
  description: "Read a release's details (tracks, formats, artwork) from its Bandcamp page again.",
  params: z.object({ releaseId: id }),
  needs: { area: "catalog", level: "edit" },
  action: (fd) => refreshReleaseFromBandcamp(null, fd),
  fields: (_ctx, a) => ({ id: a.releaseId }),
});

export const CATALOG_TOOLS = [saveReleaseTool, deleteReleaseTool, addTracksTool, saveTrackTool, deleteTrackTool, refreshRelease];
