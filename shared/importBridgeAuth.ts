const encoder = new TextEncoder();
export async function bridgeSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}\n${body}`))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function verifyBridgeRequest(secret: string, timestamp: string, body: string, signature: string, now = Date.now()): Promise<boolean> {
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = await bridgeSignature(secret, timestamp, body);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return difference === 0;
}
