# unerr Windows installer — https://raw.githubusercontent.com/unerr-ai/unerr/main/install.ps1
# Usage: irm https://raw.githubusercontent.com/unerr-ai/unerr/main/install.ps1 | iex
#        $env:VERSION="0.3.5"; irm https://raw.githubusercontent.com/unerr-ai/unerr/main/install.ps1 | iex
#
# Env overrides:
#   $env:VERSION           — pin a specific release tag (without leading v)
#   $env:UNERR_INSTALL_DIR — override install location
#                            (default: $env:USERPROFILE\.unerr\bin)

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Public host for binary Releases (unerr-cli is private). See ./install.
$Repo    = "unerr-ai/unerr"
$Binary  = "unerr.exe"
$Archive = "unerr-windows-x64.zip"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Info  { param([string]$Msg) Write-Host "[unerr] $Msg" -ForegroundColor Cyan   }
function Write-Ok    { param([string]$Msg) Write-Host "[unerr] $Msg" -ForegroundColor Green  }
function Write-Warn  { param([string]$Msg) Write-Host "[unerr] warn: $Msg" -ForegroundColor Yellow }
function Write-Fail  { param([string]$Msg) Write-Error "[unerr] error: $Msg" }

# ---------------------------------------------------------------------------
# Architecture check — only x64 is supported
# ---------------------------------------------------------------------------

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture
if ($Arch -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
    Write-Warn "Windows arm64 is not yet supported by the native binary."
    Write-Warn "Use the npm path instead:"
    Write-Warn "  npm install -g @unerr-ai/unerr"
    exit 1
}
if ($Arch -ne [System.Runtime.InteropServices.Architecture]::X64) {
    Write-Fail "Unsupported architecture: $Arch. Only x64 is supported."
}

Write-Info "detected platform: windows-x64"

# ---------------------------------------------------------------------------
# Resolve version
# ---------------------------------------------------------------------------

$RequestedVersion = if ($env:VERSION) { $env:VERSION.TrimStart("v") } else { "" }

if (-not $RequestedVersion) {
    Write-Info "resolving latest release..."
    try {
        $ReleaseJson = Invoke-RestMethod `
            -Uri "https://api.github.com/repos/$Repo/releases/latest" `
            -Headers @{ "User-Agent" = "unerr-installer" }
        $Tag         = $ReleaseJson.tag_name
        $VersionNum  = $Tag.TrimStart("v")
    } catch {
        Write-Fail "could not resolve latest release from GitHub API: $_"
    }
} else {
    $VersionNum = $RequestedVersion
    $Tag        = "v$VersionNum"
}

Write-Info "installing unerr $Tag"

# ---------------------------------------------------------------------------
# Asset URLs
# ---------------------------------------------------------------------------

$BaseUrl    = "https://github.com/$Repo/releases/download/$Tag"
$ArchiveUrl = "$BaseUrl/$Archive"
$SumsUrl    = "$BaseUrl/SHA256SUMS"

# ---------------------------------------------------------------------------
# Install directory
# ---------------------------------------------------------------------------

$InstallDir = if ($env:UNERR_INSTALL_DIR) {
    $env:UNERR_INSTALL_DIR
} else {
    Join-Path $env:USERPROFILE ".unerr\bin"
}

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}

# ---------------------------------------------------------------------------
# Temp directory
# ---------------------------------------------------------------------------

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

Write-Info "downloading $Archive..."
$ArchivePath = Join-Path $TmpDir $Archive
Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ArchivePath -UseBasicParsing

Write-Info "downloading SHA256SUMS..."
$SumsPath = Join-Path $TmpDir "SHA256SUMS"
Invoke-WebRequest -Uri $SumsUrl -OutFile $SumsPath -UseBasicParsing

# ---------------------------------------------------------------------------
# Verify checksum
# ---------------------------------------------------------------------------

Write-Info "verifying checksum..."

$SumsContent = Get-Content $SumsPath
$ExpectedHash = $null
foreach ($Line in $SumsContent) {
    # Format: "<sha256>  <filename>"
    if ($Line -match "^([0-9a-fA-F]{64})\s+$([regex]::Escape($Archive))$") {
        $ExpectedHash = $Matches[1].ToLower()
        break
    }
}

if (-not $ExpectedHash) {
    Write-Fail "no checksum entry for $Archive in SHA256SUMS"
}

$ActualHash = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLower()

if ($ActualHash -ne $ExpectedHash) {
    Write-Fail "checksum mismatch for ${Archive}:`n  expected: $ExpectedHash`n  actual:   $ActualHash"
}

Write-Info "checksum OK"

# ---------------------------------------------------------------------------
# Extract
# ---------------------------------------------------------------------------

Write-Info "extracting..."
Expand-Archive -Path $ArchivePath -DestinationPath $TmpDir -Force

$ExtractedBin = Join-Path $TmpDir $Binary
if (-not (Test-Path $ExtractedBin)) {
    Write-Fail "archive did not contain $Binary"
}

$DestBin = Join-Path $InstallDir $Binary
Copy-Item -Path $ExtractedBin -Destination $DestBin -Force

Write-Info "installed to $DestBin"

# ---------------------------------------------------------------------------
# PATH handling (user scope, idempotent)
# ---------------------------------------------------------------------------

$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -split ";" -notcontains $InstallDir) {
    $NewPath = "$InstallDir;$UserPath".TrimEnd(";")
    [Environment]::SetEnvironmentVariable("PATH", $NewPath, "User")
    Write-Info "added $InstallDir to user PATH"
    Write-Warn "$InstallDir added to PATH. Restart your terminal (or open a new one) for it to take effect."
} else {
    Write-Info "$InstallDir is already on PATH"
}

# Also update the current session's PATH so the binary is immediately usable
if ($env:PATH -split ";" -notcontains $InstallDir) {
    $env:PATH = "$InstallDir;$env:PATH"
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Ok ""
Write-Ok "unerr $Tag installed successfully!"
Write-Ok ""
Write-Ok "  Next step:"
Write-Ok "    unerr install claude-code"
Write-Ok ""

} finally {
    # Clean up temp directory
    if (Test-Path $TmpDir) {
        Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    }
}
