import { Elysia, t } from "elysia";
import sanitize from "sanitize-filename";
import { version } from "../../package.json";
import { checkApiToken, apiEnabled } from "../api/auth";
import {
  convertFromUpload,
  createJob,
  ensureApiUserId,
  fileResults,
  jobWithFiles,
  saveUpload,
  startConversion,
  waitForJob,
} from "../api/service";
import {
  createSlot,
  expiresAtFor,
  getSlot,
  tokenMatches,
  uploadIdFromUrl,
  uploadUrlFor,
} from "../api/uploads";
import { getAllInputs, getAllTargets, getPossibleTargets } from "../converters/main";
import { outputDir } from "../helpers/dirs";
import { API_MAX_UPLOAD_MB, API_SYNC_WAIT_SECONDS } from "../helpers/env";

const maxBytes = () => API_MAX_UPLOAD_MB * 1024 * 1024;

function unauthorized(set: { status?: number | string }) {
  set.status = 401;
  return { ok: false, error: "unauthorized" };
}

function guard(request: Request, set: { status?: number | string }): boolean {
  if (!apiEnabled()) {
    set.status = 503;
    return false;
  }
  if (!checkApiToken(request)) return false;
  return true;
}

/**
 * REST API v1 (fork addition, hermes-gadget).
 *
 * All routes except /api/v1/health require `Authorization: Bearer <API_TOKEN>`
 * (or `x-api-key`). Jobs run under a dedicated API user; results are stored in
 * the same data dirs as the UI and served back via the download route.
 */
