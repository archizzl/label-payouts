/*
 * Google's Agent Development Kit, from its self-contained web build: the default build pulls in
 * Node-only logging and telemetry the Worker can't run (and adds megabytes). Import ADK from here.
 */
export * from "@google/adk/dist/web/index_web.js";

import type { Runner } from "@google/adk/dist/web/index_web.js";

/** A message in Gemini's format (from @google/genai, which ADK bundles). */
export type Content = Parameters<Runner["runAsync"]>[0]["newMessage"];
