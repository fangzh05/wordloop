# Personal Shanbay import

WordLoop's existing authenticated web API signs requests to this isolated Worker. A Durable Object per verified WordLoop user owns one active import job and one remote browser. Each user logs in through a short-lived Cloudflare Live View tab. The worker checks the current Shanbay book before enabling import and reads pages inside that same browser.

WordLoop persists each pending chunk with `import_vocabulary_batch_v1`, then acknowledges it to advance the remote cursor. Retries reuse the pending chunk and database writes are idempotent. Existing learning and FSRS state remain untouched. Completion, cancellation and the twenty-minute task deadline close the browser. Cookies and passwords are never stored in Durable Object storage, returned to WordLoop, or logged. Recording is disabled.

Configure `BRIDGE_SECRET` in this Worker; configure the same value as `SHANBAY_IMPORT_BRIDGE_SECRET` and the deployed URL as `SHANBAY_IMPORT_WORKER_URL` in WordLoop's server runtime. Never put them in frontend code or tracked files. Deploy using this directory's Wrangler configuration. The root WordLoop build does not bundle Puppeteer.

`probe.mjs` accepts one hidden stdin JSON object `{secret,url,input}` for a backend-only signed smoke probe. Its response may include a Live View URL, which is a credential; keep it out of logs and shared reports. Run root tests to cover signature tampering, user scope, pending retries, acknowledgement, cancellation and expiry. `scripts/qa-shanbay-import.mjs` exercises desktop/light and mobile/dark fixture UI; it does not prove real Shanbay login or database import.

Cloudflare browser quota must be available. Real acceptance still requires opening the WordLoop vocabulary page, logging in to Shanbay personally, importing a current book, checking that only that WordLoop account receives words, and verifying the browser closes. Do not confuse fixture checks or a successful Worker deployment with that acceptance.
