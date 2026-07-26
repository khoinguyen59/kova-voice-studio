[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Binary
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw).Trim()

# KOVA release convention: fourth component is 0-9. Bump the third component
# and reset the fourth to 0 after x.y.z.9; never publish x.y.z.10.
if ($version -notmatch '^\d+\.\d+\.\d+\.[0-9]$') {
    throw "VERSION must use KOVA's four-part release format x.y.z.0 through x.y.z.9; received '$version'."
}

$source = [System.IO.Path]::GetFullPath($Binary)
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Wails executable was not found: $source"
}

$destination = Join-Path $projectRoot ("build\KOVA-Voice-Studio-{0}.exe" -f $version)
Move-Item -LiteralPath $source -Destination $destination -Force
Write-Output "Packaged release: $destination"
