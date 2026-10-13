param(
  [string]$PgBinDirectory = "",
  [switch]$RefreshNeonConnection,
  [switch]$VerifyExistingTarget,
  [switch]$RestoreExistingTarget,
  [switch]$ReplaceExistingTarget,
  [switch]$ApplySecurityOnly,
  [string]$ExistingArchivePath = ""
)

$ErrorActionPreference = "Stop"
if (($VerifyExistingTarget -or $RestoreExistingTarget -or $ApplySecurityOnly) -and -not $ExistingArchivePath) { throw "Pass -ExistingArchivePath when verifying, restoring, or applying security to an existing backup." }
if (-not ($VerifyExistingTarget -or $RestoreExistingTarget -or $ApplySecurityOnly) -and $ExistingArchivePath) { throw "-ExistingArchivePath requires an existing-backup mode." }
if ($ApplySecurityOnly -and ($VerifyExistingTarget -or $RestoreExistingTarget -or $ReplaceExistingTarget -or $RefreshNeonConnection)) { throw "Choose security-only mode by itself." }
if ($VerifyExistingTarget -and ($RestoreExistingTarget -or $ReplaceExistingTarget)) { throw "Choose either verification-only or a restore mode." }
if ($RestoreExistingTarget -and $ReplaceExistingTarget) { throw "Choose either an existing-backup restore or a new export-and-replace mode." }

$businessSchemas = @(
  "public",
  "exam_expansion_audit",
  "exam_release_backup_20261011",
  "commercial_import_backup_20261011",
  "commercial_import_admin"
)
$sourceHost = "db.jgzzrlnmakllhurjiazh.supabase.co"
$sourcePort = "5432"
$sourceDatabase = "postgres"
$sourceUser = "postgres"
$parallelDumpJobs = 4
$parallelRestoreJobs = 2

if (-not $PgBinDirectory) {
  $portable = Join-Path $env:USERPROFILE ".codex\tools\postgresql-17.11\pgsql\bin"
  $installed = "C:\Program Files\PostgreSQL\17\bin"
  if (Test-Path (Join-Path $portable "pg_dump.exe")) { $PgBinDirectory = $portable }
  elseif (Test-Path (Join-Path $installed "pg_dump.exe")) { $PgBinDirectory = $installed }
}
if (-not $PgBinDirectory -or -not (Test-Path (Join-Path $PgBinDirectory "pg_dump.exe")) -or -not (Test-Path (Join-Path $PgBinDirectory "pg_restore.exe")) -or -not (Test-Path (Join-Path $PgBinDirectory "psql.exe"))) {
  throw "PostgreSQL 17 client tools are required. Pass -PgBinDirectory pointing to the folder containing pg_dump.exe, pg_restore.exe and psql.exe."
}
$pgDump = Join-Path $PgBinDirectory "pg_dump.exe"
$pgRestore = Join-Path $PgBinDirectory "pg_restore.exe"
$psql = Join-Path $PgBinDirectory "psql.exe"

