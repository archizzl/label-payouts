import { describe, expect, it } from "vitest";
import { cookieValues, hasDuplicateSession, SESSION_TOKEN } from "../auth-cookies";

describe("sign-in cookies", () => {
  it("finds every copy of the session token, with or without the __Secure- prefix", () => {
    const header = "a=1; __Secure-better-auth.session_token=old; theme=dark; __Secure-better-auth.session_token=new";
    expect(cookieValues(header, SESSION_TOKEN).map((c) => c.value)).toEqual(["old", "new"]);
    expect(hasDuplicateSession(header)).toBe(true);
  });

  it("isn't fooled by one token or none", () => {
    expect(hasDuplicateSession("better-auth.session_token=x; better-auth.session_data=y")).toBe(false);
    expect(hasDuplicateSession(null)).toBe(false);
  });
});
