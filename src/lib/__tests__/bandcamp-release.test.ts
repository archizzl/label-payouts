import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artUrl, imageUrl, labelMusicUrl, parseLabelMerch, parseLabelMusic } from "../bandcamp-label";
import { bandcampDateToIso, deriveCatalogNumber, parseReleasePage } from "../bandcamp-release";
import { type Catalog, routeSale } from "../routing";

const fixture = (n: string) => readFileSync(join(__dirname, "../../../test/fixtures", n), "utf8");

describe("label music page", () => {
  it("builds the /music URL", () => {
    expect(labelMusicUrl("tidepool")).toBe("https://tidepool.bandcamp.com/music");
  });

  it("reads rendered items and the JSON list, deduping and resolving relative links", () => {
    const rs = parseLabelMusic(fixture("label-music.html"), "https://tidepool.bandcamp.com/music");
    expect(rs).toEqual([
      {
        bandcampId: 4001,
        kind: "album",
        title: "Night Swims",
        artist: "Glass Harbor",
        url: "https://glassharbor.bandcamp.com/album/night-swims",
        artUrl: "https://f4.bcbits.com/img/a0000004001_2.jpg",
      },
      {
        bandcampId: 4002,
        kind: "album",
        title: 'Split 7" Vol. 1',
        artist: null,
        url: "https://tidepool.bandcamp.com/album/split-7-vol-1",
        artUrl: "https://f4.bcbits.com/img/a0000004002_2.jpg",
      },
      {
        bandcampId: 5001,
        kind: "album",
        title: "Static Bloom",
        artist: "Moth Parade",
        url: "https://tidepool.bandcamp.com/album/static-bloom",
        artUrl: artUrl(123456),
      },
      {
        bandcampId: 9001,
        kind: "track",
        title: "Undertow",
        artist: "Glass Harbor",
        url: "https://glassharbor.bandcamp.com/track/undertow",
        artUrl: "https://f4.bcbits.com/img/a0000000077_2.jpg",
      },
    ]);
  });
});

describe("release page", () => {
  it("parses everything Bandcamp exposes", () => {
    const r = parseReleasePage(fixture("release-album.html"), "https://glassharbor.bandcamp.com/album/night-swims")!;
    expect(r).toMatchObject({
      bandcampId: 4001,
      kind: "album",
      title: "Night Swims",
      artist: "Glass Harbor",
      url: "https://glassharbor.bandcamp.com/album/night-swims",
      releaseDate: "2025-03-05",
      upc: "196000000017",
      catalogNumber: "GH001",
      about: "Recorded in a lighthouse.\n\nMixed at home.",
      credits: "Ada Reyes: vocals\nBen Ortiz: guitar",
      tags: ["dream pop", "shoegaze", "Portland"],
      artUrl: "https://f4.bcbits.com/img/a0000004001_16.jpg",
    });
    expect(r.packages).toEqual([
      { bandcampId: 71, title: "12in Vinyl LP", typeName: "Vinyl LP", sku: "GH001-LP", upc: "196000000024", price: 25, currency: "USD" },
      { bandcampId: 72, title: "Cassette", typeName: "Cassette", sku: "GH001-TAPE", upc: null, price: 10, currency: "USD" },
    ]);
    expect(r.tracks).toEqual([
      { bandcampId: 9001, position: 1, title: "Undertow", durationSec: 202, url: "https://glassharbor.bandcamp.com/track/undertow", artist: null, isrc: null },
      { bandcampId: 9002, position: 2, title: "Salt Lines (feat. Ivy North)", durationSec: 185, url: "https://glassharbor.bandcamp.com/track/salt-lines", artist: "Hollow Pines", isrc: null },
      // same artist as the release → not repeated per track
      { bandcampId: 9003, position: 3, title: "Glass Harbor Theme", durationSec: null, url: null, artist: null, isrc: null },
    ]);
  });

  it("returns null when the page has no release data", () => {
    expect(parseReleasePage("<html></html>", "https://x.bandcamp.com/album/y")).toBeNull();
  });

  it("derives catalog numbers from format SKUs", () => {
    expect(deriveCatalogNumber(["SBR-278-GOLD", "SBR-278-LP", "SBR-278-CD"])).toBe("SBR-278");
    expect(deriveCatalogNumber(["TP012"])).toBe("TP012");
    // a single SKU loses its format suffix
    expect(deriveCatalogNumber(["SBR-3001-LP"])).toBe("SBR-3001");
    expect(deriveCatalogNumber(["TP012CD"])).toBe("TP012");
    expect(deriveCatalogNumber(["ABC-44 7in"])).toBe("ABC-44");
    expect(deriveCatalogNumber(["SBR-LP"])).toBe("SBR-LP"); // no number before the suffix: leave it alone
    expect(deriveCatalogNumber(["SBR-278", "SBR-279"])).toBeNull(); // different releases' numbers
    expect(deriveCatalogNumber(["LP-A", "CD-B"])).toBeNull();
    expect(deriveCatalogNumber([null, ""])).toBeNull();
  });

  it("converts Bandcamp dates", () => {
    expect(bandcampDateToIso("22 Oct 2021 00:00:00 GMT")).toBe("2021-10-22");
    expect(bandcampDateToIso(null)).toBeNull();
  });
});

