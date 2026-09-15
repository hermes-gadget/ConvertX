import { timingSafeEqual } from "node:crypto";
import { API_TOKEN } from "../helpers/env";

/** API access is enabled only when at least one token is configured. */
export const apiEnabled = (): boolean => API_TOKEN.trim().length > 0;

/** Extract a bearer token from Authorization or x-api-key headers. */
function extractToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return (request.headers.get("x-api-key") ?? "").trim();
}

/**
 * Constant-time check of the supplied token against the configured
 * comma-separated API_TOKEN list.
 */
export function checkApiToken(request: Request): boolean {
  if (!apiEnabled()) return false;
  const supplied = extractToken(request);
  if (!supplied) return false;

  const valid = API_TOKEN.split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  const suppliedBuf = Buffer.from(supplied);
  let ok = false;
  for (const token of valid) {
    const tokenBuf = Buffer.from(token);
    if (tokenBuf.length !== suppliedBuf.length) continue;
    if (timingSafeEqual(tokenBuf, suppliedBuf)) ok = true;
  }
  return ok;
}
