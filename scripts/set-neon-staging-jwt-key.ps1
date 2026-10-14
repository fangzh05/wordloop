$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$nodeCode = 'import { generateKeyPairSync } from ''node:crypto''; const pair = generateKeyPairSync(''ec'', { namedCurve: ''prime256v1'' }); process.stdout.write(JSON.stringify({ ...pair.privateKey.export({ format: ''jwk'' }), kid: ''wordloop-worker-es256-v1'', alg: ''ES256'', use: ''sig'', key_ops: [''sign''] }));'
$privateJwk = & node --input-type=module -e $nodeCode
if ($LASTEXITCODE -ne 0 -or -not $privateJwk) { throw "Could not create the Neon staging signing key." }
try {
  $privateJwk | npx wrangler --config wrangler.neon-staging.jsonc secret put NEON_WORKER_JWT_PRIVATE_JWK
  if ($LASTEXITCODE -ne 0) { throw "Cloudflare did not accept the Neon staging signing key." }
  Write-Output "Neon staging signing key was stored as a Worker secret; no private key was written to disk or printed."
}
finally { $privateJwk = $null }
