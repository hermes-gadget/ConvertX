import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const runId = `${process.pid}-${Date.now()}`;
const testDir = `/tmp/cx-mcp-test-${runId}`;
mkdirSync(testDir, { recursive: true });
process.env.DB_PATH = join(testDir, "test.sqlite");
process.env.API_TOKEN = "test-token-123";
process.env.EXTERNAL_BASE_URL = "http://localhost";

const { Elysia } = await import("elysia");
const { api } = await import("../src/pages/api");
const { mcp } = await import("../src/pages/mcp");
const app = new Elysia().use(api).use(mcp);

const url = "http://localhost/mcp";

async function rpc(body: unknown, sessionId?: string, token = "test-token-123") {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return app.handle(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
}

test("mcp endpoint rejects bad tokens", async () => {
  const res = await rpc(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    undefined,
    "wrong",
  );
  expect(res.status).toBe(401);
});

test("mcp handshake: initialize, tools/list, tools/call", async () => {
  const initRes = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  });
  expect(initRes.status).toBe(200);
  const sessionId = initRes.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  const initBody = (await initRes.json()) as {
    result: { serverInfo: { name: string }; capabilities: { tools?: unknown } };
  };
  expect(initBody.result.serverInfo.name).toBe("convertx");
  expect(initBody.result.capabilities.tools).toBeTruthy();

  const notifRes = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId!);
  expect([200, 202]).toContain(notifRes.status);

  const listRes = await rpc(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId!,
  );
  expect(listRes.status).toBe(200);
  const listBody = (await listRes.json()) as { result: { tools: { name: string }[] } };
  const names = listBody.result.tools.map((t) => t.name).sort();
  expect(names).toEqual(
    [
      "convert",
      "fetch_result",
      "health",
      "job_status",
      "list_converters",
      "list_targets",
      "request_upload",
    ].sort(),
  );

  const healthRes = await rpc(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "health", arguments: {} },
    },
    sessionId!,
  );
  expect(healthRes.status).toBe(200);
  const healthBody = (await healthRes.json()) as {
    result: { content: { type: string; text: string }[] };
  };
  const payload = JSON.parse(healthBody.result.content[0]!.text) as { ok: boolean };
  expect(payload.ok).toBe(true);

  const targetsRes = await rpc(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_targets", arguments: { file_type: "svg" } },
    },
    sessionId!,
  );
  expect(targetsRes.status).toBe(200);
  const targetsBody = (await targetsRes.json()) as {
    result: { content: { type: string; text: string }[] };
  };
  const targets = JSON.parse(targetsBody.result.content[0]!.text) as {
    ok: boolean;
    count: number;
  };
  expect(targets.ok).toBe(true);
  expect(targets.count).toBeGreaterThan(0);
});

test("unknown session id returns 404", async () => {
  const res = await rpc(
    { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
    "00000000-0000-0000-0000-000000000000",
  );
  expect(res.status).toBe(404);
});

test("upload flow: request_upload, PUT bytes, convert with upload_url", async () => {
  const initRes = await rpc({
    jsonrpc: "2.0",
    id: 10,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  const sessionId = initRes.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId!);

  const slotRes = await rpc(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "request_upload", arguments: { filename: "contacts.vcf" } },
    },
    sessionId!,
  );
  expect(slotRes.status).toBe(200);
  const slotBody = (await slotRes.json()) as { result: { content: { text: string }[] } };
  const slot = JSON.parse(slotBody.result.content[0]!.text) as {
    ok: boolean;
    upload_url: string;
    upload_id: string;
  };
  expect(slot.ok).toBe(true);
  expect(slot.upload_url).toContain(slot.upload_id);

  // vcf->csv is a pure-TypeScript converter (no binaries needed), so the full
  // happy path including download_url is provable on any machine.
  const vcf = "BEGIN:VCARD\nVERSION:3.0\nFN:Flow Test\nN:Test;Flow;;;\nEND:VCARD\n";
  const upRes = await app.handle(new Request(slot.upload_url, { method: "PUT", body: vcf }));
  expect(upRes.status).toBe(200);
  const upBody = (await upRes.json()) as { ok: boolean; size: number };
  expect(upBody.ok).toBe(true);
  expect(upBody.size).toBe(Buffer.byteLength(vcf));

  const convRes = await rpc(
    {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "convert", arguments: { upload_url: slot.upload_url, target: "csv,vcf" } },
    },
    sessionId!,
  );
  expect(convRes.status).toBe(200);
  const convBody = (await convRes.json()) as { result: { content: { text: string }[] } };
  const conv = JSON.parse(convBody.result.content[0]!.text) as {
    ok: boolean;
    jobId: number;
    done: boolean;
    files: { status: string; download_url?: string }[];
  };
  expect(conv.ok).toBe(true);
  expect(conv.done).toBe(true);
  expect(conv.files.length).toBe(1);
  expect(conv.files[0]!.status).toBe("Done");
  expect(conv.files[0]!.download_url).toContain(`/api/v1/jobs/${conv.jobId}/files/`);
});