export const api = new Elysia()
  .get("/api/v1/health", () => ({ status: "ok", version }))
  .get("/api/v1/targets", ({ request, query, set }) => {
    if (!guard(request, set)) return unauthorized(set);
    const fileType = String(query.fileType ?? query.file_type ?? "").trim();
    if (!fileType) {
      set.status = 400;
      return { ok: false, error: "fileType query parameter is required" };
    }
    const targets = getPossibleTargets(fileType);
    return {
      ok: true,
      fileType,
      count: Object.values(targets).reduce((acc, list) => acc + list.length, 0),
      targets,
    };
  })
  .get("/api/v1/converters", ({ request, query, set }) => {
    if (!guard(request, set)) return unauthorized(set);
    const allTargets = getAllTargets();
    const name = String(query.name ?? "").trim();
    if (name) {
      return {
        ok: true,
        converter: name,
        from: getAllInputs(name),
        to: allTargets[name] ?? [],
      };
    }
    const converters: Record<string, { from: string[]; to: string[] }> = {};
    for (const converterName of Object.keys(allTargets)) {
      converters[converterName] = {
        from: getAllInputs(converterName),
        to: allTargets[converterName] ?? [],
      };
    }
    return { ok: true, converters };
  })
  .post(
    "/api/v1/convert",
    async ({ request, body, set }) => {
      if (!guard(request, set)) return unauthorized(set);
      const { file, convert_to, wait } = body as unknown as {
        file: File | File[];
        convert_to: string;
        wait?: string;
      };

      const files = Array.isArray(file) ? file : [file];
      if (files.length === 0) {
        set.status = 400;
        return { ok: false, error: "no file provided" };
      }
      for (const f of files) {
        if (f.size > maxBytes()) {
          set.status = 413;
          return { ok: false, error: `file exceeds API_MAX_UPLOAD_MB (${API_MAX_UPLOAD_MB})` };
        }
      }

      const userId = ensureApiUserId();
      const jobId = createJob(userId, files.length);

      const names: string[] = [];
      for (const f of files) {
        const data = new Uint8Array(await f.arrayBuffer());
        names.push(await saveUpload(userId, jobId, f.name, data));
      }

      startConversion(userId, jobId, names, convert_to);

      const shouldWait = !(wait === "false" || wait === "0" || wait === "no");
      const done = shouldWait ? await waitForJob(jobId, API_SYNC_WAIT_SECONDS * 1000) : false;
      const res = jobWithFiles(userId, jobId);
      const outFiles = res ? await fileResults(userId, jobId, res.files, false) : [];
      return { ok: true, jobId, numFiles: files.length, done, files: outFiles };
    },
    {
      body: t.Object({
        file: t.Files(),
        convert_to: t.String(),
        wait: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/api/v1/convert/b64",
    async ({ request, body, set }) => {
      if (!guard(request, set)) return unauthorized(set);
      const { filename, content_b64, convert_to, wait } = body as unknown as {
        filename: string;
        content_b64: string;
        convert_to: string;
        wait?: string;
      };

      let data: Buffer;
      try {
        data = Buffer.from(content_b64, "base64");
      } catch {
        set.status = 400;
        return { ok: false, error: "invalid base64 content" };
      }
      if (data.length === 0) {
        set.status = 400;
        return { ok: false, error: "empty content" };
      }
      if (data.length > maxBytes()) {
        set.status = 413;
        return { ok: false, error: `file exceeds API_MAX_UPLOAD_MB (${API_MAX_UPLOAD_MB})` };
      }

      const userId = ensureApiUserId();
      const jobId = createJob(userId, 1);
      const name = await saveUpload(userId, jobId, filename, new Uint8Array(data));
      startConversion(userId, jobId, [name], convert_to);

      const shouldWait = !(wait === "false" || wait === "0" || wait === "no");
      const done = shouldWait ? await waitForJob(jobId, API_SYNC_WAIT_SECONDS * 1000) : false;
      const res = jobWithFiles(userId, jobId);
      const outFiles = res ? await fileResults(userId, jobId, res.files, false) : [];
      return { ok: true, jobId, numFiles: 1, done, files: outFiles };
    },
    {
      body: t.Object({
        filename: t.String(),
        content_b64: t.String(),
        convert_to: t.String(),
        wait: t.Optional(t.String()),
      }),
    },
  )
  .get("/api/v1/jobs/:jobId", async ({ request, params, set }) => {
    if (!guard(request, set)) return unauthorized(set);
    const jobId = Number(params.jobId);
    if (!Number.isInteger(jobId)) {
      set.status = 400;
      return { ok: false, error: "invalid job id" };
    }
    const userId = ensureApiUserId();
    const res = jobWithFiles(userId, jobId);
    if (!res) {
      set.status = 404;
      return { ok: false, error: "job not found" };
    }
    const files = await fileResults(userId, jobId, res.files, false);
    const done = (res.job.num_files ?? 0) > 0 && res.files.length >= (res.job.num_files ?? 0);
    return {
      ok: true,
      jobId: res.job.id,
      status: res.job.status,
      numFiles: res.job.num_files,
      done,
      files,
    };
  })
  .get("/api/v1/jobs/:jobId/files/:fileName", async ({ request, params, set }) => {
    if (!guard(request, set)) return unauthorized(set);
    const jobId = Number(params.jobId);
    if (!Number.isInteger(jobId)) {
      set.status = 400;
      return { ok: false, error: "invalid job id" };
    }
    const fileName = sanitize(decodeURIComponent(params.fileName));
    const userId = ensureApiUserId();
    if (!jobWithFiles(userId, jobId)) {
      set.status = 404;
      return { ok: false, error: "job not found" };
    }
    const bunFile = Bun.file(`${outputDir}${userId}/${jobId}/${fileName}`);
    if (!(await bunFile.exists())) {
      set.status = 404;
      return { ok: false, error: "file not found" };
    }
    set.headers["content-disposition"] = `attachment; filename="${fileName}"`;
    return bunFile;
  })
  .post(
    "/api/v1/uploads",
    ({ request, body, set }) => {
      if (!guard(request, set)) return unauthorized(set);
      const { filename } = body as unknown as { filename: string };
      const slot = createSlot(sanitize(filename) || "upload.bin");
      return {
        ok: true,
        upload_id: slot.id,
        upload_url: uploadUrlFor(slot),
        expires_at: expiresAtFor(slot),
        max_bytes: maxBytes(),
      };
    },
    {
      body: t.Object({
        filename: t.String(),
        size_bytes: t.Optional(t.Number()),
      }),
    },
  )
  .all("/api/v1/uploads/:uploadId", async ({ request, params, body, set }) => {
    const slot = getSlot(params.uploadId);
    if (!slot) {
      set.status = 404;
      return { ok: false, error: "upload not found or expired" };
    }
    const url = new URL(request.url);
    const tokenOk = tokenMatches(slot, url.searchParams.get("token") ?? "");
    const bearerOk = apiEnabled() && checkApiToken(request);
    if (!tokenOk && !bearerOk) return unauthorized(set);
    if (request.method !== "PUT" && request.method !== "POST") {
      set.status = 405;
      return { ok: false, error: "method not allowed" };
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > maxBytes()) {
      set.status = 413;
      return { ok: false, error: `upload exceeds API_MAX_UPLOAD_MB (${API_MAX_UPLOAD_MB})` };
    }
    const contentType = request.headers.get("content-type") ?? "";
    const maybeFile = (body as { file?: File | File[] } | undefined)?.file;
    let wrote: number;
    if (body instanceof ArrayBuffer) {
      wrote = await Bun.write(slot.path, body);
    } else if (ArrayBuffer.isView(body)) {
      wrote = await Bun.write(slot.path, body as unknown as Uint8Array);
    } else if (typeof body === "string") {
      wrote = await Bun.write(slot.path, body);
    } else if (contentType.includes("multipart/form-data") && maybeFile) {
      const file = Array.isArray(maybeFile) ? maybeFile[0] : maybeFile;
      if (!file) {
        set.status = 400;
        return { ok: false, error: "no file field" };
      }
      wrote = await Bun.write(slot.path, file);
    } else {
      wrote = await Bun.write(slot.path, request as unknown as Response);
    }
    if (wrote === 0) {
      set.status = 400;
      return { ok: false, error: "empty upload body" };
    }
    if (wrote > maxBytes()) {
      set.status = 413;
      return { ok: false, error: `upload exceeds API_MAX_UPLOAD_MB (${API_MAX_UPLOAD_MB})` };
    }
    return { ok: true, upload_id: slot.id, filename: slot.filename, size: wrote };
  })
  .post(
    "/api/v1/convert/upload",
    async ({ request, body, set }) => {
      if (!guard(request, set)) return unauthorized(set);
      const { upload_url, upload_id, convert_to, wait } = body as unknown as {
        upload_url?: string;
        upload_id?: string;
        convert_to: string;
        wait?: string;
      };
      const id = upload_id ?? (upload_url ? uploadIdFromUrl(upload_url) : null);
      if (!id) {
        set.status = 400;
        return { ok: false, error: "upload_url or upload_id is required" };
      }
      const slot = getSlot(id);
      if (!slot) {
        set.status = 404;
        return { ok: false, error: "upload not found or expired" };
      }
      if (!(await Bun.file(slot.path).exists())) {
        set.status = 409;
        return {
          ok: false,
          error: "upload not completed yet - PUT the bytes to the upload_url first",
        };
      }
      const shouldWait = !(wait === "false" || wait === "0" || wait === "no");
      const result = await convertFromUpload(
        slot,
        convert_to,
        shouldWait,
        API_SYNC_WAIT_SECONDS,
        false,
      );
      return { ok: true, numFiles: 1, jobId: result.jobId, done: result.done, files: result.files };
    },
    {
      body: t.Object({
        upload_url: t.Optional(t.String()),
        upload_id: t.Optional(t.String()),
        convert_to: t.String(),
        wait: t.Optional(t.String()),
      }),
    },
  );
