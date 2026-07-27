[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Binary
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw).Trim()

Push-Location $projectRoot
try {
    $branch = (git branch --show-current).Trim()
    $head = (git rev-parse HEAD).Trim()
    $remote = if ($branch) { (git ls-remote origin ("refs/heads/{0}" -f $branch)).Trim().Split("`t")[0] } else { '' }
    if (-not $branch -or -not $remote -or $remote -ne $head) {
        throw 'Refusing to package a release EXE before the current commit is pushed to GitHub.'
    }
	$tag = "v$version"
	$localTagCommit = (git rev-list -n 1 $tag).Trim()
	if (-not $localTagCommit -or $localTagCommit -ne $head) {
		throw "Refusing to package: local tag $tag does not point to the current commit."
	}
	$remoteTagLines = @(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}")
	$remoteTagCommit = ''
	foreach ($line in $remoteTagLines) {
		$parts = $line -split "`t"
		if ($parts.Length -ge 2 -and ($parts[1] -eq "refs/tags/$tag" -or $parts[1] -eq "refs/tags/$tag^{}")) {
			if ($parts[1].EndsWith('^{}') -or -not $remoteTagCommit) { $remoteTagCommit = $parts[0] }
		}
	}
	if (-not $remoteTagCommit -or $remoteTagCommit -ne $head) {
		throw "Refusing to package: tag $tag for the current commit is not pushed to GitHub."
	}
} finally {
    Pop-Location
}

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
