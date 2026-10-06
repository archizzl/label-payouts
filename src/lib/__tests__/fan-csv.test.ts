import { describe, expect, it } from "vitest";
import { parseFanCsv } from "../fan-csv";

describe("Bandcamp mailing-list files", () => {
  it("reads the usual columns, by name, in any order", () => {
    const csv = "email,fullname,date added,country,postal code,num purchases\nA@Example.com,Ann Lee,1/15/24 3:05pm,United States,11211,2\nbob@example.com,,2024-03-02,Canada,,0\n";
    const r = parseFanCsv(csv);
    expect(r.error).toBeUndefined();
    expect(r.fans).toEqual([
      { email: "a@example.com", name: "Ann Lee", country: "United States", postalCode: "11211", addedOn: "2024-01-15", sources: [], extra: { "num purchases": "2" } },
      { email: "bob@example.com", name: null, country: "Canada", postalCode: null, addedOn: "2024-03-02", sources: [], extra: { "num purchases": "0" } },
    ]);
  });

  it("handles UTF-16 files, first/last names, and an artist column", () => {
    const text = "Email Address\tFirst Name\tLast Name\tArtist\nann@example.com\tAnn\tLee\tFlag Day\n";
    const bytes = new Uint8Array([0xff, 0xfe, ...[...text].flatMap((c) => [c.charCodeAt(0), 0])]);
    const r = parseFanCsv(bytes);
    expect(r.fans[0]).toMatchObject({ email: "ann@example.com", name: "Ann Lee", sources: ["Flag Day"] });
  });

  it("merges repeats, keeping the earliest sign-up and every artist, and skips rows without a valid email", () => {
    const csv = "email,artist,date added\nann@example.com,Flag Day,2024-05-01\nANN@example.com,Sweetums,2023-01-01\nnot-an-email,Flag Day,2024-01-01\n,,\n";
    const r = parseFanCsv(csv);
    expect(r.fans).toHaveLength(1);
    expect(r.fans[0]).toMatchObject({ addedOn: "2023-01-01", sources: ["Flag Day", "Sweetums"] });
    expect(r.repeats).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("accepts a bare list of emails, and explains a file with no email column", () => {
    expect(parseFanCsv("ann@example.com\nbob@example.com\n").fans.map((f) => f.email)).toEqual(["ann@example.com", "bob@example.com"]);
    expect(parseFanCsv("name,country\nAnn,US\n").error).toMatch(/email column/);
  });
});
