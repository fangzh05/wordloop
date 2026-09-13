import { describe, expect, it } from "vitest";
import { decodeShanbayData, unwrapShanbayPayload } from "../server/integrations/shanbay/decode.js";

describe("Shanbay payload decoding", () => {
  it("accepts already-decoded API data", () => {
    expect(unwrapShanbayPayload({ data: { objects: [{ id: 1 }] } })).toEqual({ objects: [{ id: 1 }] });
  });
  it("returns a safe decode error for malformed encrypted data", () => {
    expect(() => decodeShanbayData("bad")).toThrow("Unable to decode Shanbay response");
  });
});
