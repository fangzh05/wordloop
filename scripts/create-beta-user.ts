import "dotenv/config";
import { z } from "zod";

// Passwords arrive through stdin and the owner credential through the environment;
// account creation and Neon binding are performed together by the Worker API.
const input = z.object({ email: z.string().email(), password: z.string().min(8), owner: z.boolean().default(false), words: z.array(z.string().trim().min(1).max(100)).max(5000).default([]) }).strict();
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const account = input.parse(JSON.parse(raw));
const apiOrigin = new URL(z.string().url().parse(process.env.WORDLOOP_API_URL));
if (apiOrigin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(apiOrigin.hostname)) {
  throw new Error("WORDLOOP_API_URL must use HTTPS.");
}
if (apiOrigin.username || apiOrigin.password || apiOrigin.search || apiOrigin.hash) {
  throw new Error("WORDLOOP_API_URL must be an origin URL without credentials, query, or fragment.");
}
if (apiOrigin.pathname !== "/") {
  throw new Error("WORDLOOP_API_URL must be the Worker origin without a path.");
}
const token = z.string().min(20).parse(process.env.WORDLOOP_WEB_TOKEN);
const response = await fetch(new URL("/api/web/accounts", apiOrigin), {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(account),
});
const result = await response.json().catch(() => null) as {
  created?: boolean;
  vocabulary_imported?: boolean;
  error?: { message?: string };
  message?: string;
} | null;
if (!response.ok || !result?.created) {
  throw new Error(result?.error?.message ?? result?.message ?? "Account creation failed; no unbound account was accepted.");
}
if (result.vocabulary_imported === false) {
  throw new Error("The account was created and bound to Neon, but vocabulary import failed. Retry import separately.");
}
console.log("Beta account created and bound to the WordLoop database.");
