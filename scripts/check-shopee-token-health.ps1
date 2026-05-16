param(
  [bool]$RunSync = $false,
  [switch]$RunRefresh = $false
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$indexPath = Join-Path $repoRoot "index.html"
$index = Get-Content -Raw -Path $indexPath

$anonMatch = [regex]::Match($index, "const SUPABASE_ANON_KEY = '([^']+)'")
if (-not $anonMatch.Success) {
  throw "SUPABASE_ANON_KEY not found in index.html"
}

$anon = $anonMatch.Groups[1].Value
$headers = @{
  Authorization = "Bearer $anon"
  apikey = $anon
}

$baseOrders = "https://bpdafetvjyvvwbksvowu.supabase.co/functions/v1/shopee-orders"

function Invoke-Json([string]$Url) {
  try {
    $resp = Invoke-WebRequest -Headers $headers -Uri $Url -UseBasicParsing -TimeoutSec 120
    return ($resp.Content | ConvertFrom-Json)
  } catch {
    $response = $_.Exception.Response
    if ($null -eq $response) { throw }
    $reader = [IO.StreamReader]::new($response.GetResponseStream())
    $body = $reader.ReadToEnd()
    try { return ($body | ConvertFrom-Json) } catch { return [pscustomobject]@{ ok = $false; error = $body } }
  }
}

$syncFlag = if ($RunSync) { "1" } else { "0" }

$ordersHealth = Invoke-Json "$baseOrders/token-health?run_sync=$syncFlag"

Write-Host "orders_token_health_ok=$($ordersHealth.ok) run_sync=$syncFlag"
if ($ordersHealth.sync) {
  Write-Host "sync_synced=$($ordersHealth.sync.synced) sync_skipped=$((@($ordersHealth.sync.skipped)).Count)"
}
Write-Host "orders_probe_ok=$($ordersHealth.counters.probe_ok) orders_probe_fail=$($ordersHealth.counters.probe_fail)"

$rows = @()
if ($ordersHealth.rows) {
  $rows += @($ordersHealth.rows | Select-Object region,shop_id,merchant_id,probe_ok,probe_error,probe_message)
}
if ($rows.Count -gt 0) {
  $rows | Sort-Object region | Format-Table -AutoSize
}

if (-not $ordersHealth.ok) {
  throw "token health check failed"
}
