import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { labelArtistsUrl, parseBandPhoto, parseLabelArtists, parseLabelName } from "../bandcamp-label";

const html = readFileSync(join(__dirname, "../../../test/fixtures/label-artists.html"), "utf8");

describe("bandcamp label page", () => {
  it("normalizes what people type into an artists-page URL", () => {
    expect(labelArtistsUrl("tidepool")).toBe("https://tidepool.bandcamp.com/artists");
    expect(labelArtistsUrl("tidepool.bandcamp.com")).toBe("https://tidepool.bandcamp.com/artists");
    expect(labelArtistsUrl("https://Tidepool.bandcamp.com/music?x=1")).toBe("https://tidepool.bandcamp.com/artists");
    expect(labelArtistsUrl("http://records.example.com")).toBe("https://records.example.com/artists");
    expect(labelArtistsUrl("")).toBeNull();
    expect(labelArtistsUrl("not a url at all")).toBeNull();
  });

  it("parses artists, decodes entities, handles custom domains and dedupes", () => {
    expect(parseLabelArtists(html)).toEqual([
      { name: "Glass Harbor", url: "https://glassharbor.bandcamp.com", urlPattern: "glassharbor", location: "Portland, Oregon", imageUrl: "https://f4.bcbits.com/img/1_36.jpg" },
      { name: "Moth Parade & Friends", url: "https://mothparade.bandcamp.com", urlPattern: "mothparade", location: null, imageUrl: null },
      { name: "The Quiet Engines", url: "https://music.quietengines.com", urlPattern: "music.quietengines.com", location: "Montréal, Québec", imageUrl: "x.jpg" },
    ]);
  });

  it("reads the label name", () => {
    expect(parseLabelName(html)).toBe("Tidepool Records");
  });

  it("returns nothing for a page without an artist grid", () => {
    expect(parseLabelArtists("<html><body>an artist page</body></html>")).toEqual([]);
  });
});

describe("parseBandPhoto", () => {
  it("reads the profile photo from the bio sidebar, in the artist-grid crop", () => {
    const html = `<div id="bio-container"><a class="popupImage" href="https://f4.bcbits.com/img/0047556316_10.jpg">
      <img src="https://f4.bcbits.com/img/0047556316_21.jpg" class="band-photo" alt="Reaction Future Records image"></a></div>`;
    expect(parseBandPhoto(html)).toBe("https://f4.bcbits.com/img/0047556316_36.jpg");
  });

  it("returns null when the account has no photo", () => {
    expect(parseBandPhoto("<div id='bio-container'></div>")).toBeNull();
  });
});
