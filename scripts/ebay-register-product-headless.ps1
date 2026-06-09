param(
  [string]$ProductId = "",
  [string]$Sku = "",
  [switch]$Publish,
  [switch]$Force,
  [string]$SupabaseUrl = "https://mgqlwgnmwegzsjelbrih.supabase.co"
)

$ErrorActionPreference = "Stop"

if (-not $ProductId -and -not $Sku) {
  throw "Provide -ProductId or -Sku."
}

$token = [Environment]::GetEnvironmentVariable("PLATFORM_BRIDGE_INTERNAL_TOKEN", "Process")
if (-not $token) {
  $token = [Environment]::GetEnvironmentVariable("PLATFORM_BRIDGE_INTERNAL_TOKEN", "User")
}
if (-not $token) {
  throw "PLATFORM_BRIDGE_INTERNAL_TOKEN is missing. Set it in the current session or Windows User env."
}

$indexPath = Join-Path (Split-Path $PSScriptRoot -Parent) "v2\index.html"
$index = Get-Content -Raw -LiteralPath $indexPath
$anon = [regex]::Match($index, "const SUPABASE_ANON = '([^']+)'").Groups[1].Value
if (-not $anon) {
  throw "SUPABASE_ANON was not found in v2/index.html."
}

$body = @{}
if ($ProductId) { $body.product_id = $ProductId }
if ($Sku) { $body.sku = $Sku }
if ($Publish) {
  $body.dry_run = $false
  $body.confirm = "PUBLISH_EBAY_LISTING"
} else {
  $body.dry_run = $true
}
if ($Force) { $body.force = $true }

$uri = "$($SupabaseUrl.TrimEnd('/'))/functions/v1/ebay-bridge/register-product"
$headers = @{
  Authorization = "Bearer $anon"
  apikey = $anon
  "x-platform-bridge-token" = $token
  "Content-Type" = "application/json"
}

try {
  $json = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body ($body | ConvertTo-Json -Depth 10)
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    $reader = [System.IO.StreamReader]::new($resp.GetResponseStream())
    $text = $reader.ReadToEnd()
    Write-Error "HTTP $([int]$resp.StatusCode): $text"
    exit 1
  }
  throw
}

if ($Publish) {
  [pscustomobject]@{
    ok = $json.ok
    product_id = $json.product_id
    sku = $json.sku
    ebay_item_id = $json.ebay_item_id
    ebay_offer_id = $json.ebay_offer_id
    marketplace_id = $json.marketplace_id
    lookup_ok = $json.lookup_ok
    listing_id = $json.verification.listing_id
    url = if ($json.ebay_item_id) { "https://www.ebay.com/itm/$($json.ebay_item_id)" } else { $null }
  } | ConvertTo-Json -Depth 8
} else {
  [pscustomobject]@{
    ok = $json.ok
    dry_run = $json.dry_run
    product_id = $json.product_id
    sku = $json.sku
    title = $json.payload.title
    category_id = $json.payload.categoryId
    price_usd = $json.payload.priceUsd
    quantity = $json.payload.quantity
    weight_g = $json.payload.weightG
    image_count = @($json.payload.imageUrls).Count
    artist = @($json.payload.aspects.Artist)[0]
    release_title = @($json.payload.aspects.'Release Title')[0]
    validation_ok = $json.validation.ok
    warning_count = @($json.validation.warnings).Count
    shipping_surcharge_count = $json.pricing.shippingSurchargeCount
  } | ConvertTo-Json -Depth 8
}
