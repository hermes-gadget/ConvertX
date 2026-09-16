import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { apiUploadsDir } from "../helpers/dirs";
import { API_UPLOAD_TTL_MINUTES, EXTERNAL_BASE_URL } from "../helpers/env";

/**
 * Upload slots for the two-step flow (mirrors the GPU gateway pattern):
 *   request_upload -> PUT raw bytes to upload_url -> convert with upload_url
 * Slots are reusable within their TTL (convert the same source to several
 * targets) and swept lazily on slot creation.
 */
export interface UploadSlot {
  id: string;
  token: string;
  filename: string;
  createdAt: number;
  path: string;
}

const ttlMs = () => API_UPLOAD_TTL_MINUTES * 60 * 1000;

const slotDir = (id: string) => `${apiUploadsDir}${id}/`;
const slotFilePath = (id: string) => `${slotDir(id)}file.bin`;

export function createSlot(filename: string): UploadSlot {
  sweepExpiredSlots();
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, "");
  const createdAt = Date.now();
  mkdirSync(slotDir(id), { recursive: true });
  writeFileSync(`${slotDir(id)}meta.json`, JSON.stringify({ filename, token, createdAt }));
  return { id, token, filename, createdAt, path: slotFilePath(id) };
}

export function getSlot(id: string): UploadSlot | null {
  if (!id || id.includes("/") || id.includes("..")) return null;
  const metaPath = `${slotDir(id)}meta.json`;
  if (!existsSync(metaPath)) return null;
  let meta: { filename?: string; token?: string; createdAt?: number };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as typeof meta;
  } catch {
    return null;
  }
  const createdAt = meta.createdAt ?? 0;
  if (Date.now() - createdAt > ttlMs()) {
    rmSync(slotDir(id), { recursive: true, force: true });
    return null;
  }
  return {
    id,
    token: meta.token ?? "",
    filename: meta.filename ?? "upload.bin",
    createdAt,
    path: slotFilePath(id),
  };
}

export function tokenMatches(slot: UploadSlot, supplied: string): boolean {
  const expected = Buffer.from(slot.token);
  const given = Buffer.from(supplied);
  if (expected.length === 0 || expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

export function uploadUrlFor(slot: UploadSlot): string {
  return `${EXTERNAL_BASE_URL}/api/v1/uploads/${slot.id}?token=${slot.token}`;
}

export function expiresAtFor(slot: UploadSlot): string {
  return new Date(slot.createdAt + ttlMs()).toISOString();
}

/** Extract the upload id from an upload URL (path .../api/v1/uploads/<id>). */
export function uploadIdFromUrl(uploadUrl: string): string | null {
  try {
    const url = new URL(uploadUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const idx = parts.lastIndexOf("uploads");
    if (idx === -1 || idx + 1 >= parts.length) return null;
    return parts[idx + 1] ?? null;
  } catch {
    return null;
  }
}

/** Remove expired slots (lazy sweep; runs on slot creation). */
function sweepExpiredSlots(): number {
  if (!existsSync(apiUploadsDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(apiUploadsDir)) {
    const metaPath = `${apiUploadsDir}${entry}/meta.json`;
    try {
      if (!existsSync(metaPath)) continue;
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { createdAt?: number };
      if (Date.now() - (meta.createdAt ?? 0) > ttlMs()) {
        rmSync(`${apiUploadsDir}${entry}`, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // skip unreadable slots
    }
  }
  return removed;
}
