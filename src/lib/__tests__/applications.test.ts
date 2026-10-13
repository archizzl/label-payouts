import { describe, expect, it } from "vitest";
import { bandcampSubdomain, normalizeUrl, readApplication } from "../applications";

const base = { kind: "band", name: "Flag Day", bandcampUrl: "", website: "", about: "", memberName: [], memberRole: [], memberEmail: [], artistName: [], artistUrl: [], teamName: [], teamEmail: [] };

describe("reading an account application", () => {
  it("needs a kind and a name", () => {
    expect(readApplication({ ...base, kind: "" })).toEqual({ ok: false, error: "Choose whether it's a label or a band." });
    expect(readApplication({ ...base, name: " " })).toMatchObject({ ok: false });
  });

  it("tidies addresses and a band's members, dropping empty rows", () => {
    const r = readApplication({
      ...base,
      bandcampUrl: "flagday.bandcamp.com",
      memberName: ["Ada", "", "Bea"],
      memberRole: ["drums", "", ""],
      memberEmail: ["ADA@example.com", "", ""],
    });
    expect(r).toMatchObject({
      ok: true,
      value: { bandcampUrl: "https://flagday.bandcamp.com", members: [{ name: "Ada", role: "drums", email: "ada@example.com" }, { name: "Bea", role: null, email: null }], artists: [], team: [] },
    });
  });

  it("checks emails and addresses", () => {
    expect(readApplication({ ...base, memberName: ["Ada"], memberRole: [""], memberEmail: ["nope"] })).toEqual({ ok: false, error: "Ada's email doesn't look right." });
    expect(readApplication({ ...base, bandcampUrl: "not a url" })).toMatchObject({ ok: false });
    expect(readApplication({ ...base, kind: "label", teamName: ["Max"], teamEmail: [""] })).toMatchObject({ ok: false });
  });

  it("keeps a label's artists and team, not band members", () => {
    const r = readApplication({ ...base, kind: "label", name: "RFR", memberName: ["x"], memberRole: [""], memberEmail: [""], artistName: ["Sweetums", "Flag Day"], artistUrl: ["sweetumsofthebody.bandcamp.com", ""], teamName: [""], teamEmail: ["max@example.com"] });
    expect(r).toMatchObject({
      ok: true,
      value: { members: [], artists: [{ name: "Sweetums", bandcampUrl: "https://sweetumsofthebody.bandcamp.com" }, { name: "Flag Day", bandcampUrl: null }], team: [{ name: "max@example.com", email: "max@example.com" }] },
    });
  });

  it("reads Bandcamp subdomains", () => {
    expect(bandcampSubdomain("https://FlagDay.bandcamp.com/album/x")).toBe("flagday");
    expect(bandcampSubdomain("https://example.com")).toBeNull();
    expect(normalizeUrl("localhost")).toBeNull();
  });
});
