<#
.SYNOPSIS
  Alibaba (ICBU) registration — Phase A 배포 스크립트.

.DESCRIPTION
  main 브랜치를 최신화한 뒤 platform-publish / alibaba-bridge Edge Function을
  디스크에서 번들 배포하고, v2 프론트를 Vercel prod로 올린다.
  Phase A는 "안전 골격"만 라이브화한다 — 실제 Alibaba 등록은
  auth_verified / ALIBABA_BRIDGE_ENABLED 플립 전까지 차단 상태로 유지된다.

  Plan ref: plans/alibaba-deep-lemon.md

.PREREQUISITES
  - supabase CLI 로그인 (supabase login  또는  $env:SUPABASE_ACCESS_TOKEN)
  - vercel CLI 로그인 (vercel login)

.EXAMPLE
  .\scripts\deploy-alibaba-phase-a.ps1
  .\scripts\deploy-alibaba-phase-a.ps1 -SkipVercel
#>
[CmdletBinding()]
param(
  [string]$ProjectRef = "mgqlwgnmwegzsjelbrih",
  [string]$RepoRoot   = "C:\dev\shopee-dashboard",
  [switch]$SkipGitPull,
  [switch]$SkipVercel,
  [int]$MaxRetries = 4
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

function Invoke-WithRetry {
  param([Parameter(Mandatory)][scriptblock]$Cmd, [Parameter(Mandatory)][string]$Name)
  for ($i = 1; $i -le $MaxRetries; $i++) {
    & $Cmd
    if ($LASTEXITCODE -eq 0) { Write-Host "OK  $Name" -ForegroundColor Green; return }
    $wait = [int][math]::Pow(2, $i)
    Write-Warning "$Name 실패 (시도 $i/$MaxRetries). ${wait}s 후 재시도..."
    Start-Sleep -Seconds $wait
  }
  throw "$Name 최종 실패 (exit $LASTEXITCODE)"
}

if (-not $SkipGitPull) {
  Write-Host "== git main 동기화 ==" -ForegroundColor Cyan
  git switch main;      if ($LASTEXITCODE -ne 0) { throw "git switch main 실패" }
  git pull origin main; if ($LASTEXITCODE -ne 0) { throw "git pull origin main 실패" }
}

Write-Host "== Edge Functions 배포 ($ProjectRef) ==" -ForegroundColor Cyan
Invoke-WithRetry { supabase functions deploy platform-publish --project-ref $ProjectRef } "platform-publish"
Invoke-WithRetry { supabase functions deploy alibaba-bridge   --project-ref $ProjectRef } "alibaba-bridge"

if (-not $SkipVercel) {
  Write-Host "== Vercel 프론트(v2) 배포 ==" -ForegroundColor Cyan
  Invoke-WithRetry { vercel deploy --prod --yes } "vercel"
}

Write-Host "== 배포 확인 ==" -ForegroundColor Cyan
supabase functions list --project-ref $ProjectRef | Select-String "platform-publish|alibaba-bridge"

Write-Host ""
Write-Host "Phase A 배포 완료. Alibaba 등록은 아직 차단 상태입니다:" -ForegroundColor Green
Write-Host "  - platform_capabilities.alibaba.auth_verified = false (gate 4)" -ForegroundColor DarkGray
Write-Host "  - ALIBABA_BRIDGE_ENABLED 미설정 (bridge docs_required)" -ForegroundColor DarkGray
Write-Host "  Phase B(ICBU 문서 매핑) 완료 후 플립하세요." -ForegroundColor DarkGray
