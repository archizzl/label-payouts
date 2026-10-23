import "server-only";
import { z } from "zod";
import { schema } from "@/db";
import { SALE_PARTS } from "@/lib/sale-parts";
import { deleteDeduction, deleteSplitRule, saveDeduction, saveItemCost, saveSplitRule, setLabelKeepsNothing } from "../../actions";
import { nameMaps } from "../../data";
import { actionTool } from "../tool";
import { amount, current, currency, date, id, or, toAmount } from "./shared";

/* Rules: deductions (what's withheld from sales, and where it goes), splits and item costs. */

const category = z.enum(["album", "track", "merch", "other"]);
const salePart = z.enum(SALE_PARTS.map((p) => p.key) as [string, ...string[]]);

const saveDeductionTool = actionTool({
  name: "save_deduction",
  label: "Save a deduction",
  description: `Add a deduction (something withheld from sales before the split), or change one (give its id; only the fields given change). Use list_deductions to see them.
kind: percent (a percent of each sale), fixed (a cost recouped from sales until it's paid off), per_unit (an amount for each item sold), sale_part (a part of each sale: ${SALE_PARTS.map((p) => `${p.key} is ${p.label.toLowerCase()}`).join("; ")}).
destination: label (the label keeps it), band_fund (the band's fund), expense (pays a cost), person (paid to someone: personId).
Limit it to a band, release, track or item type, and to dates, if asked.`,
  params: z.object({
    id: id.optional().describe("The deduction to change; leave out to add one"),
    label: z.string().max(120).optional().describe("Its name, like Label cut"),
    kind: z.enum(["percent", "fixed", "per_unit", "sale_part"]).optional(),
    percent: z.number().min(0).max(100).optional().describe("For percent"),
    amount: amount.optional().describe("For fixed and per_unit"),
    currency: currency.optional(),
    salePart: salePart.optional().describe("For sale_part"),
    destination: z.enum(["label", "band_fund", "expense", "person"]).optional(),
    personId: id.optional().describe("For destination person"),
    bandId: id.optional(),
    releaseId: id.optional(),
    trackId: id.optional(),
    itemCategory: category.optional(),
    effectiveFrom: date.optional(),
    effectiveTo: date.optional(),
  }),
  needs: { area: "rules", level: "edit" },
  action: (fd) => saveDeduction(fd),
  fields: async (ctx, a) => {
    const d = a.id ? await current(schema.deductions, ctx.orgId, a.id, "deduction") : null;
    return {
      id: a.id,
      label: or(a.label, d?.label),
      kind: or(a.kind, d?.kind ?? "percent"),
      percent: or(a.percent, d?.percentBps != null ? d.percentBps / 100 : undefined),
      amount: or(a.amount, toAmount(d?.amountCents)),
      currency: or(a.currency, d?.currency ?? undefined),
      salePart: or(a.salePart, d?.salePart ?? undefined),
      destination: or(a.destination, d?.destination ?? "label"),
      personId: or(a.personId, d?.personId ?? undefined),
      bandId: or(a.bandId, d?.bandId ?? undefined),
      releaseId: or(a.releaseId, d?.releaseId ?? undefined),
      trackId: or(a.trackId, d?.trackId ?? undefined),
      formatKey: d?.packageId && a.releaseId === undefined ? `${d.releaseId}:${d.packageId}` : undefined,
      itemCategory: or(a.itemCategory, d?.itemCategory ?? undefined),
      formatMatch: d?.formatMatch ?? undefined,
      effectiveFrom: or(a.effectiveFrom, d?.effectiveFrom ?? undefined),
      effectiveTo: or(a.effectiveTo, d?.effectiveTo ?? undefined),
      sortOrder: d?.sortOrder,
    };
  },
  done: "Deduction saved.",
});

const deleteDeductionTool = actionTool({
  name: "delete_deduction",
  label: "Delete a deduction",
  description: "Delete a deduction (list_deductions has their ids).",
  params: z.object({ id }),
  needs: { area: "rules", level: "edit" },
  action: (fd) => deleteDeduction(fd),
  done: "Deduction deleted.",
});

