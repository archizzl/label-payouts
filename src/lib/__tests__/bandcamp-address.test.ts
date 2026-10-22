import { describe, expect, it } from "vitest";
import { bandcampAddressProblem } from "../routing";

describe("checking a Bandcamp address", () => {
  it("takes Bandcamp pages, custom domains and blanks", () => {
    for (const ok of ["flagday.bandcamp.com", "https://reactionfuture.bandcamp.com/music", "music.somelabel.com", "", "  ", null, undefined]) {
      expect(bandcampAddressProblem(ok)).toBeNull();
    }
  });

  it("turns away email addresses, bandcamp.com itself, other sites and things that aren't addresses", () => {
    expect(bandcampAddressProblem("someone@gmail.com")).toMatch(/email address/);
    expect(bandcampAddressProblem("gmail.com")).toBe("gmail.com isn’t a Bandcamp page.");
    expect(bandcampAddressProblem("https://open.spotify.com/artist/x")).toBe("open.spotify.com isn’t a Bandcamp page.");
    expect(bandcampAddressProblem("www.instagram.com/flagday")).toBe("instagram.com isn’t a Bandcamp page.");
    expect(bandcampAddressProblem("bandcamp.com")).toMatch(/your own page/);
    expect(bandcampAddressProblem("flag day")).toBe("That Bandcamp address doesn’t look right.");
  });
});
