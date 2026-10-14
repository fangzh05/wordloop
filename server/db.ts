import { instrumentDatabaseFetch } from "./services/perf.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchWithToken, NeonPostgrestClient } from "@neondatabase/postgrest-js";
import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  DEV_USER_ID: z.string().uuid().optional(),
});

type RequestIdentity = { userId: string; issuer?: string };
const requestIdentity = new AsyncLocalStorage<RequestIdentity>();
export function withUserIdentity<T>(userId: string, work: () => T, issuer?: string): T {
  return requestIdentity.run({ userId, issuer }, work);
}
export function getPublicAuthConfig() {
  const env = activeEnv();
  const url = z.string().url().parse(env.SUPABASE_URL);
  const key = z.string().min(20).parse(env.SUPABASE_PUBLISHABLE_KEY);
  if (key === env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Invalid public auth configuration.");
  return { url, key };
}
let client: SupabaseClient | undefined;
let authClient: SupabaseClient | undefined;
let authAdminClient: SupabaseClient | undefined;
const neonClients = new Map<string, SupabaseClient>();
const neonAccessTokens = new Map<string, { expiresAt: number; token: Promise<string> }>();
let neonSigningKey: CryptoKey | undefined;
let runtimeEnv: Record<string, unknown> | undefined;

function activeEnv(): Record<string, unknown> {
  if (runtimeEnv) return runtimeEnv;
  if (typeof process !== "undefined") return process.env;
  return {};
}

export function learningTimeCalibrationEnabled(): boolean {
  return activeEnv().WORDLOOP_TIME_CALIBRATION_V2 === "true";
}

/** Opt-in until the additive Neon migration is applied and the worker is ready. */
export function adaptiveDailyBudgetV2Enabled(): boolean {
  return activeEnv().WORDLOOP_ADAPTIVE_DAILY_BUDGET_V2 === "true";
}

export function getShanbayImportBridgeConfig(): { url: string; secret: string } | null {
  const env = activeEnv();
  if (!env.SHANBAY_IMPORT_WORKER_URL || !env.SHANBAY_IMPORT_BRIDGE_SECRET) return null;
  const url = z.string().url().parse(env.SHANBAY_IMPORT_WORKER_URL);
  if (new URL(url).protocol !== "https:") throw new Error("Invalid import bridge configuration.");
  return { url, secret: z.string().min(32).parse(env.SHANBAY_IMPORT_BRIDGE_SECRET) };
}

export function configureRuntimeEnv(env: Record<string, unknown>): void {
  const configKeys = [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY",
    "NEON_DATA_API_URL", "NEON_JWT_AUDIENCE", "NEON_WORKER_JWT_PRIVATE_JWK",
    "NEON_JWT_ISSUER", "WORDLOOP_STAGING_DIAGNOSTICS",
  ];
  const changed = configKeys.some((key) => runtimeEnv?.[key] !== env[key]);
  runtimeEnv = env;
  if (changed) {
    client = undefined;
    authClient = undefined;
    authAdminClient = undefined;
    neonClients.clear();
    neonAccessTokens.clear();
    neonSigningKey = undefined;
  }
}

export function getDatabase(): SupabaseClient {
  const env = envSchema.safeParse(activeEnv());
  if (!env.success) {
    throw new Error("Wordloop server is missing valid Supabase configuration.");
  }
  const active = activeEnv();
  const neonConfigured = ["NEON_DATA_API_URL", "NEON_WORKER_JWT_PRIVATE_JWK"].some((key) => active[key] !== undefined && active[key] !== "");
  if (neonConfigured) {
    const identity = requestIdentity.getStore();
    if (!identity?.userId) throw new Error("Neon access requires a verified WordLoop user identity.");
    const identityKey = JSON.stringify([identity.issuer ?? "", identity.userId]);
    const cachedClient = neonClients.get(identityKey);
    if (cachedClient) return cachedClient;
    const dataApiUrl = z.string().url().parse(active.NEON_DATA_API_URL);
    const parsedUrl = new URL(dataApiUrl);
    if (parsedUrl.protocol !== "https:" || !parsedUrl.pathname.endsWith("/rest/v1")) {
      throw new Error("NEON_DATA_API_URL must be the HTTPS Neon Data API REST endpoint.");
    }
    const scopedClient = new NeonPostgrestClient({
      dataApiUrl,
      options: {
        db: { schema: "public" },
        global: { fetch: instrumentDatabaseFetch(fetchWithToken(() => getNeonWorkerAccessToken(identity))) },
      },
    }) as unknown as SupabaseClient;
    neonClients.set(identityKey, scopedClient);
    if (neonClients.size > 64) {
      const oldestKey = neonClients.keys().next().value;
      if (oldestKey !== undefined) neonClients.delete(oldestKey);
    }
    return scopedClient;
  }
  if (client) return client;
  const serviceRoleKey = z.string().min(20).parse(env.data.SUPABASE_SERVICE_ROLE_KEY);
  client = createClient(env.data.SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: instrumentDatabaseFetch(fetch) },
  });
  return client;
}

