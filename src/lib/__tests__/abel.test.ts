import { describe, expect, it } from "vitest";
import { modelErrorMessage } from "../abel";

describe("modelErrorMessage", () => {
  it("says when Gemini is busy, out of credit or the model is gone", () => {
    expect(modelErrorMessage("503")).toMatch(/busy/);
    expect(modelErrorMessage("429")).toMatch(/busy/);
    expect(modelErrorMessage("402")).toMatch(/out of credit/);
    expect(modelErrorMessage("404")).toMatch(/isn’t available/);
    expect(modelErrorMessage(undefined)).toMatch(/couldn’t answer/);
  });
});
