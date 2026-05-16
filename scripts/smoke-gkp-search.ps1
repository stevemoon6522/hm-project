param(
  [string]$Keyword = "boynextdoor",
  [string]$Region = "SG",
  [int]$ExpectedMin = 1
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$indexPath = Join-Path $repoRoot "index.html"
$index = Get-Content -Raw -Encoding UTF8 -Path $indexPath

$anonMatch = [regex]::Match($index, "const SUPABASE_ANON_KEY = '([^']+)'")
if (-not $anonMatch.Success) {
  throw "SUPABASE_ANON_KEY not found in index.html"
}

$bridge = "https://bpdafetvjyvvwbksvowu.supabase.co/functions/v1/shopee-bridge"
$headers = @{
  Authorization = "Bearer $($anonMatch.Groups[1].Value)"
  apikey = $anonMatch.Groups[1].Value
}

function Invoke-BridgeJson([string]$Path) {
  try {
    return Invoke-RestMethod -Headers $headers -Uri "$bridge$Path" -TimeoutSec 60
  } catch {
    $response = $_.Exception.Response
    if ($null -eq $response) { throw }
    $reader = [IO.StreamReader]::new($response.GetResponseStream())
    $body = $reader.ReadToEnd()
    try {
      return ($body | ConvertFrom-Json)
    } catch {
      return [pscustomobject]@{ ok = $false; error = $body }
    }
  }
}

function Normalize-Search([string]$Value) {
  if ($null -eq $Value) { return "" }
  return ($Value.ToLowerInvariant() -replace '[^a-z0-9]', '')
}

function Test-Match($Item, [string]$Kw) {
  $text = @(
    $Item.global_item_name
    $Item.global_item_sku
    $Item.item_name
    $Item.item_sku
    $Item.global_item_id
  ) -join " "
  return (Normalize-Search $text).Contains((Normalize-Search $Kw))
}

$health = Invoke-BridgeJson "/health"
Write-Host "bridge_version=$($health.version)"

$globalItems = @()
$legacyPrefilterMatches = 0
$offset = ""
$pageNo = 0
$lastGlobal = $null
do {
  $path = "/global_items?region=$Region&page_size=50"
  if ($offset) { $path += "&offset=$([uri]::EscapeDataString($offset))" }
  $lastGlobal = Invoke-BridgeJson $path
  if (-not $lastGlobal.ok) { break }

  $page = @($lastGlobal.result.response.global_item_list)
  $legacyPrefilterMatches += @($page | Where-Object {
    (Normalize-Search "$($_.item_name)").Contains((Normalize-Search $Keyword))
  }).Count
  $globalItems += $page

  $offset = [string]$lastGlobal.result.response.offset
  $pageNo += 1
} while ($lastGlobal.result.response.has_next_page -and $offset)

Write-Host "global_items_ok=$($lastGlobal.ok) error=$($lastGlobal.result.error) pages=$pageNo total_loaded=$($globalItems.Count)"
Write-Host "legacy_ui_prefilter_matches=$legacyPrefilterMatches"

if (-not $lastGlobal.ok) {
  throw "global_items failed: $($lastGlobal.result.error) $($lastGlobal.result.message)"
}

$enriched = @()
for ($i = 0; $i -lt $globalItems.Count; $i += 50) {
  $end = [Math]::Min($i + 49, $globalItems.Count - 1)
  $batch = @($globalItems[$i..$end])
  $query = ($batch | ForEach-Object { "global_item_id=$($_.global_item_id)" }) -join "&"
  $info = Invoke-BridgeJson "/global_item_info?region=$Region&$query"
  if (-not $info.ok) {
    throw "global_item_info failed at batch $i-$end`: $($info.result.error) $($info.result.message)"
  }
  $enriched += @($info.result.response.global_item_list)
}

$matches = @($enriched | Where-Object { Test-Match $_ $Keyword })
Write-Host "global_enriched=$($enriched.Count)"
Write-Host "keyword=$Keyword matches=$($matches.Count)"

$matches |
  Select-Object -First 30 global_item_id,global_item_sku,global_item_name,item_sku,item_name |
  Format-Table -AutoSize

if ($matches.Count -lt $ExpectedMin) {
  throw "Expected at least $ExpectedMin search results for keyword '$Keyword', got $($matches.Count)"
}