describe("routing by identifiers", () => {
  const catalog: Catalog = {
    bands: [{ id: 1, name: "Glass Harbor", aliases: [], urlPatterns: [] }],
    releases: [{ id: 10, bandId: 1, title: "Night Swims", url: null, identifiers: ["GH001", "GH001-LP", "196000000017"] }],
    tracks: [{ id: 100, releaseId: 10, bandId: 1, title: "Undertow", url: null, isrc: "US-XXX-26-00001" }],
    overrides: [],
  };
  const base = { itemUrl: "https://label.bandcamp.com/x", artist: "Unknown", itemName: "?", category: "album" as const };

  it("matches catalog numbers, SKUs and UPCs regardless of punctuation", () => {
    expect(routeSale({ ...base, catalogNumber: "gh 001" }, catalog)).toMatchObject({ bandId: 1, releaseId: 10, via: "identifier" });
    expect(routeSale({ ...base, category: "merch", catalogNumber: "GH001-LP" }, catalog)).toMatchObject({ releaseId: 10 });
    expect(routeSale({ ...base, upc: "196000000017" }, catalog)).toMatchObject({ releaseId: 10 });
  });
  it("matches ISRCs to tracks", () => {
    expect(routeSale({ ...base, category: "track", isrc: "USXXX2600001" }, catalog)).toMatchObject({ trackId: 100, via: "identifier" });
  });
  it("finds the track within a release matched by catalog number", () => {
    expect(routeSale({ ...base, category: "track", itemName: "Undertow", catalogNumber: "GH001" }, catalog)).toMatchObject({ releaseId: 10, trackId: 100 });
  });
});

describe("merch", () => {
  it("lists standalone merch from the label's merch page, skipping formats of releases", () => {
    const items = parseLabelMerch(fixture("label-merch.html"), "https://tidepool.bandcamp.com/merch");
    expect(items).toEqual([
      {
        bandcampId: 7001,
        kind: "merch",
        title: "Logo T-Shirt",
        artist: "Glass Harbor",
        url: "https://glassharbor.bandcamp.com/merch/logo-t-shirt",
        artUrl: "https://f4.bcbits.com/img/0000000999_37.jpg",
      },
      {
        bandcampId: 7002,
        kind: "merch",
        title: "Moth Parade Tote Bag",
        artist: "Moth Parade",
        url: "https://mothparade.bandcamp.com/merch/tote-bag",
        artUrl: imageUrl(555),
      },
      {
        bandcampId: 7004,
        kind: "merch",
        title: "Tidepool Logo Hat",
        artist: null,
        url: "https://tidepool.bandcamp.com/merch/logo-hat",
        artUrl: "https://f4.bcbits.com/img/0000000777_2.jpg",
      },
    ]);
  });

  it("reads a merch item page: type, SKU, price, photo and size SKUs", () => {
    const d = parseReleasePage(fixture("merch-item.html"), "https://glassharbor.bandcamp.com/merch/logo-t-shirt")!;
    expect(d).toMatchObject({
      bandcampId: 7001,
      kind: "merch",
      title: "Logo T-Shirt",
      artist: "Glass Harbor",
      url: "https://glassharbor.bandcamp.com/merch/logo-t-shirt",
      releaseDate: "2026-02-02",
      about: "Printed in Portland.",
      artUrl: "https://f4.bcbits.com/img/0000000999_10.jpg",
      tracks: [],
    });
    expect(d.packages).toEqual([
      {
        bandcampId: 7001,
        title: "Logo T-Shirt",
        typeName: "T-Shirt/Shirt",
        sku: "GH-TEE",
        upc: null,
        price: 20,
        currency: "USD",
        options: [
          { title: "Small", sku: "GH-TEE-S" },
          { title: "Large", sku: "GH-TEE-L" },
        ],
      },
    ]);
  });

  it("routes a merch sale by a size's SKU", () => {
    const catalog: Catalog = {
      bands: [{ id: 1, name: "Glass Harbor", aliases: [], urlPatterns: [] }],
      releases: [{ id: 50, bandId: 1, title: "Logo T-Shirt", url: null, identifiers: ["GH-TEE", "GH-TEE-S", "GH-TEE-L"] }],
      tracks: [],
      overrides: [],
    };
    expect(
      routeSale({ itemUrl: "", artist: "", itemName: "Shirt", category: "merch", catalogNumber: "GH-TEE-L" }, catalog),
    ).toMatchObject({ bandId: 1, releaseId: 50, via: "identifier" });
  });
});