/** Supabase Auth remains the source of truth for sign-in and access-token validation. */
export function getSupabaseAuthClient(): SupabaseClient {
  if (authClient) return authClient;
  const env = envSchema.safeParse(activeEnv());
  if (!env.success) throw new Error("Wordloop server is missing valid Supabase configuration.");
  const publicKey = z.string().min(20).parse(activeEnv().SUPABASE_PUBLISHABLE_KEY ?? env.data.SUPABASE_SERVICE_ROLE_KEY);
  authClient = createClient(env.data.SUPABASE_URL, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return authClient;
}

/** Supabase service role is retained only for Auth admin operations, never Neon data access. */
export function getSupabaseAuthAdminClient(): SupabaseClient {
  if (authAdminClient) return authAdminClient;
  const env = envSchema.safeParse(activeEnv());
  if (!env.success) throw new Error("Wordloop server is missing valid Supabase configuration.");
  const serviceRoleKey = z.string().min(20).parse(env.data.SUPABASE_SERVICE_ROLE_KEY);
  authAdminClient = createClient(env.data.SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return authAdminClient;
}

const NEON_JWT_KID = "wordloop-worker-es256-v1";
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodeJson(value: unknown): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

function getNeonPrivateJwk(): JsonWebKey & { kid?: string } {
  const raw = z.string().min(100).parse(activeEnv().NEON_WORKER_JWT_PRIVATE_JWK);
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as JsonWebKey & { kid?: string };
  if (parsed.kty !== "EC" || parsed.crv !== "P-256" || !parsed.d || !parsed.x || !parsed.y) {
    throw new Error("NEON_WORKER_JWT_PRIVATE_JWK must be a P-256 private JWK.");
  }
  return parsed;
}

async function getNeonSigningKey(): Promise<CryptoKey> {
  if (neonSigningKey) return neonSigningKey;
  neonSigningKey = await crypto.subtle.importKey(
    "jwk", getNeonPrivateJwk(), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  return neonSigningKey;
}

async function getNeonWorkerAccessToken(scopedIdentity?: RequestIdentity): Promise<string> {
  const identity = scopedIdentity ?? requestIdentity.getStore();
  if (!identity?.userId) throw new Error("Neon access requires a verified WordLoop user identity.");
  const env = activeEnv();
  const issuer = z.string().url().parse(env.NEON_JWT_ISSUER ?? identity.issuer);
  const audience = z.string().min(1).parse(env.NEON_JWT_AUDIENCE ?? "wordloop-neon-api");
  const now = Math.floor(Date.now() / 1000);
  const role = isLegacyOwner(identity.userId) ? "wordloop_admin" : "authenticated";
  const cacheKey = JSON.stringify([issuer, audience, identity.userId, role]);
  const cached = neonAccessTokens.get(cacheKey);
  if (cached && cached.expiresAt > now + 5) return cached.token;
  if (cached) neonAccessTokens.delete(cacheKey);

  const token = (async () => {
    const jwk = getNeonPrivateJwk();
    const header = encodeJson({ alg: "ES256", typ: "JWT", kid: jwk.kid ?? NEON_JWT_KID });
    const payload = encodeJson({
      iss: issuer,
      aud: audience,
      sub: identity.userId,
      role,
      iat: now,
      exp: now + 60,
    });
    const signingInput = `${header}.${payload}`;
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, await getNeonSigningKey(), encoder.encode(signingInput),
    ));
    return `${signingInput}.${base64Url(signature)}`;
  })();
  neonAccessTokens.set(cacheKey, { expiresAt: now + 60, token });
  if (neonAccessTokens.size > 128) {
    const oldestKey = neonAccessTokens.keys().next().value;
    if (oldestKey !== undefined) neonAccessTokens.delete(oldestKey);
  }
  try {
    return await token;
  } catch (error) {
    if (neonAccessTokens.get(cacheKey)?.token === token) neonAccessTokens.delete(cacheKey);
    throw error;
  }
}

/** Public verification key for Neon Data API's external JWT provider. */
export function getNeonWorkerJwks(): { keys: Array<JsonWebKey & { kid: string; alg: string; use: string }> } {
  const { kty, crv, x, y, kid } = getNeonPrivateJwk();
  if (!x || !y) throw new Error("NEON_WORKER_JWT_PRIVATE_JWK is incomplete.");
  const additionalRaw = activeEnv().NEON_WORKER_ADDITIONAL_PUBLIC_JWKS;
  const additionalKeys = additionalRaw === undefined || additionalRaw === ""
    ? []
    : z.object({
      keys: z.array(z.object({
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: z.string().min(1),
        y: z.string().min(1),
        kid: z.string().min(1),
        alg: z.literal("ES256"),
        use: z.literal("sig"),
        key_ops: z.array(z.literal("verify")).optional(),
      }).strict()),
    }).strict().parse(JSON.parse(z.string().parse(additionalRaw))).keys;
  const keys = [
    { kty, crv, x, y, kid: kid ?? NEON_JWT_KID, alg: "ES256", use: "sig", key_ops: ["verify"] },
    ...additionalKeys,
  ];
  if (new Set(keys.map((key) => key.kid)).size !== keys.length) {
    throw new Error("Neon JWKS contains duplicate key identifiers.");
  }
  return { keys };
}

export function getAuthenticatedUserId(): string {
  const userId = requestIdentity.getStore()?.userId;
  if (userId) return userId;
  return getLegacyOwnerId();
}

export function getLegacyOwnerId(): string {
  const parsed = z.string().uuid().safeParse(activeEnv().DEV_USER_ID);
  if (!parsed.success) throw new Error("DEV_USER_ID must be a valid UUID.");
  return parsed.data;
}

export function isLegacyOwner(userId: string): boolean {
  const parsed = z.string().uuid().safeParse(activeEnv().DEV_USER_ID);
  return parsed.success && parsed.data === userId;
}

export function isStagingDiagnosticsEnabled(): boolean {
  return activeEnv().WORDLOOP_STAGING_DIAGNOSTICS === "true";
}

export function shouldExposeStagingDiagnostics(userId: string | undefined): boolean {
  return isStagingDiagnosticsEnabled()
    && userId !== undefined
    && isLegacyOwner(userId);
}

export function getMerriamWebsterApiKey(): string | undefined {
  const parsed = z.string().trim().min(1).safeParse(activeEnv().MERRIAM_WEBSTER_API_KEY);
  return parsed.success ? parsed.data : undefined;
}

export function getDeepSeekApiKey(): string | undefined {
  const parsed = z.string().trim().min(1).safeParse(activeEnv().DEEPSEEK_API_KEY);
  return parsed.success ? parsed.data : undefined;
}

export function getWordloopWebToken(): string | undefined {
  const parsed = z.string().trim().min(1).safeParse(activeEnv().WORDLOOP_WEB_TOKEN);
  return parsed.success ? parsed.data : undefined;
}

export function getShanbayCookie(): string {
  const env = activeEnv();
  const fullCookie = z.string().trim().min(1).safeParse(env.SHANBAY_COOKIE);
  if (fullCookie.success) {
    // Browser Cookie headers often contain tracking cookies and extra spacing.
    // Shanbay only needs auth_token; canonicalize it before the server-side request.
    const match = fullCookie.data.match(/(?:^|;\s*)auth_token=([^;]+)/i);
    if (match?.[1]) return `auth_token=${match[1]}`;
    return fullCookie.data;
  }
  const token = z.string().trim().min(1).safeParse(env.SHANBAY_AUTH_TOKEN);
  if (token.success) {
    const inlineCookie = token.data.match(/(?:^|;\s*)auth_token=([^;]+)/i);
    if (inlineCookie?.[1]) return `auth_token=${inlineCookie[1]}`;
    return `auth_token=${encodeURIComponent(token.data)}`;
  }
  throw new Error("Shanbay authentication is not configured.");
}

/**
 * Some Shanbay vocabulary endpoints expect the browser's CSRF header even for
 * read requests. Keep this value server-side and return only the token; the
 * auth Cookie itself remains canonicalized to auth_token by getShanbayCookie.
 */
export function getShanbayCsrfToken(): string | undefined {
  const value = z.string().trim().min(1).safeParse(activeEnv().SHANBAY_COOKIE);
  if (!value.success) return undefined;
  const match = value.data.match(/(?:^|;\s*)csrftoken=([^;]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export function resetDatabaseForTests(): void {
  client = undefined;
  authClient = undefined;
  authAdminClient = undefined;
  neonClients.clear();
  neonAccessTokens.clear();
  neonSigningKey = undefined;
  runtimeEnv = undefined;
}
