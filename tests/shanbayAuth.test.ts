import { afterEach, describe, expect, it } from "vitest";
import { configureRuntimeEnv, getShanbayCookie, resetDatabaseForTests } from "../server/db.js";

afterEach(() => resetDatabaseForTests());

describe("Shanbay server-side authentication", () => {
  it("canonicalizes a browser Cookie header to auth_token only", () => {
    configureRuntimeEnv({ SHANBAY_COOKIE: "foo=bar;  auth_token=secret-token; csrftoken=ignored" });
    expect(getShanbayCookie()).toBe("auth_token=secret-token");
  });

  it("accepts an auth_token= value in the token setting", () => {
    configureRuntimeEnv({ SHANBAY_AUTH_TOKEN: "auth_token=secret-token" });
    expect(getShanbayCookie()).toBe("auth_token=secret-token");
  });
});
