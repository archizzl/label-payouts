import { randomBytes } from "node:crypto";

/** An account's address-safe id from its name, made unique: "flag-day-3f9a1c". */
export function slugify(name: string) {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "account"}-${randomBytes(3).toString("hex")}`;
}