const saveSplit = actionTool({
  name: "save_split",
  label: "Save a split",
  description: `Set how money is split between people: each person's share in percent, adding up to 100 (the label default's shares are carve-outs and may add up to less). Use list_people for ids and splits to see the current ones.
scope: band_default (all of a band's sales), band_item_type (a band's albums, tracks, merch or other: itemCategory), release, track, label_default (every band). Give ruleId to change an existing split; from is when it starts.`,
  params: z.object({
    scope: z.enum(["label_default", "band_default", "band_item_type", "release", "track"]),
    bandId: id.optional(),
    releaseId: id.optional(),
    trackId: id.optional(),
    itemCategory: category.optional(),
    shares: z.array(z.object({ personId: id, percent: z.number().min(0.01).max(100) })),
    from: date.optional(),
    ruleId: id.optional(),
    note: z.string().max(200).optional(),
  }),
  needs: { area: "rules", level: "edit" },
  action: (fd) => saveSplitRule(null, fd),
  fields: (_ctx, a) => ({
    scope: a.scope,
    bandId: a.bandId,
    releaseId: a.releaseId,
    trackId: a.trackId,
    itemCategory: a.itemCategory,
    shares: JSON.stringify(a.shares.map((s) => ({ personId: s.personId, bps: Math.round(s.percent * 100) }))),
    effectiveFrom: a.from,
    ruleId: a.ruleId,
    note: a.note,
  }),
  summary: async (ctx, a) => {
    const names = await nameMaps(ctx.orgId);
    const what = a.bandId ? `${names.band.get(a.bandId) ?? `band #${a.bandId}`}’s` : a.scope === "label_default" ? "the label’s default" : "the";
    const shares = a.shares.map((s) => `${names.person.get(s.personId) ?? `person #${s.personId}`} ${s.percent}%`).join(", ");
    const item = a.releaseId ? ` for ${names.release.get(a.releaseId) ?? `release #${a.releaseId}`}` : a.trackId ? ` for ${names.track.get(a.trackId) ?? `track #${a.trackId}`}` : a.itemCategory ? ` for ${a.itemCategory}` : "";
    return `Set ${what} split${item}: ${shares}${a.from ? `, from ${a.from}` : ""}`;
  },
  done: "Split saved.",
});

const deleteSplit = actionTool({
  name: "delete_split",
  label: "Delete a split",
  description: "Delete a split (splits has their ids).",
  params: z.object({ ruleId: id }),
  needs: { area: "rules", level: "edit" },
  action: (fd) => deleteSplitRule(fd),
  done: "Split deleted.",
});

const saveItemCostTool = actionTool({
  name: "save_item_cost",
  label: "Add an item cost",
  description:
    "Add a cost for each copy of a release's merch or format sold (a per-item deduction), withheld or paid to a person who made it. packageId picks one format of the release.",
  params: z.object({ releaseId: id, packageId: id.optional(), amount, currency: currency.optional(), payToPersonId: id.optional().describe("Leave out to withhold it") }),
  needs: { area: "rules", level: "edit" },
  action: (fd) => saveItemCost(fd),
  fields: (_ctx, a) => ({ releaseId: a.releaseId, packageId: a.packageId, amount: a.amount, currency: a.currency, payTo: a.payToPersonId ?? "withheld" }),
  done: "Item cost added.",
});

const keepsNothing = actionTool({
  name: "set_label_keeps_nothing",
  label: "Set whether the label keeps nothing from sales",
  description: "Say the label keeps nothing from sales (keepsNothing true), or undo that.",
  params: z.object({ keepsNothing: z.boolean() }),
  needs: { area: "rules", level: "edit" },
  action: (fd) => setLabelKeepsNothing(fd),
  fields: (_ctx, a) => ({ value: a.keepsNothing ? "1" : "0" }),
});

export const RULES_TOOLS = [saveDeductionTool, deleteDeductionTool, saveSplit, deleteSplit, saveItemCostTool, keepsNothing];
