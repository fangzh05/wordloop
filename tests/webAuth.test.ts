import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureRuntimeEnv, getAuthenticatedUserId, resetDatabaseForTests, withUserIdentity } from "../server/db.js";
import { authenticateWebUser } from "../server/webAuth.js";

const users = vi.hoisted(() => ({ getUser: vi.fn(), profile: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: users.getUser }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: users.profile }) }) }) }) }));
const owner = "00000000-0000-4000-8000-000000000001";
const friend = "00000000-0000-4000-8000-000000000002";
const request = (token?: string) => new Request("https://wordloop.test/api/web/bootstrap", { headers: token ? { authorization: `Bearer ${token}` } : {} });
beforeEach(() => { resetDatabaseForTests(); configureRuntimeEnv({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-service-role-secret", DEV_USER_ID: owner, WORDLOOP_WEB_TOKEN: "owner-secret" }); vi.clearAllMocks(); });
describe("private beta authentication", () => {
  it("retains the owner's credential and rejects missing or malformed credentials", async () => {
    expect(await authenticateWebUser(request("owner-secret"))).toBe(owner);
    await expect(authenticateWebUser(request())).rejects.toMatchObject({ status: 401 });
    await expect(authenticateWebUser(request("wrong"))).rejects.toMatchObject({ status: 401 });
    expect(users.getUser).not.toHaveBeenCalled();
  });
  it("uses the verified identity and rejects uninvited and anonymous accounts", async () => {
    users.getUser.mockResolvedValue({ data: { user: { id: friend } }, error: null });
    users.profile.mockResolvedValue({ data: { id: friend }, error: null });
    expect(await authenticateWebUser(request("signed.jwt.token"))).toBe(friend);
    users.profile.mockResolvedValue({ data: null, error: null });
    await expect(authenticateWebUser(request("signed.jwt.token"))).rejects.toMatchObject({ status: 403 });
    users.getUser.mockResolvedValue({ data: { user: { id: friend, is_anonymous: true } }, error: null });
    await expect(authenticateWebUser(request("signed.jwt.token"))).rejects.toMatchObject({ status: 401 });
  });
  it("rejects expired tokens without falling back to the owner", async () => {
    users.getUser.mockResolvedValue({ data: { user: null }, error: { message: "expired" } });
    await expect(authenticateWebUser(request("expired.jwt.token"))).rejects.toMatchObject({ status: 401 });
  });
  it("keeps concurrent asynchronous work and nested calls isolated", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = withUserIdentity(owner, async () => { await pending; return getAuthenticatedUserId(); });
    const second = withUserIdentity(friend, async () => { await Promise.resolve(); expect(getAuthenticatedUserId()).toBe(friend); release(); await pending; return getAuthenticatedUserId(); });
    expect(await Promise.all([first, second])).toEqual([owner, friend]);
    expect(getAuthenticatedUserId()).toBe(owner);
  });
});
