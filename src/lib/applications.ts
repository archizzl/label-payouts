/*
 * Applications for a new label or band account: checking what someone filled in. Plain logic, so
 * it can be tested on its own.
 */

import { bandcampAddressProblem } from "./routing";

export type ApplicationInput = {
  kind: "label" | "band";
  name: string;
  bandcampUrl: string | null;
  website: string | null;
  about: string | null;
  members: { name: string; role: string | null; email: string | null }[];
  artists: { name: string; bandcampUrl: string | null }[];
  team: { name: string; email: string }[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (s: unknown, max = 200) => (typeof s === "string" ? s.trim().slice(0, max) : "");

/** A web address with https:// added if it was left off; null if it isn't one. */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.includes(".") ? u.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

/** "flagday" from https://flagday.bandcamp.com/…, for matching sales to a band. */
export function bandcampSubdomain(url: string | null): string | null {
  const m = url?.match(/^https?:\/\/([a-z0-9-]+)\.bandcamp\.com/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Check and tidy an application. Rows of the repeating lists are read in step (name[i], role[i],
 * email[i]); empty rows are dropped.
 */
export function readApplication(f: {
  kind: string;
  name: string;
  bandcampUrl: string;
  website: string;
  about: string;
  memberName: string[];
  memberRole: string[];
  memberEmail: string[];
  artistName: string[];
  artistUrl: string[];
  teamName: string[];
  teamEmail: string[];
}): { ok: true; value: ApplicationInput } | { ok: false; error: string } {
  const kind = f.kind === "band" ? "band" : f.kind === "label" ? "label" : null;
  if (!kind) return { ok: false, error: "Choose whether it's a label or a band." };
  const name = clean(f.name, 120);
  if (!name) return { ok: false, error: `Give your ${kind}'s name.` };
  const bandcampUrl = f.bandcampUrl.trim() ? normalizeUrl(f.bandcampUrl) : null;
  const problem = bandcampAddressProblem(f.bandcampUrl);
  if (problem) return { ok: false, error: problem };
  if (f.bandcampUrl.trim() && !bandcampUrl) return { ok: false, error: "That Bandcamp address doesn't look right." };
  const website = f.website.trim() ? normalizeUrl(f.website) : null;
  if (f.website.trim() && !website) return { ok: false, error: "That website address doesn't look right." };

  const members = f.memberName
    .map((n, i) => ({ name: clean(n, 120), role: clean(f.memberRole[i], 80) || null, email: clean(f.memberEmail[i], 200).toLowerCase() || null }))
    .filter((m) => m.name);
  const badMember = members.find((m) => m.email && !EMAIL.test(m.email));
  if (badMember) return { ok: false, error: `${badMember.name}'s email doesn't look right.` };

  const artists = f.artistName.map((n, i) => ({ name: clean(n, 120), url: f.artistUrl[i] ?? "" })).filter((a) => a.name);
  const artistsOut: ApplicationInput["artists"] = [];
  for (const a of artists) {
    const url = a.url.trim() ? normalizeUrl(a.url) : null;
    if ((a.url.trim() && !url) || bandcampAddressProblem(a.url)) return { ok: false, error: `${a.name}'s Bandcamp address doesn't look right.` };
    artistsOut.push({ name: a.name, bandcampUrl: url });
  }

  const team = f.teamName
    .map((n, i) => ({ name: clean(n, 120), email: clean(f.teamEmail[i], 200).toLowerCase() }))
    .filter((t) => t.name || t.email);
  const badTeam = team.find((t) => !EMAIL.test(t.email));
  if (badTeam) return { ok: false, error: `Add a valid email for ${badTeam.name || "each team member"}.` };

  return {
    ok: true,
    value: {
      kind,
      name,
      bandcampUrl,
      website,
      about: clean(f.about, 2000) || null,
      members: kind === "band" ? members.slice(0, 20) : [],
      artists: kind === "label" ? artistsOut.slice(0, 100) : [],
      team: kind === "label" ? team.map((t) => ({ name: t.name || t.email, email: t.email })).slice(0, 20) : [],
    },
  };
}
