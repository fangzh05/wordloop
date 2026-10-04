# Friends beta

WordLoop uses the same email/password experience as BodyLoop. There is no registration UI. A verified Supabase Auth account must also have a row in `public.users`; the latter is the beta allowlist. A signup alone cannot access WordLoop. All web requests and MCP tool calls validate identity before running, and asynchronous request context keeps each user's existing data and RPC calls separate.

## Create an account

From your existing owner session, open Settings → Friends beta. Create a friend with email, initial password and optional vocabulary. To switch yourself to email/password while preserving all existing records, tick the owner-account checkbox. Only the server-verified owner can use this operation. Share credentials yourself; no invitation messages are sent automatically.

Run `node --import tsx scripts/create-beta-user.ts` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` supplied in the environment. Supply one JSON object through hidden stdin: `email`, `password` (at least 8 characters), optional `words` array. Share the account details privately yourself. The script does not send emails. Avoid putting passwords in shell history or files.

For your own first login, set `owner: true` and supply the existing `DEV_USER_ID`. The script creates Auth with the same ID and preserves your existing vocabulary, FSRS, sessions and notes. It refuses to replace an existing Auth account. For friends, omit `owner` so each account receives its own ID. Seed a friend's chosen vocabulary with `words`; their progress starts fresh. They can also capture and promote new words from the Capture page.

## Auth configuration

Set `SUPABASE_PUBLISHABLE_KEY` in Sites. It is the only browser-visible key; never use the service-role key. In Supabase Auth URL settings, permit `https://wordloop-study.zehaoo.chatgpt.site/update-password` and set the Site URL to the WordLoop origin. Configure email delivery for first-password/forgot-password messages. Disable self-service signup in Auth settings as an additional restriction. Password sign-in works for administrator-created accounts without email delivery.

The existing owner-only `WORDLOOP_WEB_TOKEN` remains valid for integration compatibility. Never distribute it to friends. MCP discovery remains accessible, but `tools/call` requires a verified invited user's token or the owner's integration credential.

## Remove access

Ban the Auth account through the Supabase administrator interface to immediately fail `getUser` verification, then revoke its sessions. Preserve learning records unless deletion is explicitly requested.

## Verification boundaries

Unit tests cover concurrent identities, expired/anonymous/uninvited users and existing owner integration access. Production verification must also use two real test accounts to confirm cross-user reads/writes and account switching. Email recovery requires configured redirect URLs and delivery and should be tested separately from password sign-in.
