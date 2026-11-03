import { z } from "zod";

export const browserControlsSchema = z
  .strictObject({
    waitUntil: z.enum(["load", "domcontentloaded"]).optional(),
    readiness: z
      .strictObject({
        selector: z.string().trim().min(1).max(2048).optional(),
        text: z.string().trim().min(1).max(2048).optional(),
        scope: z.enum(["body", "title"]).optional(),
        timeoutMs: z.int().min(1).max(120000).optional(),
      })
      .optional(),
    consent: z.enum(["off", "rejectNonEssential", "acceptAll"]).optional(),
    workflow: z
      .enum(["none", "auto", "bestbuy-us@1", "product-details@1"])
      .optional(),
    maxAttempts: z.int().min(1).max(3).optional(),
    engineFallback: z.boolean().optional(),
    sessionId: z.uuid().optional(),
    continueSession: z.boolean().optional(),
  })
  .refine(
    value =>
      !value.readiness ||
      !!(value.readiness.selector || value.readiness.text) ||
      (value.workflow === "auto" &&
        value.readiness.timeoutMs !== undefined &&
        value.readiness.scope !== "title"),
    "Readiness needs a selector/text, or an explicit timeout for an automatic body workflow",
  )
  .refine(
    value => !value.continueSession || !!value.sessionId,
    "Continuing requires a sessionId",
  )
  .refine(
    value => !value.sessionId || (value.maxAttempts ?? 1) === 1,
    "Session commands cannot be retried",
  )
  .refine(
    value =>
      !value.engineFallback ||
      (!value.sessionId && (value.maxAttempts ?? 1) === 1),
    "Engine fallback requires a stateless scrape with one attempt per backend",
  );
export type BrowserControls = z.infer<typeof browserControlsSchema>;
export const LOCAL_ACTION_TYPES = [
  "click",
  "wait",
  "write",
  "press",
  "scroll",
  "scrape",
];
