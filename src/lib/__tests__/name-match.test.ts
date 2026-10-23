import { describe, expect, it } from "vitest";
import { nameScore, normalizeName } from "../name-match";

describe("nameScore", () => {
  it("matches names as people type them", () => {
    expect(normalizeName("The Young Jethros!")).toBe("young jethros");
    expect(nameScore("young jethros", "The Young Jethros")).toBe(100);
    expect(nameScore("flagday", "Flag Day")).toBe(95);
    expect(nameScore("flag", "Flag Day")).toBe(80);
    expect(nameScore("ank", "THE ANK! pts. 1-5")).toBe(80);
    expect(nameScore("jury duty", "Welcome To Jury Duty, Here's Your Lawyer")).toBe(70);
    expect(nameScore("swetums", "Sweetums")).toBeGreaterThan(0);
    expect(nameScore("noah salenger", "Noah Salinger")).toBeGreaterThan(0);
  });

  it("doesn't match unrelated names", () => {
    expect(nameScore("young jethros", "Flag Day")).toBe(0);
    expect(nameScore("cat", "Cactus Mutual Aid")).toBe(0);
    expect(nameScore("", "Flag Day")).toBe(0);
  });

  it("ranks closer names higher", () => {
    expect(nameScore("flag day", "Flag Day")).toBeGreaterThan(nameScore("flag day", "Flags of the World"));
  });
});
