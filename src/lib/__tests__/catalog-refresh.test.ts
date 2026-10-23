import { describe, expect, it } from "vitest";
import { bandcampImageKey, releasesToRefresh } from "../catalog-refresh";

const week = "2026-10-16T00:00:00.000Z";
const recent = "2026-10-22T00:00:00.000Z";
const old = "2026-09-01T00:00:00.000Z";

describe("bandcampImageKey", () => {
  it("is the same for any size of the same image", () => {
    expect(bandcampImageKey("https://f4.bcbits.com/img/a3355688526_16.jpg")).toBe("a3355688526");
    expect(bandcampImageKey("https://f4.bcbits.com/img/a3355688526_2.jpg")).toBe("a3355688526");
    expect(bandcampImageKey("https://f4.bcbits.com/img/a0005162384_2.jpg")).toBe(bandcampImageKey("https://f4.bcbits.com/img/a5162384_16.jpg"));
    expect(bandcampImageKey("https://f4.bcbits.com/img/0035612345_10.jpg")).toBe("35612345");
    expect(bandcampImageKey("/merch-photos/12")).toBeNull();
    expect(bandcampImageKey(null)).toBeNull();
  });
});

describe("releasesToRefresh", () => {
  it("reads again a release whose cover changed, however recently it was read", () => {
    const stored = new Map([
      [1, { syncedAt: recent, artUrl: "https://f4.bcbits.com/img/a111_16.jpg" }],
      [2, { syncedAt: recent, artUrl: "https://f4.bcbits.com/img/a222_16.jpg" }],
    ]);
    const listed = [
      { releaseId: 1, status: "imported" as const, artUrl: "https://f4.bcbits.com/img/a999_2.jpg" },
      { releaseId: 2, status: "imported" as const, artUrl: "https://f4.bcbits.com/img/a222_2.jpg" },
    ];
    expect(releasesToRefresh(listed, stored, week)).toEqual([1]);
  });

  it("reads the oldest of the rest once they're a week old, up to the limit", () => {
    const stored = new Map([
      [1, { syncedAt: old, artUrl: null }],
      [2, { syncedAt: "2026-08-01T00:00:00.000Z", artUrl: null }],
      [3, { syncedAt: recent, artUrl: null }],
    ]);
    const listed = [1, 2, 3].map((releaseId) => ({ releaseId, status: "imported" as const, artUrl: null }));
    expect(releasesToRefresh(listed, stored, week)).toEqual([2, 1]);
    expect(releasesToRefresh(listed, stored, week, 1)).toEqual([2]);
  });

  it("doesn't count an uploaded photo, or no cover listed, as a change", () => {
    const stored = new Map([[1, { syncedAt: recent, artUrl: "/merch-photos/4" }]]);
    expect(releasesToRefresh([{ releaseId: 1, status: "imported", artUrl: "https://f4.bcbits.com/img/a5_2.jpg" }], stored, week)).toEqual([]);
    const stored2 = new Map([[1, { syncedAt: recent, artUrl: "https://f4.bcbits.com/img/a5_16.jpg" }]]);
    expect(releasesToRefresh([{ releaseId: 1, status: "imported", artUrl: null }], stored2, week)).toEqual([]);
  });
});
