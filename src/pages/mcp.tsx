import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import sanitize from "sanitize-filename";
import { version } from "../../package.json";
import { apiEnabled, checkApiToken } from "../api/auth";
import {
  createJob,
  ensureApiUserId,
  fileResults,
  jobWithFiles,
  saveUpload,
  startConversion,
  waitForJob,
} from "../api/service";
import { getAllInputs, getAllTargets, getPossibleTargets } from "../converters/main";
import { API_MAX_UPLOAD_MB } from "../helpers/env";

/** Active MCP sessions (Streamable HTTP, stateful). */
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
const MAX_SESSIONS = 128;

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "convertx", version });

  server.registerTool(
    "convert",
    {
      description:
        "Convert a file to a target format. Provide the file inline as base64. Returns the job id and, when wait is true (default), the finished outputs (small files are inlined as base64).",
      inputSchema: {
        filename: z.string().describe("source file name including extension, e.g. hello.svg"),
        content_b64: z.string().describe("base64-encoded source file content"),
        target: z
          .string()
          .describe('target format as "format" or "format,converter", e.g. "png" or "png,resvg"'),
        wait: z.boolean().optional().describe("wait for the conversion to finish (default true)"),
        timeout_s: z.number().optional().describe("maximum seconds to wait (default 300)"),
      },
    },
    async ({ filename, content_b64, target, wait, timeout_s }) => {
      const data = Buffer.from(content_b64, "base64");
      if (data.length === 0) return textResult({ ok: false, error: "empty content" });
      if (data.length > API_MAX_UPLOAD_MB * 1024 * 1024) {
        return textResult({
          ok: false,
          error: `file exceeds the inline cap (API_MAX_UPLOAD_MB=${API_MAX_UPLOAD_MB}); use the REST API for large files`,
        });
      }

      const userId = ensureApiUserId();
      const jobId = createJob(userId, 1);
      const name = await saveUpload(userId, jobId, filename, new Uint8Array(data));
      startConversion(userId, jobId, [name], target);

      const shouldWait = wait !== false;
      const done = shouldWait ? await waitForJob(jobId, (timeout_s ?? 300) * 1000) : false;
      const res = jobWithFiles(userId, jobId);
      const files = res ? await fileResults(userId, jobId, res.files, true) : [];
      return textResult({ ok: true, jobId, done, files });
    },
  );

  server.registerTool(
    "list_targets",
    {
      description:
        "List possible conversion targets for a source file type (by extension), grouped by converter.",
      inputSchema: {
        file_type: z.string().describe("source file extension without dot, e.g. svg"),
      },
    },
    async ({ file_type }) => {
      const targets = getPossibleTargets(file_type);
      return textResult({
        ok: true,
        fileType: file_type,
        count: Object.values(targets).reduce((acc, list) => acc + list.length, 0),
        targets,
      });
    },
  );

  server.registerTool(
    "list_converters",
    {
      description: "List available converters and their supported input/output formats.",
      inputSchema: {
        name: z.string().optional().describe("optional single converter name to inspect"),
      },
    },
    async ({ name }) => {
      const allTargets = getAllTargets();
      if (name) {
        return textResult({
          ok: true,
          converter: name,
          from: getAllInputs(name),
          to: allTargets[name] ?? [],
        });
      }
      const converters: Record<string, { from: string[]; to: string[] }> = {};
      for (const converterName of Object.keys(allTargets)) {
        converters[converterName] = {
          from: getAllInputs(converterName),
          to: allTargets[converterName] ?? [],
        };
      }
      return textResult({ ok: true, converters });
    },
  );

  server.registerTool(
    "job_status",
    {
      description: "Get the status of a conversion job and its files.",
      inputSchema: {
        job_id: z.number().describe("job id returned by convert"),
      },
    },
    async ({ job_id }) => {
      const userId = ensureApiUserId();
      const res = jobWithFiles(userId, job_id);
      if (!res) return textResult({ ok: false, error: "job not found" });
      const files = await fileResults(userId, job_id, res.files, false);
      const done = (res.job.num_files ?? 0) > 0 && res.files.length >= (res.job.num_files ?? 0);
      return textResult({
        ok: true,
        jobId: res.job.id,
        status: res.job.status,
        numFiles: res.job.num_files,
        done,
        files,
      });
    },
  );

  server.registerTool(
    "fetch_result",
    {
      description:
        "Fetch a converted output file by job id and output file name (small files are inlined as base64).",
      inputSchema: {
        job_id: z.number().describe("job id returned by convert"),
        name: z.string().describe("output file name, e.g. hello.png"),
        include_content: z
          .boolean()
          .optional()
          .describe("inline the file content as base64 (default true)"),
      },
    },
    async ({ job_id, name, include_content }) => {
      const userId = ensureApiUserId();
      const res = jobWithFiles(userId, job_id);
      if (!res) return textResult({ ok: false, error: "job not found" });
      const wanted = sanitize(name);
      const match = res.files.filter((f) => f.output_file_name === wanted);
      if (match.length === 0) {
        return textResult({
          ok: false,
          error: "output not found",
          available: res.files.map((f) => f.output_file_name),
        });
      }
      const files = await fileResults(userId, job_id, match, include_content !== false);
      return textResult({ ok: true, jobId: job_id, files });
    },
  );

  server.registerTool(
    "health",
    {
      description: "Check the ConvertX instance status and converter inventory.",
      inputSchema: {},
    },
    async () => {
      return textResult({
        ok: true,
        version,
        converters: Object.keys(getAllTargets()).length,
      });
    },
  );

  return server;
}

/**
 * Native MCP endpoint (fork addition, hermes-gadget).
 *
 * Streamable HTTP, stateful sessions, bearer-token auth (API_TOKEN).
 * Stateless servers would reject tools/list on fresh transports, so each
 * initialize gets a session that subsequent requests reuse.
 */
export const mcp = new Elysia().all("/mcp", async ({ request, body, set }) => {
  if (!apiEnabled()) {
    set.status = 503;
    return { ok: false, error: "MCP endpoint disabled (set API_TOKEN)" };
  }
  if (!checkApiToken(request)) {
    set.status = 401;
    set.headers["www-authenticate"] = 'Bearer realm="convertx"';
    return { ok: false, error: "unauthorized" };
  }

  const parsedBody = typeof body !== "undefined" ? body : undefined;
  const handleOptions = parsedBody !== undefined ? { parsedBody } : undefined;

  const sessionId = request.headers.get("mcp-session-id");
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (!existing) {
      set.status = 404;
      return {
        jsonrpc: "2.0",
        error: { code: -32001, message: "session not found" },
        id: null,
      };
    }
    return existing.handleRequest(request, handleOptions);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      sessions.set(sid, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  const server = buildServer();
  await server.connect(transport);
  return transport.handleRequest(request, handleOptions);
});
