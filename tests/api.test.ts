import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const runId = `${process.pid}-${Date.now()}`;
const testDir = `/tmp/cx-api-test-${runId}`;
mkdirSync(testDir, { recursive: true });
process.env.DB_PATH = join(testDir, "test.sqlite");
process.env.API_TOKEN = "test-token-123";

const { Elysia } = await import("elysia");
const { api } = await import("../src/pages/api");
const app = new Elysia().use(api);

const auth = { authorization: "Bearer test-token-123" };
const url = (path: string) => `http://localhost${path}`;

test("health is open and reports ok", async () => {
  const res = await app.handle(new Request(url("/api/v1/health")));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe("ok");
});

test("protected routes reject missing or wrong tokens", async () => {
  const noAuth = await app.handle(new Request(url("/api/v1/targets?fileType=svg")));
  expect(noAuth.status).toBe(401);

  const badAuth = await app.handle(
    new Request(url("/api/v1/targets?fileType=svg"), {
      headers: { authorization: "Bearer nope" },
    }),
  );
  expect(badAuth.status).toBe(401);
});

test("targets lists conversion options for svg", async () => {
  const res = await app.handle(new Request(url("/api/v1/targets?fileType=svg"), { headers: auth }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; targets: Record<string, string[]> };
  expect(body.ok).toBe(true);
  expect(Object.keys(body.targets).length).toBeGreaterThan(0);
  const all = Object.values(body.targets).flat();
  expect(all).toContain("png");
});

test("converters inventory includes resvg", async () => {
  const res = await app.handle(
    new Request(url("/api/v1/converters?name=resvg"), { headers: auth }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; from: string[]; to: string[] };
  expect(body.ok).toBe(true);
  expect(body.from).toContain("svg");
  expect(body.to).toContain("png");
});

test("b64 conversion runs end to end and results are retrievable", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ff00aa"/></svg>`;
  const res = await app.handle(
    new Request(url("/api/v1/convert/b64"), {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        filename: "hello.svg",
        content_b64: Buffer.from(svg).toString("base64"),
        convert_to: "png,resvg",
        wait: "true",
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    jobId: number;
    done: boolean;
    files: { name: string; output: string; status: string }[];
  };
  expect(body.ok).toBe(true);
  expect(body.jobId).toBeGreaterThan(0);

  // The job must finish; converter availability differs between dev machines
  // and the full container, so any terminal status is acceptable here.
  const statusRes = await app.handle(
    new Request(url(`/api/v1/jobs/${body.jobId}`), { headers: auth }),
  );
  expect(statusRes.status).toBe(200);
  const status = (await statusRes.json()) as {
    ok: boolean;
    done: boolean;
    files: { status: string; output: string }[];
  };
  expect(status.ok).toBe(true);
  expect(status.done).toBe(true);
  expect(status.files.length).toBe(1);
  const first = status.files[0];
  expect(first).toBeDefined();
  expect(first!.output.endsWith(".png")).toBe(true);
});

test("unknown job returns 404", async () => {
  const res = await app.handle(new Request(url("/api/v1/jobs/999999"), { headers: auth }));
  expect(res.status).toBe(404);
});
