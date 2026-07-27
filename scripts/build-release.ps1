[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location $projectRoot
try {
    $pending = git status --porcelain
    if ($pending) {
        throw 'Release build requires a clean worktree. Commit the source first.'
    }
    $branch = (git branch --show-current).Trim()
    if (-not $branch) {
        throw 'Release build requires a checked-out branch, not a detached commit.'
    }
    $head = (git rev-parse HEAD).Trim()
    $remote = (git ls-remote origin ("refs/heads/{0}" -f $branch)).Trim().Split("`t")[0]
    if (-not $remote -or $remote -ne $head) {
        throw "Release build requires HEAD $head to be pushed to origin/$branch before building the EXE."
    }
	$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw).Trim()
	$tag = "v$version"
	$localTagCommit = (git rev-list -n 1 $tag).Trim()
	if (-not $localTagCommit -or $localTagCommit -ne $head) {
		throw "Release build requires local tag $tag to point at HEAD $head."
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
		throw "Release build requires tag $tag for HEAD $head to be pushed to GitHub before building the EXE."
	}
    & wails build -clean
    if ($LASTEXITCODE -ne 0) {
        throw "Wails build failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}
