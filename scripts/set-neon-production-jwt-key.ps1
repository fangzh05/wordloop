$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$existingSecrets = & npx wrangler --config wrangler.jsonc secret list
if ($LASTEXITCODE -ne 0) { throw "Could not inspect production Worker secret names." }
$existingSecretNames = @($existingSecrets | ConvertFrom-Json | ForEach-Object { $_.name })
if ($existingSecretNames -contains "NEON_WORKER_JWT_PRIVATE_JWK") {
  throw "Production Neon signing key already exists; refusing to rotate it."
}

$nodeCode = @'
import { generateKeyPairSync } from "node:crypto";
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateJwk = { ...pair.privateKey.export({ format: "jwk" }), kid: "wordloop-worker-es256-prod-v1", alg: "ES256", use: "sig", key_ops: ["sign"] };
const publicJwk = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, kid: privateJwk.kid, alg: "ES256", use: "sig", key_ops: ["verify"] };
process.stdout.write(JSON.stringify({ privateJwk, publicJwks: { keys: [publicJwk] } }));
'@
$keyMaterial = & node --input-type=module -e $nodeCode | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $keyMaterial.privateJwk -or -not $keyMaterial.publicJwks) {
  throw "Could not create the production Neon signing key."
}
$privateJwkJson = $keyMaterial.privateJwk | ConvertTo-Json -Compress -Depth 8
$publicJwksJson = $keyMaterial.publicJwks | ConvertTo-Json -Compress -Depth 8

try {
  $publicJwksJson | npx wrangler --config wrangler.neon-staging.jsonc secret put NEON_WORKER_ADDITIONAL_PUBLIC_JWKS
  if ($LASTEXITCODE -ne 0) { throw "Cloudflare did not accept the additional public JWKS on staging." }
  $privateJwkJson | npx wrangler --config wrangler.jsonc secret put NEON_WORKER_JWT_PRIVATE_JWK
  if ($LASTEXITCODE -ne 0) { throw "Cloudflare did not accept the production Neon signing key." }
  Write-Output "A unique production Neon signing key was stored in Cloudflare; only its public JWK was added to the staging JWKS. No private key was written to disk or printed."
}
finally {
  $privateJwkJson = $null
  $publicJwksJson = $null
  $keyMaterial = $null
  $nodeCode = $null
}
