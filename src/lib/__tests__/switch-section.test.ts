import { describe, expect, it } from "vitest";
import { sectionAfterSwitch } from "../switch-section";

describe("where switching groups lands", () => {
  it("stays in the section, not on one group's own pages", () => {
    expect(sectionAfterSwitch("/sales", "label")).toBe("/sales");
    expect(sectionAfterSwitch("/periods/12?tab=paid", "band")).toBe("/periods");
    expect(sectionAfterSwitch("/bands/4?tab=money", "label")).toBe("/directory");
    expect(sectionAfterSwitch("/funds", "label")).toBe("/funds");
    expect(sectionAfterSwitch("/funds", "band")).toBe("/");
    expect(sectionAfterSwitch("/from-label/3", "label")).toBe("/");
    expect(sectionAfterSwitch("/", "band")).toBe("/");
    expect(sectionAfterSwitch("", "label")).toBe("/");
  });
});
