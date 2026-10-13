import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureRuntimeEnv, getDatabase, getNeonWorkerJwks, resetDatabaseForTests, withUserIdentity } from "../server/db.js";

const owner = "00000000-0000-4000-8000-000000000001";
const learner = "00000000-0000-4000-8000-000000000002";
const requests: Array<{ url: string; token: string }> = [];

function decodePart(value: string): Record<string, unknown> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as Record<string, unknown>;
}

beforeEach(async () => {
  resetDatabaseForTests();
  requests.length = 0;
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  configureRuntimeEnv({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role-key-1234567890",
    DEV_USER_ID: owner,
    NEON_DATA_API_URL: "https://example.neon.tech/neondb/rest/v1",
    NEON_JWT_AUDIENCE: "wordloop-neon-api",
    NEON_WORKER_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, token: headers.get("authorization")?.replace(/^Bearer /i, "") ?? "" });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetDatabaseForTests();
});

describe("Neon Data API identity bridge", () => {
  it("fails closed instead of falling back to Supabase business data without Neon configuration", () => {
    resetDatabaseForTests();
    configureRuntimeEnv({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-only-publishable-key-1234567890",
      DEV_USER_ID: owner,
    });
    expect(() => getDatabase()).toThrow();
  });

  it("issues short-lived internal tokens with only the verified user identity", async () => {

    await withUserIdentity(learner, async () => { await getDatabase().from("users").select("id").limit(1); }, "https://staging.wordloop.workers.dev");
    await withUserIdentity(owner, async () => { await getDatabase().from("users").select("id").limit(1); }, "https://staging.wordloop.workers.dev");

    expect(requests).toHaveLength(2);
    const first = requests[0]!.token.split(".");
    const second = requests[1]!.token.split(".");
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(decodePart(first[1]!).sub).toBe(learner);
    expect(decodePart(first[1]!).role).toBe("authenticated");
    expect(decodePart(first[1]!).iss).toBe("https://staging.wordloop.workers.dev");
    expect(decodePart(first[1]!).aud).toBe("wordloop-neon-api");
    expect(decodePart(first[1]!).exp as number).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60);
    expect(decodePart(second[1]!).sub).toBe(owner);
    expect(decodePart(second[1]!).role).toBe("wordloop_admin");
  });

  it("publishes only the public EC verification key", () => {
    const jwks = getNeonWorkerJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("can publish another public verification key without accepting private material or duplicate kids", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const privateJwk = { ...await crypto.subtle.exportKey("jwk", keyPair.privateKey), kid: "wordloop-worker-es256-v1" };
    const publicKey = {
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
      kid: "wordloop-worker-es256-prod-v1",
      alg: "ES256",
      use: "sig",
      key_ops: ["verify"],
    };
    configureRuntimeEnv({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role-key-1234567890",
      DEV_USER_ID: owner,
      NEON_DATA_API_URL: "https://example.neon.tech/neondb/rest/v1",
      NEON_JWT_AUDIENCE: "wordloop-neon-api",
      NEON_WORKER_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
      NEON_WORKER_ADDITIONAL_PUBLIC_JWKS: JSON.stringify({ keys: [publicKey] }),
    });

    const jwks = getNeonWorkerJwks();
    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys[1]).toMatchObject({ kid: "wordloop-worker-es256-prod-v1", alg: "ES256", use: "sig" });
    expect(jwks.keys.every((key) => !("d" in key))).toBe(true);

    configureRuntimeEnv({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role-key-1234567890",
      DEV_USER_ID: owner,
      NEON_DATA_API_URL: "https://example.neon.tech/neondb/rest/v1",
      NEON_JWT_AUDIENCE: "wordloop-neon-api",
      NEON_WORKER_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
      NEON_WORKER_ADDITIONAL_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicKey, d: "must-not-be-accepted" }] }),
    });
    expect(() => getNeonWorkerJwks()).toThrow();

    configureRuntimeEnv({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role-key-1234567890",
      DEV_USER_ID: owner,
      NEON_DATA_API_URL: "https://example.neon.tech/neondb/rest/v1",
      NEON_JWT_AUDIENCE: "wordloop-neon-api",
      NEON_WORKER_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
      NEON_WORKER_ADDITIONAL_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicKey, kid: "wordloop-worker-es256-v1" }] }),
    });
    expect(() => getNeonWorkerJwks()).toThrow("duplicate key identifiers");
  });
});
