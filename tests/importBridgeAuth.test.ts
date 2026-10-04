import { describe, expect, it } from "vitest";
import { bridgeSignature, verifyBridgeRequest } from "../shared/importBridgeAuth.js";
describe("import bridge authentication", () => {
  it("binds the signature to the authenticated user, action and timestamp", async () => {
    const secret = "a-secret-shared-only-between-the-two-backends";
    const time = "1791100000000";
    const body = JSON.stringify({ userId: "user-a", action: "start" });
    const signature = await bridgeSignature(secret, time, body);
    expect(await verifyBridgeRequest(secret, time, body, signature, Number(time))).toBe(true);
    expect(await verifyBridgeRequest(secret, time, body.replace("user-a", "user-b"), signature, Number(time))).toBe(false);
    expect(await verifyBridgeRequest("another-secret", time, body, signature, Number(time))).toBe(false);
    expect(await verifyBridgeRequest(secret, time, body, signature, Number(time) + 60001)).toBe(false);
    expect(await verifyBridgeRequest(secret, time, body, "", Number(time))).toBe(false);
  });
});
