/*
 * What Abel's chat panel shows, and what the chat route streams to it (src/app/api/abel/route.ts).
 */

/** One thing in a chat: a message, or a change waiting for (or given) the person's answer. */
export type AbelMessage =
  | { kind: "user"; text: string }
  | { kind: "abel"; text: string }
  | { kind: "confirm"; id: string; summary: string; answer: "confirmed" | "declined" | null };

export type AbelChatListItem = { id: number; title: string; updatedAt: string };

/** One line of the chat route's event stream. */
export type AbelStreamEvent =
  | { type: "chat"; chatId: number }
  /** Text from Abel: a piece of the reply (partial), or the whole of it. */
  | { type: "text"; text: string; partial: boolean }
  /** Abel is looking something up or making a change (a tool's name). */
  | { type: "working"; tool: string }
  | { type: "confirm"; id: string; summary: string }
  | { type: "error"; message: string }
  | { type: "done" };

/** What a tool is doing, for the line under Abel's reply while it works. */
export const WORKING_ON: Record<string, string> = {
  my_access: "Checking your access",
  my_earnings: "Looking at your earnings",
  where_is: "Finding the page",
  owed_by_band: "Looking at what's owed",
  list_payouts: "Looking at payouts",
  payout_detail: "Looking at the payout",
  sales_summary: "Looking at sales",
  sales_report: "Looking at sales",
  label_funds: "Looking at label funds",
  list_bands: "Looking at bands",
  list_people: "Looking at people",
  catalog: "Looking at the catalog",
  open_orders: "Looking at orders",
  inventory: "Looking at inventory",
  receipts: "Looking at receipts",
  splits: "Looking at splits",
};
