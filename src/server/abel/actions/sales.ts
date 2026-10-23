import "server-only";
import { z } from "zod";
import {
  addBandFromArtist,
  assignArtistToBand,
  assignRouting,
  createReleaseFromSales,
  deleteImport,
  deleteRoutingOverride,
  rerouteAction,
  syncBandcampSales,
  syncWithBandcamp,
} from "../../actions";
import { deleteManualSale } from "../../manual-sale-actions";
import { saleAdder } from "../../manual-sales";
import { actionTool, isAccountAdmin } from "../tool";
import { date, id } from "./shared";

/* Sales: syncing with Bandcamp, matching sales to bands and releases, imports and hand-added sales. */

const deleteSale = actionTool({
  name: "delete_manual_sale",
  label: "Delete a sale added by hand",
  description: "Take back a sale that was added by hand, while it isn't in a payout yet (wholeOrder: every item sold with it).",
  params: z.object({ saleId: id, wholeOrder: z.boolean().optional() }),
  needs: "anyone",
  action: async (fd) => ((await saleAdder()) ? deleteManualSale(null, fd) : { error: "Only a band’s members can change its sales." }),
  fields: (_ctx, a) => ({ id: a.saleId, whole: a.wholeOrder ? "1" : undefined }),
});

const syncSales = actionTool({
  name: "sync_bandcamp_sales",
  label: "Bring in sales from Bandcamp",
  description: "Bring in sales from Bandcamp's API since a date.",
  params: z.object({ from: date }),
  needs: { area: "sales", level: "edit" },
  action: (fd) => syncBandcampSales(null, fd),
});

const syncAll = actionTool({
  name: "sync_with_bandcamp",
  label: "Sync with Bandcamp now",
  description: "Sync artists, releases, merch and sales with Bandcamp now, not waiting for the hourly sync.",
  params: z.object({}),
  needs: "anyone",
  available: (ctx) => isAccountAdmin(ctx) || ctx.lens,
  action: (fd) => syncWithBandcamp(null, fd),
});

const matchSales = actionTool({
  name: "match_sales",
  label: "Match sales",
  description:
    "Say where sales that didn't match belong: every sale with this key (unmatched_sales lists them) goes to a band, release or track, and the choice is remembered.",
  params: z.object({ key: z.string().min(1), to: z.enum(["band", "release", "track"]), toId: id }),
  needs: { area: "sales", level: "edit" },
  action: (fd) => assignRouting(fd),
  fields: (_ctx, a) => ({ key: a.key, target: `${a.to[0]}:${a.toId}` }),
});

const matchArtist = actionTool({
  name: "match_artist_to_band",
  label: "Match an artist's sales to a band",
  description:
    "Every unmatched sale by an artist belongs to one band: give the band and the keys of the artist's unmatched sales (unmatched_sales). The artist's name becomes another spelling of the band, so new sales match too.",
  params: z.object({ artist: z.string().min(1), bandId: id, keys: z.array(z.string().min(1)).min(1) }),
  needs: { area: "sales", level: "edit" },
  action: (fd) => assignArtistToBand(fd),
  fields: (_ctx, a) => ({ artist: a.artist, bandId: a.bandId, key: a.keys }),
});

const bandFromArtist = actionTool({
  name: "add_band_from_artist",
  label: "Add a band from an artist",
  description: "Make an artist whose sales matched no band into a band (subdomain: its Bandcamp address's first part, if it has its own).",
  params: z.object({ artist: z.string().min(1), subdomain: z.string().max(60).optional() }),
  needs: { area: "roster", level: "edit" },
  action: (fd) => addBandFromArtist(fd),
});

const releaseFromSales = actionTool({
  name: "create_release_from_sales",
  label: "Make a release from unmatched sales",
  description: "Make a release (or a single, for a track) from a group of unmatched sales (its key from unmatched_sales), for a band, and match the sales to it.",
  params: z.object({ key: z.string().min(1), bandId: id }),
  needs: { area: "catalog", level: "edit" },
  action: (fd) => createReleaseFromSales(fd),
});

const deleteMatch = actionTool({
  name: "delete_saved_match",
  label: "Forget a saved match",
  description: "Forget a remembered choice of where some sales belong (sales_imports lists them), and match those sales again.",
  params: z.object({ id }),
  needs: { area: "sales", level: "edit" },
  action: (fd) => deleteRoutingOverride(fd),
});

const rematch = actionTool({
  name: "rematch_sales",
  label: "Match every sale again",
  description: "Match every sale to its band and release again, from the catalog and the remembered choices.",
  params: z.object({}),
  needs: { area: "sales", level: "edit" },
  action: () => rerouteAction(),
});

const deleteImportTool = actionTool({
  name: "delete_import",
  label: "Delete an import",
  description: "Delete a sales import and every sale it brought in (sales_imports lists them).",
  params: z.object({ importId: id }),
  needs: { area: "sales", level: "edit" },
  action: (fd) => deleteImport(fd),
  fields: (_ctx, a) => ({ id: a.importId }),
});

export const SALES_TOOLS = [deleteSale, syncSales, syncAll, matchSales, matchArtist, bandFromArtist, releaseFromSales, deleteMatch, rematch, deleteImportTool];
