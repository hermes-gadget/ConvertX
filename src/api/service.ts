import { mkdirSync } from "node:fs";
import sanitize from "sanitize-filename";
import type { Cookie } from "elysia";
import { outputDir, uploadsDir } from "../helpers/dirs";
import db from "../db/db";
import { Filename, Jobs, User } from "../db/types";
import { handleConvert } from "../converters/main";
import { normalizeFiletype } from "../helpers/normalizeFiletype";
import { API_USER_EMAIL } from "../helpers/env";

/** Max size of a file returned inline (base64) by the API/MCP. */
const MAX_INLINE_B64_BYTES = 5 * 1024 * 1024;

let cachedApiUserId: number | null = null;

/**
 * Ensure a dedicated service user exists for API/MCP jobs. Its password is a
 * non-hash sentinel so it can never be used to log in via the UI.
 */
export function ensureApiUserId(): number {
  if (cachedApiUserId !== null) return cachedApiUserId;

  let user = db.query("SELECT * FROM users WHERE email = ?").as(User).get(API_USER_EMAIL);

  if (!user) {
    db.query("INSERT INTO users (email, password) VALUES (?1, ?2)").run(API_USER_EMAIL, "!");
    user = db.query("SELECT * FROM users WHERE email = ?").as(User).get(API_USER_EMAIL);
  }

  if (!user) throw new Error("failed to ensure the API user");
  cachedApiUserId = user.id;
  return user.id;
}

export interface ConversionFileResult {
  name: string;
  output: string;
  status: string;
  size?: number;
  content_b64?: string;
}

export function createJob(userId: number, numFiles: number): number {
  const row = db
    .query(
      "INSERT INTO jobs (user_id, date_created, status, num_files) VALUES (?1, ?2, ?3, ?4) RETURNING id",
    )
    .get(userId, new Date().toISOString(), "pending", numFiles) as { id: number } | null;
  if (!row) throw new Error("failed to create a job");
  return row.id;
}

export function jobWithFiles(
  userId: number,
  jobId: number | string,
): { job: Jobs; files: Filename[] } | null {
  const job = db
    .query("SELECT * FROM jobs WHERE user_id = ? AND id = ?")
    .as(Jobs)
    .get(userId, jobId);
  if (!job) return null;
  const files = db.query("SELECT * FROM file_names WHERE job_id = ?").as(Filename).all(jobId);
  return { job, files };
}

/** Save an uploaded file into the job's upload directory; returns the sanitized name. */
export async function saveUpload(
  userId: number,
  jobId: number,
  name: string,
  data: Uint8Array,
): Promise<string> {
  const safe = sanitize(name) || "upload.bin";
  const dir = `${uploadsDir}${userId}/${jobId}/`;
  mkdirSync(dir, { recursive: true });
  await Bun.write(`${dir}${safe}`, data);
  return safe;
}

/**
 * Kick off a conversion for a job (fire-and-forget, mirrors the UI flow).
 * Validates the target format the same way /convert does.
 */
export function startConversion(
  userId: number,
  jobId: number,
  fileNames: string[],
  convertToRaw: string,
): void {
  const convertTo = normalizeFiletype(convertToRaw.split(",")[0] ?? "");
  const converterName = convertToRaw.split(",")[1] ?? "";

  if (
    !convertTo ||
    convertTo.includes("/") ||
    convertTo.includes("\\") ||
    convertTo.includes("..")
  ) {
    throw new Error("invalid target format");
  }

  const userUploadsDir = `${uploadsDir}${userId}/${jobId}/`;
  const userOutputDir = `${outputDir}${userId}/${jobId}/`;
  mkdirSync(userOutputDir, { recursive: true });

  // handleConvert only reads `.value` off this cookie object.
  const jobIdCookie = { value: String(jobId) } as unknown as Cookie<string | undefined>;

  handleConvert(fileNames, userUploadsDir, userOutputDir, convertTo, converterName, jobIdCookie)
    .then(() => {
      db.query("UPDATE jobs SET status = 'completed' WHERE id = ?1").run(jobId);
    })
    .catch((error) => {
      console.error("Error in conversion process:", error);
    });
}

/** Poll until all of the job's files have a terminal status row (or timeout). */
export async function waitForJob(jobId: number, timeoutMs: number): Promise<boolean> {
  const expected =
    (
      db.query("SELECT num_files FROM jobs WHERE id = ?").get(jobId) as {
        num_files?: number;
      } | null
    )?.num_files ?? 0;
  if (expected <= 0) return false;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = db.query("SELECT COUNT(*) AS c FROM file_names WHERE job_id = ?").get(jobId) as {
      c: number;
    };
    if (row.c >= expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** Build result rows for a job, optionally inlining small file contents. */
export async function fileResults(
  userId: number,
  jobId: number,
  files: Filename[],
  withContent: boolean,
): Promise<ConversionFileResult[]> {
  const out: ConversionFileResult[] = [];
  for (const f of files) {
    const bunFile = Bun.file(`${outputDir}${userId}/${jobId}/${f.output_file_name}`);
    const entry: ConversionFileResult = {
      name: f.file_name,
      output: f.output_file_name,
      status: f.status,
    };
    if (await bunFile.exists()) {
      entry.size = bunFile.size;
      if (withContent && bunFile.size <= MAX_INLINE_B64_BYTES) {
        entry.content_b64 = Buffer.from(await bunFile.arrayBuffer()).toString("base64");
      }
    }
    out.push(entry);
  }
  return out;
}
