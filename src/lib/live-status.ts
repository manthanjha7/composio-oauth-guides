import { storageMode } from "./store";

export type LiveStatus = { available: true } | { available: false; reason: string };

/** Whether this deployment can run the live agent right now (mirrors the checks in /api/generate). */
export function liveStatus(): LiveStatus {
  if (process.env.GENERATION_PAUSED === "1") return { available: false, reason: "Live generation is paused on this deployment. The library guides still work." };
  if (!process.env.ANTHROPIC_API_KEY) return { available: false, reason: "Live generation isn't configured on this deployment. The library guides still work." };
  if (storageMode() === "unavailable") return { available: false, reason: "Live generation needs durable storage on this deployment. The library guides still work." };
  return { available: true };
}
