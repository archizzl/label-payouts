"use client";

import { useEffect } from "react";

/** The browser sent a stale sign-in cookie next to the current one: clear the stale one, once. */
export function FixSignIn() {
  useEffect(() => {
    void fetch("/api/fix-sign-in", { method: "POST" });
  }, []);
  return null;
}
