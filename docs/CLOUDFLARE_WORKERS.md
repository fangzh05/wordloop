# WordLoop on Cloudflare Workers

## Current migration status

This branch replaces the GPT Sites build artifact with a Cloudflare Worker and Static Assets. It keeps the React app, Worker API, and MCP Streamable HTTP endpoint in the same deployment. The Supabase project and application schemas remain the source of truth; this workflow does not run SQL or change learner data.

The first deployment uses only the generated `workers.dev` address. `wordloop.zehaoo.top`, `test.zehaoo.top`, the Cloudflare DNS zone, and Spaceship nameservers are not configured by this repository.

## Build and deployment

```powershell
npm ci
npm run typecheck
npm test
npm run build
npx wrangler deploy
```

`wrangler.jsonc` names the Worker `wordloop-app`, enables the `workers.dev` address, sends `/health` and `/api/*` to the Worker, and serves the SPA plus widgets from `dist/assets` through the `ASSETS` binding. No custom domain or Route is configured. `server/worker.ts` is the entry point; the Express server in `server/index.ts` is not used by Wrangler.

## Worker variables and secrets

Configure these in Workers & Pages → `wordloop-app` → Settings → Variables and Secrets, or with `wrangler secret put NAME --name wordloop-app`:

| Name | Purpose |
| --- | --- |
| `SUPABASE_URL` | Existing Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only database access |
| `SUPABASE_PUBLISHABLE_KEY` | Public browser auth key returned by `/api/web/auth/config` |
| `DEV_USER_ID` | Existing owner identity used by legacy MCP calls |
| `DEEPSEEK_API_KEY` | Server-side lesson generation and semantic grading |
| `WORDLOOP_WEB_TOKEN` | Legacy owner bearer-token compatibility |
| `MERRIAM_WEBSTER_API_KEY` | Optional pronunciation audio lookup |
| `SHANBAY_IMPORT_WORKER_URL` | Optional existing import bridge URL |
| `SHANBAY_IMPORT_BRIDGE_SECRET` | Optional server-only import bridge secret |

The publishable key is exposed only through the existing public auth configuration. Service role, DeepSeek, owner ID, bearer token, and bridge credentials must remain server-side. Never put secret values in this repository or `wrangler.jsonc`.

## Data and release boundary

Do not run the generated `/setup.sql` artifact against production. Do not run Supabase migrations as part of Worker deployment. Before a future schema or domain operation, verify the active Supabase project and keep user words, FSRS, sessions, queues, attempts, Capture, and lexical records unchanged.

Keep the GPT Sites address available as a rollback entry until the new host passes authenticated study-flow and China Unicom direct-network acceptance. A `workers.dev` smoke test does not establish custom-domain or mainland reachability.
