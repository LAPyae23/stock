import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../_lib/app.js";

const request = (path, init) => app.handle(new Request(`http://localhost${path}`, init));

test("tags every response with a request id", async () => {
  const res = await request("/api/docs");
  assert.match(res.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
});

test("keeps a well-formed incoming request id", async () => {
  const res = await request("/api/docs", { headers: { "x-request-id": "trace-abc-12345" } });
  assert.equal(res.headers.get("x-request-id"), "trace-abc-12345");
});

test("replaces an overlong incoming request id", async () => {
  const res = await request("/api/docs", { headers: { "x-request-id": "x".repeat(200) } });
  assert.notEqual(res.headers.get("x-request-id"), "x".repeat(200));
  assert.equal(res.headers.get("x-request-id").length, 36);
});

test("serves the endpoint list", async () => {
  const res = await request("/api/docs");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, "Invento API");
  assert.equal(body.endpoints.length, 30);
  assert.ok(body.endpoints.some((e) => e.path === "/v1/stock/in/batch" && e.auth));
});

test("returns JSON 404 for an unknown route", async () => {
  const res = await request("/does-not-exist");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), {
    error: "NOT_FOUND",
    message: "No route for GET /does-not-exist"
  });
});

test("rejects authenticated routes without a token", async () => {
  const res = await request("/v1/me");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), {
    error: "AUTH_REQUIRED",
    message: "Please sign in again."
  });
});

test("rejects malformed JSON before the handler runs", async () => {
  const res = await request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json"
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "VALIDATION_ERROR");
});

test("rejects bodies over 4 MB", async () => {
  const res = await request("/v1/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(4 * 1024 * 1024 + 1)
    }
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "TOO_LARGE");
});

test("answers CORS preflight for the configured origin", async () => {
  const res = await request("/v1/me", {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization"
    }
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
});
