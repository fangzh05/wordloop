import { describe, expect, it } from "vitest";
import { mobileLoginResponse, mobileLoginUrl } from "../src/mobileLogin.js";

describe("mobile login credential handling", () => {
  it("keeps the signed remote URL in a fragment, outside HTTP paths and queries", () => {
    const live = "https://live.browser.run/ui/view?mode=tab&wss=live.browser.run%2Fapi%2Fpage%2Ffixture%3Fjwt%3Dfixture";
    const url = new URL(mobileLoginUrl("https://bridge.example", live));
    expect(url.pathname).toBe("/login"); expect(url.search).toBe("");
    expect(decodeURIComponent(url.hash.slice(1))).toBe(live);
    expect(() => mobileLoginUrl(url.origin, "https://evil.example/?wss=fixture")).toThrow();
  });
  it("serves the keyboard without caching or referring the credential to other pages", async () => {
    const response = mobileLoginResponse();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("connect-src wss://live.browser.run");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
  });
});