function Get-DirectoryArchiveDigest([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "The parallel pg_dump archive directory is missing."
  }
  $root = [IO.Path]::GetFullPath($Path)
  $files = @(Get-ChildItem -LiteralPath $root -File -Recurse | Sort-Object -Property FullName)
  if ($files.Count -lt 2 -or -not (Test-Path -LiteralPath (Join-Path $root "toc.dat") -PathType Leaf)) {
    throw "The parallel pg_dump archive is incomplete or has no TOC."
  }

  $incrementalHash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
  [Int64]$totalBytes = 0
  try {
    foreach ($file in $files) {
      $relativePath = [IO.Path]::GetRelativePath($root, $file.FullName).Replace([char]92, '/')
      $fileHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $totalBytes += [Int64]$file.Length
      $recordText = $relativePath + [char]9 + [string]$file.Length + [char]9 + $fileHash + [char]10
      $record = [Text.Encoding]::UTF8.GetBytes($recordText)
      $incrementalHash.AppendData($record)
    }
    $digest = [Convert]::ToHexString($incrementalHash.GetHashAndReset()).ToLowerInvariant()
    return [pscustomobject]@{ Sha256 = $digest; Bytes = $totalBytes; Files = $files.Count }
  }
  finally {
    $incrementalHash.Dispose()
  }
}
function Read-SecretText([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$credentialStorePath = Join-Path $env:LOCALAPPDATA "WordLoop\NeonMigration\credentials.dpapi"
$credentialStoreEntropy = [Text.Encoding]::UTF8.GetBytes("wordloop-neon-migration-credentials-v1")
function Set-PrivateMigrationAcl([string]$Path, [Security.Principal.SecurityIdentifier]$UserSid, [switch]$Directory) {
  $icaclsPath = Join-Path $env:SystemRoot "System32\icacls.exe"
  $grant = '*' + $UserSid.Value + $(if ($Directory) { ':(OI)(CI)F' } else { ':F' })
  & $icaclsPath $Path "/inheritance:r" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not disable inherited permissions on the encrypted credential store." }
  & $icaclsPath $Path "/grant:r" $grant | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not restrict permissions on the encrypted credential store." }
}

function Set-SavedMigrationCredentials([string]$SourcePassword, [string]$NeonConnectionString) {
  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop
  $credentialDirectory = Split-Path -Parent $credentialStorePath
  [void](New-Item -ItemType Directory -Path $credentialDirectory -Force)

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  Set-PrivateMigrationAcl $credentialDirectory $currentSid -Directory

  $payload = [ordered]@{
    version = 1
    sourcePassword = $SourcePassword
    neonConnectionString = $NeonConnectionString
  } | ConvertTo-Json -Compress
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $cipherBytes = $null
  try {
    $cipherBytes = [Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $credentialStoreEntropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllBytes($credentialStorePath, $cipherBytes)
    Set-PrivateMigrationAcl $credentialStorePath $currentSid
  }
  finally {
    if ($cipherBytes) { [Array]::Clear($cipherBytes, 0, $cipherBytes.Length) }
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    $payload = $null
  }
}

function Get-SavedMigrationCredentials {
  if (Test-Path -LiteralPath $credentialStorePath) {
    Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop
    $cipherBytes = [IO.File]::ReadAllBytes($credentialStorePath)
    $plainBytes = $null
    try {
      $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $cipherBytes,
        $credentialStoreEntropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      $saved = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json -AsHashtable
      if ($saved.version -ne 1 -or -not $saved.sourcePassword -or -not $saved.neonConnectionString) {
        throw "The protected credential record is incomplete or has an unsupported version."
      }
      return @{ SourcePassword = [string]$saved.sourcePassword; NeonConnectionString = [string]$saved.neonConnectionString }
    }
    catch {
      throw "Could not decrypt the saved migration credentials for this Windows account. Run the script under the account that saved them, or remove the protected credential file and re-enter them."
    }
    finally {
      [Array]::Clear($cipherBytes, 0, $cipherBytes.Length)
      if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
      $saved = $null
    }
  }

  $sourcePassword = Read-SecretText "Supabase direct Postgres password (input is hidden)"
  $neonConnectionString = Read-SecretText "Neon direct connection string (input is hidden; use the non-pooler URL)"
  if (-not $sourcePassword -or -not $neonConnectionString) { throw "Both migration credentials are required." }
  $null = Parse-TargetConnection $neonConnectionString
  Set-SavedMigrationCredentials $sourcePassword $neonConnectionString
  Write-Host "Migration credentials are encrypted for this Windows user; future retries will reuse them."
  return @{ SourcePassword = $sourcePassword; NeonConnectionString = $neonConnectionString }
}

function Get-PgConnection([string]$HostName, [string]$Port, [string]$UserName, [string]$Database, [string]$Password) {
  return @{ Host = $HostName; Port = $Port; User = $UserName; Database = $Database; Password = $Password }
}

function Parse-TargetConnection([string]$ConnectionString) {
  $uri = [Uri]$ConnectionString
  if ($uri.Scheme -notin @("postgres", "postgresql")) { throw "The Neon connection string must use postgresql://." }
  if ($uri.Host -match "-pooler(?:\.|$)") { throw "Use the Neon direct connection string for restore and validation, not the pooled connection string." }
  $userInfo = [Uri]::UnescapeDataString($uri.UserInfo)
  $separator = $userInfo.IndexOf(":")
  if ($separator -lt 1) { throw "The Neon connection string must include its username and password." }
  $database = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart("/"))
  if (-not $database) { throw "The Neon connection string must include its database name." }
  return @{
    Host = $uri.Host
    Port = if ($uri.IsDefaultPort) { "5432" } else { [string]$uri.Port }
    User = $userInfo.Substring(0, $separator)
    Password = $userInfo.Substring($separator + 1)
    Database = $database
  }
}

function New-PgProcess([string]$Executable, [string[]]$Arguments, [hashtable]$Connection) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Executable
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.RedirectStandardInput = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8
  $info.StandardErrorEncoding = [Text.Encoding]::UTF8
  foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
  $info.EnvironmentVariables["PGHOST"] = $Connection.Host
  $info.EnvironmentVariables["PGPORT"] = $Connection.Port
  $info.EnvironmentVariables["PGUSER"] = $Connection.User
  $info.EnvironmentVariables["PGDATABASE"] = $Connection.Database
  $info.EnvironmentVariables["PGPASSWORD"] = $Connection.Password
  $info.EnvironmentVariables["PGSSLMODE"] = "require"
  $info.EnvironmentVariables["PGCLIENTENCODING"] = "UTF8"
  # PostgreSQL text output must preserve every float8 bit during COPY/restore.
  $info.EnvironmentVariables["PGOPTIONS"] = "-c extra_float_digits=3"
  $info.EnvironmentVariables["PGAPPNAME"] = "wordloop-neon-migration"
  if ($Connection.ServiceName -and $Connection.ServiceFile) {
    $info.EnvironmentVariables["PGSERVICE"] = $Connection.ServiceName
    $info.EnvironmentVariables["PGSERVICEFILE"] = $Connection.ServiceFile
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  if (-not $process.Start()) { throw "Could not start $([IO.Path]::GetFileName($Executable))." }
  return $process
}

function Invoke-PgTool([string]$Executable, [string[]]$Arguments, [hashtable]$Connection) {
  $process = New-PgProcess $Executable $Arguments $Connection
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) {
    $logPath = Join-Path $backupDirectory "last-command-error.log"
    if ($stderr) { $stderr | Set-Content -LiteralPath $logPath -Encoding utf8 }
    throw "$([IO.Path]::GetFileName($Executable)) failed (exit code $($process.ExitCode)); diagnostic output is in the access-restricted backup folder."
  }
  return $stdout
}

function Read-PsqlResult([Diagnostics.Process]$Process, [string]$Sql) {
  $marker = "__WORDLOOP_END_$([Guid]::NewGuid().ToString('N'))__"
  $Process.StandardInput.WriteLine($Sql)
  $Process.StandardInput.WriteLine("\echo $marker")
  $Process.StandardInput.Flush()
  $result = [Collections.Generic.List[string]]::new()
  while ($null -ne ($line = $Process.StandardOutput.ReadLine())) {
    if ($line -ceq $marker) { return @($result.ToArray()) }
    $result.Add($line)
  }
  $errorOutput = $Process.StandardError.ReadToEnd()
  throw "Source/target SQL session ended unexpectedly. $($errorOutput.Trim())"
}

function Get-PsqlTableDigest([Diagnostics.Process]$Process, [string]$SchemaName, [string]$TableName) {
  $schemaSql = '"' + $SchemaName.Replace('"', '""') + '"'
  $tableSql = '"' + $TableName.Replace('"', '""') + '"'
  $cursorName = "wordloop_digest_$([Guid]::NewGuid().ToString('N'))"
  $collation = [char]34 + "C" + [char]34
  $setupSql = "SET LOCAL statement_timeout = 0; SET LOCAL idle_in_transaction_session_timeout = 0; SET LOCAL extra_float_digits = 3; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'; SET LOCAL bytea_output = 'hex';"
  $cursorSql = "DECLARE $cursorName NO SCROLL CURSOR FOR SELECT to_jsonb(row_data)::text FROM $schemaSql.$tableSql AS row_data ORDER BY to_jsonb(row_data)::text COLLATE $collation;"
  [void](Read-PsqlResult $Process ($setupSql + [char]10 + $cursorSql))
  $countResult = @(Read-PsqlResult $Process "SELECT count(*) FROM $schemaSql.$tableSql;")
  if ($countResult.Count -ne 1 -or $countResult[0] -notmatch '^\d+$') { throw "Could not read row count for $SchemaName.$TableName." }
  $rowCount = [Int64]$countResult[0]
  $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
  [Int64]$streamedRows = 0
  $batchSize = 1000
  try {
    while ($true) {
      $marker = "__WORDLOOP_COPY_END_$([Guid]::NewGuid().ToString('N'))__"
      $Process.StandardInput.WriteLine("FETCH FORWARD $batchSize FROM $cursorName;")
      $Process.StandardInput.WriteLine("\echo $marker")
      $Process.StandardInput.Flush()
      [Int64]$batchRows = 0
      $markerFound = $false
      while ($null -ne ($line = $Process.StandardOutput.ReadLine())) {
        if ($line -ceq $marker) { $markerFound = $true; break }
        $hash.AppendData([Text.Encoding]::UTF8.GetBytes($line + [char]10))
        $streamedRows++
        $batchRows++
      }
      if (-not $markerFound) {
        $errorOutput = $Process.StandardError.ReadToEnd()
        throw "Could not hash $SchemaName.$TableName. $($errorOutput.Trim())"
      }
      if ($batchRows -lt $batchSize) { break }
    }
    if ($streamedRows -ne $rowCount) { throw "Row stream count differs for $SchemaName.$TableName ($rowCount versus $streamedRows)." }
    [void](Read-PsqlResult $Process "CLOSE $cursorName;")
    $hex = [Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant()
    return @{ Rows = $rowCount; Sha256 = $hex }
  }
  finally { $hash.Dispose() }
}

function Export-PsqlTableCopy([Diagnostics.Process]$Process, [string]$SchemaName, [string]$TableName, [string]$Path) {
  $schemaSql = '"' + $SchemaName.Replace('"', '""') + '"'
  $tableSql = '"' + $TableName.Replace('"', '""') + '"'
  $marker = "__WORDLOOP_TABLE_COPY_END_$([Guid]::NewGuid().ToString('N'))__"
  $writer = [IO.StreamWriter]::new($Path, $false, [Text.UTF8Encoding]::new($false))
  [Int64]$rowCount = 0
  $completed = $false
  try {
    $Process.StandardInput.WriteLine("COPY (SELECT * FROM $schemaSql.$tableSql) TO STDOUT;")
    $Process.StandardInput.WriteLine("\echo $marker")
    $Process.StandardInput.Flush()
    while ($null -ne ($line = $Process.StandardOutput.ReadLine())) {
      if ($line -ceq $marker) { $completed = $true; break }
      if ($line -match '^COPY \d+$') { continue }
      $writer.WriteLine($line)
      $rowCount++
    }
    if (-not $completed) {
      $errorOutput = $Process.StandardError.ReadToEnd()
      throw "Could not export the pinned $SchemaName.$TableName snapshot. $($errorOutput.Trim())"
    }
    return $rowCount
  }
  finally {
    $writer.Flush()
    $writer.Dispose()
  }
}

function Import-PsqlTableCopy([Diagnostics.Process]$Process, [string]$SchemaName, [string]$TableName, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "The pinned table COPY sidecar is missing." }
  $schemaSql = '"' + $SchemaName.Replace('"', '""') + '"'
  $tableSql = '"' + $TableName.Replace('"', '""') + '"'
  $marker = "__WORDLOOP_TABLE_IMPORT_END_$([Guid]::NewGuid().ToString('N'))__"
  $Process.StandardInput.WriteLine("COPY $schemaSql.$tableSql FROM STDIN;")
  foreach ($line in [IO.File]::ReadLines($Path, [Text.Encoding]::UTF8)) {
    $Process.StandardInput.WriteLine($line)
  }
  $Process.StandardInput.WriteLine("\.")
  $Process.StandardInput.WriteLine("\echo $marker")
  $Process.StandardInput.Flush()
  while ($null -ne ($line = $Process.StandardOutput.ReadLine())) {
    if ($line -ceq $marker) { return }
  }
  $errorOutput = $Process.StandardError.ReadToEnd()
  throw "Could not import the pinned $SchemaName.$TableName snapshot into Neon. $($errorOutput.Trim())"
}

function Get-BusinessTableList([Diagnostics.Process]$Process) {
  $schemaList = ($businessSchemas | ForEach-Object { "'$_'" }) -join ","
  $sql = "SELECT n.nspname || E'\t' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname IN ($schemaList) ORDER BY n.nspname, c.relname;"
  $lines = @(Read-PsqlResult $Process $sql)
  return @($lines | Where-Object { $_ } | ForEach-Object {
    $parts = $_ -split "`t", 2
    if ($parts.Count -ne 2) { throw "Unexpected table inventory output." }
    @{ Schema = $parts[0]; Table = $parts[1] }
  })
}

function Stop-PgSession([Diagnostics.Process]$Process) {
  if ($Process.HasExited) { return }
  $Process.StandardInput.WriteLine("ROLLBACK;")
  $Process.StandardInput.WriteLine("\\q")
  $Process.StandardInput.Flush()
  $Process.WaitForExit()
  $null = $Process.StandardOutput.ReadToEnd()
  $null = $Process.StandardError.ReadToEnd()
  $Process.Dispose()
}

if ($RefreshNeonConnection) {
  $savedCredentials = Get-SavedMigrationCredentials
  $updatedNeonConnectionString = $null
  try {
    $updatedNeonConnectionString = Read-SecretText "Updated Neon direct connection string (input is hidden; use the non-pooler URL)"
    if (-not $updatedNeonConnectionString) { throw "The updated Neon connection string is required." }
    $null = Parse-TargetConnection $updatedNeonConnectionString
    Set-SavedMigrationCredentials $savedCredentials.SourcePassword $updatedNeonConnectionString
    Write-Output "Updated Neon connection string is encrypted for this Windows user. Supabase credentials were reused."
  }
  finally {
    if ($savedCredentials) { $savedCredentials.SourcePassword = $null; $savedCredentials.NeonConnectionString = $null }
    $savedCredentials = $null
    $updatedNeonConnectionString = $null
  }
  return
}

if ((& $pgDump --version) -notmatch ' 17\.') { throw "PostgreSQL 17 pg_dump is required because both databases run PostgreSQL 17." }

$backupRoot = Join-Path $env:USERPROFILE ".codex\secure-backups\wordloop"
if ($VerifyExistingTarget -or $RestoreExistingTarget -or $ApplySecurityOnly) {
  $archivePath = (Resolve-Path -LiteralPath $ExistingArchivePath -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath $archivePath -PathType Container)) { throw "The existing directory archive path is not a directory." }
  $archiveDirectoryName = [IO.Path]::GetFileName($archivePath)
  if ($archiveDirectoryName -notmatch '^wordloop-complete-(\d{8}-\d{6})\.dir$') { throw "The existing archive folder name is not recognized." }
  $timestamp = $Matches[1]
  $backupDirectory = Split-Path -Parent $archivePath
} else {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupDirectory = Join-Path $backupRoot $timestamp
  $archivePath = Join-Path $backupDirectory "wordloop-complete-$timestamp.dir"
}
$bktSidecarSha256 = $null
$bktSidecarBytes = [Int64]0
$bktSidecarRows = [Int64]0
[void](New-Item -ItemType Directory -Path $backupDirectory -Force)
$bktSidecarPath = Join-Path $backupDirectory "bkt_updates.copy"
if (($VerifyExistingTarget -or $RestoreExistingTarget) -and (Test-Path -LiteralPath $bktSidecarPath -PathType Leaf)) {
  $bktSidecarSha256 = (Get-FileHash -LiteralPath $bktSidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $bktSidecarBytes = [Int64](Get-Item -LiteralPath $bktSidecarPath).Length
  $bktSidecarRows = [Int64](@([IO.File]::ReadLines($bktSidecarPath, [Text.Encoding]::UTF8)).Count)
}
if ($RestoreExistingTarget -and -not $bktSidecarSha256) { throw "The existing backup has no verified BKT sidecar; refusing to restore it." }
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
Set-PrivateMigrationAcl $backupDirectory $currentSid -Directory

$savedCredentials = Get-SavedMigrationCredentials
$sourcePassword = $savedCredentials.SourcePassword
$neonConnectionString = $savedCredentials.NeonConnectionString
$savedCredentials = $null
$null = Parse-TargetConnection $neonConnectionString
$source = Get-PgConnection $sourceHost $sourcePort $sourceUser $sourceDatabase $sourcePassword
$target = Parse-TargetConnection $neonConnectionString
$serviceFile = Join-Path $backupDirectory "pg_service.conf"
$serviceContent = @"
[wordloop_migration_source]
host=$($source.Host)
port=$($source.Port)
user=$($source.User)
dbname=$($source.Database)
sslmode=require
keepalives_idle=30
keepalives_interval=10

[wordloop_migration_target]
host=$($target.Host)
port=$($target.Port)
user=$($target.User)
dbname=$($target.Database)
sslmode=require
keepalives_idle=30
keepalives_interval=10
"@
[IO.File]::WriteAllText($serviceFile, $serviceContent, [Text.UTF8Encoding]::new($false))
$source.ServiceName = "wordloop_migration_source"
$source.ServiceFile = $serviceFile
$target.ServiceName = "wordloop_migration_target"
$target.ServiceFile = $serviceFile
$sourceSession = $null
$targetSession = $null

try {
  if ($ApplySecurityOnly) {
    $securityMigration = Join-Path $PSScriptRoot "..\neon\migrations\0001_data_api_security.sql"
    Invoke-PgTool $psql @("-X", "-v", "ON_ERROR_STOP=1", "--file=$securityMigration") $target | Out-Null
    $securitySummary = Invoke-PgTool $psql @("-X", "-qAt", "-c", "SELECT count(*) FROM pg_tables WHERE schemaname='public'; SELECT count(*) FROM pg_policies WHERE schemaname='public';") $target
    $securityLines = @($securitySummary -split "\r?\n" | Where-Object { $_ -match '^\d+$' })
    if ($securityLines.Count -ne 2 -or [Int64]$securityLines[0] -lt 50 -or [Int64]$securityLines[1] -lt 35) {
      throw "Neon table grants or RLS policies are incomplete after applying the security migration."
    }
    Write-Output "Neon security migration applied; public tables=$($securityLines[0]), RLS policies=$($securityLines[1])."
    return
  }

  if ($VerifyExistingTarget -or $RestoreExistingTarget) {
    $sourceSession = New-PgProcess $psql @("-X", "-qAt", "-v", "ON_ERROR_STOP=1") $source
    $snapshotSql = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" + [char]10 + "SELECT pg_export_snapshot();"
    $snapshotLines = @(Read-PsqlResult $sourceSession $snapshotSql)
    if ($snapshotLines.Count -ne 1 -or $snapshotLines[0] -notmatch '^[A-Za-z0-9_-]{1,128}$') {
      throw "Could not pin a consistent read-only Supabase snapshot for existing-target verification."
    }
    $snapshotId = $snapshotLines[0]
    [void](Read-PsqlResult $sourceSession "SET LOCAL idle_in_transaction_session_timeout = 0;")
    if ($VerifyExistingTarget) {
      Write-Output "Verifying the existing Neon restore against a read-only Supabase snapshot."
    } else {
      Write-Output "Restoring the retained protected backup to Neon staging; Supabase remains read-only."
    }
  } else {
  $backupAttempt = 0
  while ($true) {
    $backupAttempt++
    try {
      if ($sourceSession) {
        if (-not $sourceSession.HasExited) { $sourceSession.Kill(); $sourceSession.WaitForExit() }
        $sourceSession.Dispose()
        $sourceSession = $null
      }
      if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force -Recurse }
      if (Test-Path -LiteralPath $bktSidecarPath) { Remove-Item -LiteralPath $bktSidecarPath -Force }
      $sourceSession = New-PgProcess $psql @("-X", "-qAt", "-v", "ON_ERROR_STOP=1") $source
      $snapshotLines = @(Read-PsqlResult $sourceSession "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;`nSELECT pg_export_snapshot();")
      if ($snapshotLines.Count -ne 1 -or $snapshotLines[0] -notmatch '^[A-Za-z0-9_-]{1,128}$') {
        throw "Could not pin a consistent read-only Supabase snapshot; expected one safe snapshot identifier, received $($snapshotLines.Count) output line(s)."
      }
      $snapshotId = $snapshotLines[0]
    [void](Read-PsqlResult $sourceSession "SET LOCAL idle_in_transaction_session_timeout = 0;")

      $bktSidecarRows = Export-PsqlTableCopy $sourceSession "public" "bkt_updates" $bktSidecarPath
      Set-PrivateMigrationAcl $bktSidecarPath $currentSid
      $bktSnapshotDigest = Get-PsqlTableDigest $sourceSession "public" "bkt_updates"
      if ($bktSidecarRows -ne $bktSnapshotDigest.Rows) {
        throw "The BKT sidecar row count differs from the pinned Supabase snapshot."
      }
      $bktSidecarSha256 = (Get-FileHash -LiteralPath $bktSidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
      $bktSidecarBytes = [Int64](Get-Item -LiteralPath $bktSidecarPath).Length

      Invoke-PgTool $pgDump @("--format=directory", "--jobs=$parallelDumpJobs", "--file=$archivePath", "--snapshot=$snapshotId", "--exclude-table-data=public.bkt_updates", "--no-password", "--host=$sourceHost", "--port=$sourcePort", "--username=$sourceUser", "--dbname=$sourceDatabase") $source | Out-Null
      Write-Output "Consistent Supabase backup completed on attempt $backupAttempt."
      break
    }
    catch {
      $failureText = $_.Exception.Message
      $errorLogPath = Join-Path $backupDirectory "last-command-error.log"
      if (Test-Path -LiteralPath $errorLogPath) {
        $failureText += "`n" + (Get-Content -LiteralPath $errorLogPath -Raw)
        $attemptLogPath = Join-Path $backupDirectory ("backup-attempt-{0:D4}.log" -f $backupAttempt)
        Copy-Item -LiteralPath $errorLogPath -Destination $attemptLogPath -Force
      }
      if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force -Recurse }
      if ($sourceSession) {
        try {
          if (-not $sourceSession.HasExited) { $sourceSession.Kill(); $sourceSession.WaitForExit() }
          $sourceSession.Dispose()
        }
        catch { }
        $sourceSession = $null
      }

      $transientNetworkFailure = $failureText -match '(?i)(SSL SYSCALL error|connection reset by peer|unexpected EOF|server closed the connection unexpectedly|connection timed out|could not connect to server|network is unreachable|no route to host|connection refused|broken pipe|connection failure)'
      if (-not $transientNetworkFailure) { throw }

      $delaySeconds = [Math]::Min(300, [Math]::Max(15, 15 * [Math]::Pow(2, [Math]::Min(4, $backupAttempt - 1))))
      Write-Warning "Supabase snapshot/backup hit a transient network failure (attempt $backupAttempt). Retrying in $delaySeconds seconds; the same credentials remain only in this process."
      Start-Sleep -Seconds ([int]$delaySeconds)
    }
  }

  }
  $archiveTocText = Invoke-PgTool $pgRestore @("--list", $archivePath) $target
  $archiveToc = @($archiveTocText -split "\r?\n")
  $archiveEntries = @($archiveToc | Where-Object { $_ -match '^\d+;' })
  if ($archiveEntries.Count -lt 100) { throw "The full Supabase archive is unexpectedly small or incomplete ($($archiveEntries.Count) archive entries)." }
  $policyTocEntries = @($archiveToc | Where-Object { $_ -match '^\d+;.*\sPOLICY\s' })
  if ($policyTocEntries.Count -lt 5) { throw "The archive policy entries could not be identified; refusing to restore an unreviewed Supabase policy set." }
  if (-not $VerifyExistingTarget) {
    $bktDataEntries = @($archiveToc | Where-Object { $_ -match '^\d+;.*\sTABLE DATA public bkt_updates(?:\s|$)' })
    if ($bktDataEntries.Count -gt 0) { throw "The parallel archive unexpectedly contains BKT rows; refusing to restore a second, potentially stale copy." }
  }
  $filteredToc = @($archiveToc | ForEach-Object {
    if ($_ -match '^\d+;.*\sPOLICY\s') { ";$_" } else { $_ }
  })
  $tocListPath = Join-Path $backupDirectory "restore-business-toc.list"
  [IO.File]::WriteAllLines($tocListPath, $filteredToc, [Text.UTF8Encoding]::new($false))
  $archiveDigest = Get-DirectoryArchiveDigest $archivePath
  $archiveHash = $archiveDigest.Sha256
  $archiveBytes = $archiveDigest.Bytes
  $dumpVersion = (& $pgDump --version).Trim()

  $targetEmpty = Invoke-PgTool $psql @("-X", "-qAt", "-c", "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','exam_expansion_audit','exam_release_backup_20261011','commercial_import_backup_20261011','commercial_import_admin');") $target
  if ($VerifyExistingTarget) {
    if ($targetEmpty.Trim() -eq "0") { throw "The Neon target has no existing business tables to verify." }
    Write-Output "Existing Neon business tables found; skipping bootstrap and restore."
  } else {
  if ($targetEmpty.Trim() -ne "0" -and -not ($ReplaceExistingTarget -or $RestoreExistingTarget)) { throw "The Neon target already contains business tables; pass -ReplaceExistingTarget only for an unaccepted staging copy." }
  if (($ReplaceExistingTarget -or $RestoreExistingTarget) -and $targetEmpty.Trim() -ne "0") {
    Write-Output "Replacing only the unaccepted Neon staging business objects; the Supabase source remains untouched."
  }

  $bootstrapSql = @'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA IF NOT EXISTS exam_expansion_audit;
CREATE SCHEMA IF NOT EXISTS exam_release_backup_20261011;
CREATE SCHEMA IF NOT EXISTS commercial_import_backup_20261011;
CREATE SCHEMA IF NOT EXISTS commercial_import_admin;
SELECT auth.user_id();
'@
  Invoke-PgTool $psql @("-X", "-v", "ON_ERROR_STOP=1", "-c", $bootstrapSql) $target | Out-Null

  $restoreArgs = @("--exit-on-error", "--no-owner", "--no-acl", "--jobs=$parallelRestoreJobs", "--dbname=$($target.Database)", "--use-list=$tocListPath")
  foreach ($schema in $businessSchemas) { $restoreArgs += "--schema=$schema" }
  if ($ReplaceExistingTarget -or $RestoreExistingTarget) {
    $restoreArgs += "--clean"
    $restoreArgs += "--if-exists"
  }
  $restoreArgs += $archivePath
  Invoke-PgTool $pgRestore $restoreArgs $target | Out-Null

  }
  $targetSession = New-PgProcess $psql @("-X", "-qAt", "-v", "ON_ERROR_STOP=1") $target

  if (-not $VerifyExistingTarget) {
    Import-PsqlTableCopy $targetSession "public" "bkt_updates" $bktSidecarPath
    $targetBktRows = @(Read-PsqlResult $targetSession "SELECT count(*) FROM public.bkt_updates;")
    if ($targetBktRows.Count -ne 1 -or $targetBktRows[0] -notmatch '^\d+$' -or [Int64]$targetBktRows[0] -ne $bktSidecarRows) {
      throw "The BKT rows restored from the pinned sidecar do not match its exported row count."
    }
  }
  $sourceTables = @(Get-BusinessTableList $sourceSession)
  $targetTables = @(Get-BusinessTableList $targetSession)
  $sourceNames = @($sourceTables | ForEach-Object { "$($_.Schema).$($_.Table)" })
  $targetNames = @($targetTables | ForEach-Object { "$($_.Schema).$($_.Table)" })
  if (Compare-Object $sourceNames $targetNames) { throw "Source and Neon business table inventories do not match." }

  if (-not $targetSession.HasExited) {
    $targetSession.Kill()
    $targetSession.WaitForExit()
  }
  $null = $targetSession.StandardOutput.ReadToEnd()
  $null = $targetSession.StandardError.ReadToEnd()
  $targetSession.Dispose()
  $targetSession = $null

  $tableResults = [Collections.Generic.List[object]]::new()
  foreach ($entry in $sourceTables) {
    $sourceDigest = Get-PsqlTableDigest $sourceSession $entry.Schema $entry.Table
    $targetDigest = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      $targetDigestSession = $null
      try {
        $targetDigestSession = New-PgProcess $psql @("-X", "-qAt", "-v", "ON_ERROR_STOP=1") $target
        [void](Read-PsqlResult $targetDigestSession "BEGIN ISOLATION LEVEL REPEATABLE READ;")
        $targetDigest = Get-PsqlTableDigest $targetDigestSession $entry.Schema $entry.Table
        [void](Read-PsqlResult $targetDigestSession "COMMIT;")
        break
      }
      catch {
        $connectionError = $_.Exception.Message
        $transientNeonDrop = $connectionError -match '(?i)(server closed the connection unexpectedly|connection to server .* failed|SSL SYSCALL error: EOF detected|could not receive data from server)'
        if ($attempt -ge 3 -or -not $transientNeonDrop) { throw }
        Write-Output "Neon connection dropped while verifying $($entry.Schema).$($entry.Table); retrying that table ($attempt/3)."
        Start-Sleep -Seconds (2 * $attempt)
      }
      finally {
        if ($targetDigestSession) {
          try {
            if (-not $targetDigestSession.HasExited) {
              $targetDigestSession.Kill()
              $targetDigestSession.WaitForExit()
            }
          } catch {}
          try {
            $null = $targetDigestSession.StandardOutput.ReadToEnd()
            $null = $targetDigestSession.StandardError.ReadToEnd()
          } catch {}
          $targetDigestSession.Dispose()
        }
      }
    }
    if (-not $targetDigest) { throw "Neon digest was not collected for $($entry.Schema).$($entry.Table)." }
    if ($sourceDigest.Rows -ne $targetDigest.Rows -or $sourceDigest.Sha256 -ne $targetDigest.Sha256) {
      throw "Data verification failed for $($entry.Schema).$($entry.Table) (Supabase rows=$($sourceDigest.Rows), SHA-256=$($sourceDigest.Sha256); Neon rows=$($targetDigest.Rows), SHA-256=$($targetDigest.Sha256))."
    }
    $tableResults.Add([ordered]@{
      table = "$($entry.Schema).$($entry.Table)"
      rows = $sourceDigest.Rows
      sha256 = $sourceDigest.Sha256
      equal = $true
    })
    Write-Output "Verified $($entry.Schema).$($entry.Table): $($sourceDigest.Rows) rows match."
  }


  $securityMigration = Join-Path $PSScriptRoot "..\neon\migrations\0001_data_api_security.sql"
  Invoke-PgTool $psql @("-X", "-v", "ON_ERROR_STOP=1", "--file=$securityMigration") $target | Out-Null
  $securitySummary = Invoke-PgTool $psql @("-X", "-qAt", "-c", "SELECT count(*) FROM pg_tables WHERE schemaname='public'; SELECT count(*) FROM pg_policies WHERE schemaname='public';") $target
  $securityLines = @($securitySummary -split "\r?\n" | Where-Object { $_ -match '^\d+$' })
  if ($securityLines.Count -ne 2 -or [Int64]$securityLines[0] -lt 50 -or [Int64]$securityLines[1] -lt 35) {
    throw "Neon table grants or RLS policies are incomplete after applying the security migration."
  }

  $sourceAuthCount = @(Read-PsqlResult $sourceSession "SELECT count(*) FROM auth.users;")
  $sourceProfileCount = @(Read-PsqlResult $sourceSession "SELECT count(*) FROM public.users;")
  $authLinkCount = @(Read-PsqlResult $sourceSession "SELECT count(*) FROM auth.users a JOIN public.users u ON u.id = a.id;")
  $verificationDescription = if ($VerifyExistingTarget) {
    "business table row counts and canonical row digests matched the current read-only Supabase snapshot after restoring the retained archive"
  } elseif ($RestoreExistingTarget) {
    "business table row counts and canonical row digests matched the retained protected backup and current read-only Supabase snapshot"
  } else {
    "all business table row counts and canonical row digests matched the exported Supabase snapshot, including the BKT sidecar"
  }
  $manifest = [ordered]@{
    created_at = (Get-Date).ToUniversalTime().ToString("o")
    source_snapshot = $snapshotId
    source_database = "Supabase PostgreSQL 17 / jgzzrlnmakllhurjiazh"
    target_project = "Neon WordLoop Production / curly-salad-19419173"
    archive_file = [IO.Path]::GetFileName($archivePath)
    archive_sha256 = $archiveHash
    archive_bytes = $archiveBytes
    bkt_sidecar_file = if ($bktSidecarSha256) { [IO.Path]::GetFileName($bktSidecarPath) } else { $null }
    bkt_sidecar_sha256 = $bktSidecarSha256
    bkt_sidecar_bytes = $bktSidecarBytes
    bkt_sidecar_rows = $bktSidecarRows
    archive_entries = $archiveEntries.Count
    skipped_supabase_policies = $policyTocEntries.Count
    pg_dump_version = $dumpVersion
    auth_users_backed_up = [Int64]$sourceAuthCount[0]
    public_profiles = [Int64]$sourceProfileCount[0]
    matching_auth_profile_ids = [Int64]$authLinkCount[0]
    business_table_count = $tableResults.Count
    public_table_count = [Int64]$securityLines[0]
    public_rls_policy_count = [Int64]$securityLines[1]
    business_tables = @($tableResults)
    verification = $verificationDescription
    supabase_auth_restored_to_neon = $false
  }
  $manifestPath = Join-Path $backupDirectory "migration-manifest.json"
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  Set-PrivateMigrationAcl $manifestPath $currentSid
  if ($VerifyExistingTarget) {
    Write-Output "Existing Neon staging restore verified. Private backup folder: $backupDirectory"
  } elseif ($RestoreExistingTarget) {
    Write-Output "Retained backup restored and verified in Neon staging. Private backup folder: $backupDirectory"
  } else {
    Write-Output "Backup and staging restore verified. Private backup folder: $backupDirectory"
  }
  Write-Output "Tables compared: $($tableResults.Count); archive SHA-256: $archiveHash"
}
finally {
  if ($targetSession) { Stop-PgSession $targetSession }
  if ($sourceSession) { Stop-PgSession $sourceSession }
  $sourcePassword = $null
  $neonConnectionString = $null
  $source.Password = $null
  $target.Password = $null
  $savedCredentials = $null
  $credentialStoreEntropy = $null
}
