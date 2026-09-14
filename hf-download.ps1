#requires -Version 5.1
<#
    Hugging Face downloader
    -----------------------
    Paste a Hugging Face link, it downloads with aria2c (-x 16 -s 16)
    into a folder you choose, showing live progress for each file.

    Accepts:
      https://huggingface.co/owner/repo/blob/main/model.gguf     (single file)
      https://huggingface.co/owner/repo/resolve/main/model.gguf  (single file)
      https://huggingface.co/owner/repo                          (pick from a list)
      https://huggingface.co/owner/repo/tree/main/subfolder      (pick from a list)
      https://huggingface.co/datasets/owner/repo/...             (datasets too)
      owner/repo                                                 (shorthand)
#>

param(
    [string]$Url,
    [string]$OutputDir,
    [string]$Aria2Path,
    [ValidateRange(1, 16)][int]$Connections = 16,
    [switch]$DisableIPv6,
    [string]$SettingsPath
)

$ErrorActionPreference = 'Stop'
# -bor, not =. Assigning removes TLS 1.3 from the enabled set on Windows PowerShell,
# where the previous line left only TLS 1.2 available.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# $OutputEncoding governs the bytes PowerShell writes to a native process's stdin, and
# Windows PowerShell defaults it to ASCII. The aria2 manifest travels that way, so every
# non-ASCII character in an "out=" line became "?" - which is itself illegal in a Windows
# filename, so a repository holding "modèle-Q4.gguf" failed with no explanation.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$script:AppSettingsPath = $SettingsPath
if (-not $script:AppSettingsPath) {
    $configRoot = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $configRoot) { $configRoot = [Environment]::GetFolderPath('UserProfile') }
    $script:AppSettingsPath = Join-Path $configRoot 'HuggingFaceDownloader\settings.json'
}
$script:TransferConnections = $Connections
# Hugging Face transfers are intentionally IPv4-only. Keep the legacy switch
# accepted so older shortcuts/scripts continue to work, but never allow an
# accidental IPv6 fallback.
$script:TransferDisableIPv6 = $true
$script:ConfiguredAria2 = $Aria2Path

# ---------------------------------------------------------------- helpers ---

# aria2 takes --disable-ipv6=true, but .NET has no equivalent switch, so the
# repo listing and size probes could still leave over IPv6 while the transfers
# stay on IPv4. Refuse IPv6 candidates in the bind callback instead: throwing
# here makes .NET move on to the next address rather than fail the request.
function Enable-IPv4Only {
    param([string[]]$Hosts = @('huggingface.co', 'www.huggingface.co', 'hf.co', 'www.hf.co'))
    $refuseIPv6 = [Net.BindIPEndPoint]{
        param($servicePoint, $remoteEndPoint, $retryCount)
        if ($remoteEndPoint.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) {
            throw [InvalidOperationException]::new('IPv6 is disabled for Hugging Face transfers.')
        }
        return $null
    }
    foreach ($hostName in $Hosts) {
        try { [Net.ServicePointManager]::FindServicePoint([uri]("https://$hostName")).BindIPEndPointDelegate = $refuseIPv6 } catch { }
    }
}

# A token travels to aria2 as a header line on stdin. A control character in it
# would end that line early and let whatever followed be read as another option,
# so anything that cannot appear in a real token is refused rather than escaped.
function Assert-ValidToken {
    param([string]$Value)
    if ($Value -match '[\x00-\x1F\x7F]' -or $Value.Length -gt 4096) {
        throw 'The Hugging Face token contains invalid characters.'
    }
    return $Value
}

# huggingface.co is the only host that may ever see the bearer token.
function Assert-HFUrl {
    param([string]$Url)
    $parsed = $null
    if (-not [uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$parsed) -or
        $parsed.Scheme -ne 'https' -or $parsed.Host -ne 'huggingface.co' -or $parsed.UserInfo) {
        throw 'Unexpected file-list destination.'
    }
    return $parsed.AbsoluteUri
}

function Get-ResponseStatus {
    param($Response)
    if (-not $Response) { return 0 }
    try { return [int]$Response.StatusCode } catch { return 0 }
}

# Windows PowerShell 5.1 hands back an HttpWebResponse, whose Headers collection has a
# string indexer. PowerShell 7 hands back an HttpResponseMessage, whose HttpResponseHeaders
# has no indexer at all - so the 5.1 form silently returned $null under pwsh and every
# redirect and every LFS size probe looked like a plain failure, while CI stayed green
# because both are mocked out in the test suite.
function Get-ResponseHeader {
    param($Response, [string]$Name)
    if (-not $Response) { return $null }
    $headers = $Response.Headers
    if (-not $headers) { return $null }
    if ($headers -is [System.Net.WebHeaderCollection]) {
        $value = $headers[$Name]
        if ($value -is [array]) { if ($value.Count) { return [string]$value[0] } else { return $null } }
        return $value
    }
    $values = $null
    try { if ($headers.TryGetValues($Name, [ref]$values) -and $values) { return [string]@($values)[0] } } catch { }
    # Content-Length and the other entity headers sit on a separate collection under pwsh.
    try {
        $content = $Response.Content
        if ($content -and $content.Headers -and $content.Headers.TryGetValues($Name, [ref]$values) -and $values) { return [string]@($values)[0] }
    } catch { }
    return $null
}

# A 404 and a gated 403 and a rate limit are three different problems with three different
# answers. Reporting all of them as one raw .NET message left the user guessing.
function Get-HFAccessMessage {
    param([int]$Status)
    switch ($Status) {
        401 { return 'Access denied (401). Set HF_TOKEN to a token with read access.' }
        403 { return 'Access denied (403). The repository is gated or private: accept its terms on its Hugging Face page, and use a token with read access.' }
        404 { return 'Repository, revision, or file not found (404). Check the link and the branch name.' }
        429 { return 'Hugging Face is rate limiting this machine (429). Wait a minute and try again.' }
        default {
            if ($Status -ge 500) { return "Hugging Face returned HTTP $Status. That is a server-side error; try again shortly." }
            if ($Status -gt 0)   { return "Hugging Face returned HTTP $Status." }
            return 'Hugging Face could not be reached.'
        }
    }
}

# .NET does not drop a hand-set Authorization header when it follows a redirect,
# so the hops are walked here instead and each one is checked before the next
# request carries the token to it.
function Invoke-HFApiRequest {
    param([string]$Url, [hashtable]$Headers)
    $current = Assert-HFUrl $Url
    for ($hop = 0; $hop -lt 5; $hop++) {
        try {
            return Invoke-WebRequest -Uri $current -Headers $Headers -UseBasicParsing `
                                     -MaximumRedirection 0 -TimeoutSec 60 -ErrorAction Stop
        } catch {
            $response = $_.Exception.Response
            if (-not $response) { throw }
            $status = Get-ResponseStatus $response
            if ($status -lt 300 -or $status -gt 399) { throw (Get-HFAccessMessage $status) }
            $location = Get-ResponseHeader $response 'Location'
            if (-not $location) { throw }
            $current = Assert-HFUrl ([uri]::new([uri]$current, [string]$location)).AbsoluteUri
        }
    }
    throw 'Too many redirects while listing the repository.'
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Running out of disk half way through a 40 GB model wastes the whole transfer,
# and aria2 reports it as an ordinary write failure. Check up front instead.
# Unknown free space is not a reason to refuse - only a known shortfall is.
function Assert-FreeSpace {
    param([string]$DestDir, [int64]$Needed)
    if ($Needed -le 0) { return }
    $free = $null
    try {
        $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($DestDir))
        $free = (New-Object IO.DriveInfo $root).AvailableFreeSpace
    } catch { return }
    if ($null -eq $free) { return }
    $headroom = $Needed + [int64]($Needed * 0.05)
    if ($free -lt $headroom) {
        throw ('Not enough free disk space: about {0} needed, {1} available.' -f `
               (Format-Size $headroom), (Format-Size $free))
    }
}

# Two runs writing the same repo folder would resume each other's .part files
# and race on the rename. The lock is one file in the destination; a lock left
# behind by a killed run goes stale after an hour and is cleared.
function Lock-Destination {
    param([string]$DestDir)
    $filename = Join-Path $DestDir '.hugging-face-downloader.lock'
    foreach ($attempt in 1, 2) {
        try {
            return [pscustomobject]@{
                Path   = $filename
                Handle = [IO.File]::Open($filename, [IO.FileMode]::CreateNew,
                                         [IO.FileAccess]::Write, [IO.FileShare]::None)
            }
        } catch {
            if ($attempt -eq 1 -and (Test-Path -LiteralPath $filename) -and
                ((Get-Date) - (Get-Item -LiteralPath $filename).LastWriteTime).TotalHours -gt 1) {
                Remove-Item -LiteralPath $filename -Force -ErrorAction SilentlyContinue
                continue
            }
            # Contention is only one reason this can fail. A read-only folder, a denied
            # ACL, a full disk and an offline share all landed here too, and all of them
            # sent the user looking for a download that was not running.
            if (-not (Test-Path -LiteralPath $filename)) {
                throw ('Could not write to the download folder: {0}' -f $_.Exception.Message)
            }
            throw 'Another download is already running in this folder.'
        }
    }
    throw 'Could not lock the destination folder.'
}

function Unlock-Destination {
    param($Lock)
    if (-not $Lock) { return }
    try { $Lock.Handle.Dispose() } catch { }
    Remove-Item -LiteralPath $Lock.Path -Force -ErrorAction SilentlyContinue
}

function Write-Info  { param($m) Write-Host $m -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host $m -ForegroundColor Green }
function Write-Warn2 { param($m) Write-Host $m -ForegroundColor Yellow }
function Write-Err   { param($m) Write-Host $m -ForegroundColor Red }
function Write-Rule  { Write-Host ('  ' + ('-' * 66)) -ForegroundColor DarkGray }

# aria2's live readout ends with a bare CR and no newline, so wipe that
# leftover line before printing anything after it.
function Clear-Line {
    $w = 79
    try { $w = [Math]::Max(20, $Host.UI.RawUI.WindowSize.Width - 1) } catch { }
    Write-Host ("`r" + (' ' * $w) + "`r") -NoNewline
}

function Get-DownloaderSettings {
    if (-not (Test-Path -LiteralPath $script:AppSettingsPath)) { return @{} }
    try {
        $object = Get-Content -LiteralPath $script:AppSettingsPath -Raw | ConvertFrom-Json
        $result = @{}
        foreach ($property in $object.PSObject.Properties) { $result[$property.Name] = $property.Value }
        return $result
    } catch { Write-Warn2 'Could not read settings; using defaults.'; return @{} }
}

function Save-DownloaderSettings {
    param([hashtable]$Settings)
    $parent = Split-Path -Parent ([IO.Path]::GetFullPath($script:AppSettingsPath))
    # Not New-Item: it has no -LiteralPath in Windows PowerShell, and its -Path treats
    # [ and ] as a wildcard, so a folder such as D:\Models[new] is silently never made.
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $Settings | ConvertTo-Json | Set-Content -LiteralPath $script:AppSettingsPath -Encoding UTF8
}

function Get-DownloadFolder {
    param([string]$Requested)
    if ($Requested) { return [IO.Path]::GetFullPath($Requested) }
    if ($env:HF_DOWNLOADER_OUTPUT) { return [IO.Path]::GetFullPath($env:HF_DOWNLOADER_OUTPUT) }
    $settings = Get-DownloaderSettings
    if ($settings.outputDir) { return [IO.Path]::GetFullPath([string]$settings.outputDir) }
    $profileFolder = [Environment]::GetFolderPath('UserProfile')
    $suggested = Join-Path $profileFolder 'Downloads\HuggingFace'
    Write-Info 'Choose where to save downloads (remembered for next time).'
    Write-Host "  Default: $suggested"
    Write-Host '  Enter LM for the standard LM Studio library, or enter a folder path.'
    $answer = (Read-Host 'Download folder [Enter for default]').Trim().Trim('"')
    if ($answer -eq 'LM') { $answer = Join-Path $profileFolder '.lmstudio\models' }
    if (-not $answer) { $answer = $suggested }
    $folder = [IO.Path]::GetFullPath($answer)
    $settings.outputDir = $folder
    try { Save-DownloaderSettings $settings } catch { Write-Warn2 'Could not save the folder preference.' }
    return $folder
}

function Format-Size {
    param([double]$Bytes)
    if ($Bytes -ge 1TB) { return ('{0:N2} TB' -f ($Bytes / 1TB)) }
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
    return ('{0} B' -f [int]$Bytes)
}

function Format-Duration {
    param([TimeSpan]$Span)
    if ($Span.TotalSeconds -lt 60)  { return ('{0:N1}s' -f $Span.TotalSeconds) }
    if ($Span.TotalMinutes -lt 60)  { return ('{0}m {1}s' -f [int]$Span.Minutes, [int]$Span.Seconds) }
    return ('{0}h {1}m' -f [int][Math]::Floor($Span.TotalHours), [int]$Span.Minutes)
}

function Resolve-Aria2Path {
    if ($script:ConfiguredAria2) {
        if (-not (Test-Path -LiteralPath $script:ConfiguredAria2 -PathType Leaf)) { throw 'The specified aria2 executable was not found.' }
        return [IO.Path]::GetFullPath($script:ConfiguredAria2)
    }
    $bundled = Join-Path $PSScriptRoot 'bin\aria2c.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $cmd = Get-Command aria2c.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\aria2c.exe'),
        (Join-Path $env:ProgramFiles 'aria2\aria2c.exe'),
        (Join-Path $env:USERPROFILE 'scoop\shims\aria2c.exe'),
        (Join-Path $env:ProgramData 'chocolatey\bin\aria2c.exe')
    )
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }

    $pkgRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path -LiteralPath $pkgRoot) {
        $hit = Get-ChildItem -Path $pkgRoot -Filter 'aria2c.exe' -Recurse -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

function Install-Aria2 {
    Write-Warn2 'aria2c was not found on this machine.'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Err 'winget is not available either. Install aria2 manually from https://github.com/aria2/aria2/releases'
        return $null
    }
    $answer = Read-Host 'Install it now with winget? [Y/n]'
    if ($answer -and $answer -notmatch '^(y|yes)$') { return $null }

    Write-Info 'Installing aria2 (this only happens once)...'
    & winget install --id aria2.aria2 --exact --source winget `
        --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host

    $found = Resolve-Aria2Path
    if ($found) { Write-Ok ("aria2c installed: {0}" -f $found) }
    else { Write-Err 'Install finished but aria2c still was not found. Try opening a new window.' }
    return $found
}

function Get-HFToken {
    foreach ($v in @($env:HF_TOKEN, $env:HUGGING_FACE_HUB_TOKEN, $env:HUGGINGFACE_TOKEN)) {
        if ($v) { return (Assert-ValidToken $v.Trim()) }
    }
    $tokenFile = $env:HF_TOKEN_PATH
    if (-not $tokenFile) {
        $hfFolder = $env:HF_HOME
        if (-not $hfFolder) {
            if ($env:XDG_CACHE_HOME) { $hfFolder = Join-Path $env:XDG_CACHE_HOME 'huggingface' }
            else { $hfFolder = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\huggingface' }
        }
        $tokenFile = Join-Path $hfFolder 'token'
    }
    if (Test-Path -LiteralPath $tokenFile) {
        $t = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
        if ($t) { return (Assert-ValidToken $t) }
    }
    return $null
}

# ----------------------------------------------------------------- parsing ---

function ConvertFrom-HFLink {
    param([string]$Link)

    $s = $Link.Trim().Trim('"').Trim("'")
    if (-not $s) { return $null }
    if ($s -match '^https?://') {
        $parsedUri = $null
        if (-not [uri]::TryCreate($s, [UriKind]::Absolute, [ref]$parsedUri) -or
            $parsedUri.Host -notin @('huggingface.co', 'www.huggingface.co', 'hf.co', 'www.hf.co')) { return $null }
    }

    # drop query string / fragment (e.g. ?download=true)
    $s = ($s -split '[?#]')[0]
    $s = $s -replace '/+$', ''

    # strip scheme + host
    $s = $s -replace '^(https?://)?(www\.)?huggingface\.co/', ''
    $s = $s -replace '^(https?://)?(www\.)?hf\.co/', ''
    $s = $s.TrimStart('/')

    # Decode once, here, so every later stage sees real text. Doing it further
    # down meant the revision segment was never decoded at all: an encoded branch
    # such as "feature%2Ffoo" was re-escaped on the way out as "feature%252Ffoo"
    # and the API answered 404.
    $parts = @($s -split '/' | Where-Object { $_ -ne '' } |
               ForEach-Object { [uri]::UnescapeDataString($_) })
    if ($parts.Count -eq 0) { return $null }

    $kind = 'models'
    # Guard the slice: PowerShell reads 1..0 as @(1, 0), so an unguarded
    # $parts[1..($parts.Count - 1)] on a single-element array keeps element 0
    # and "huggingface.co/datasets" parses as a repo literally named datasets.
    if ($parts[0] -eq 'datasets' -or $parts[0] -eq 'spaces') {
        $kind  = $parts[0]
        $parts = @(if ($parts.Count -gt 1) { $parts[1..($parts.Count - 1)] })
    }

    if ($parts.Count -eq 0) { return $null }

    # repo id: "owner/name", or just "name" for canonical repos like gpt2
    if ($parts.Count -ge 2 -and $parts[1] -notin @('blob', 'resolve', 'tree', 'raw')) {
        $repo = $parts[0] + '/' + $parts[1]
        $rest = @()
        if ($parts.Count -gt 2) { $rest = @($parts[2..($parts.Count - 1)]) }
    } else {
        $repo = $parts[0]
        $rest = @()
        if ($parts.Count -gt 1) { $rest = @($parts[1..($parts.Count - 1)]) }
    }

    $rev  = 'main'
    $path = ''
    $isFile = $false

    if ($rest.Count -gt 0) {
        $verb = $rest[0]
        if ($verb -in @('blob', 'resolve', 'tree', 'raw')) {
            # Every slice is re-wrapped in @(). A PowerShell range that yields one
            # element collapses to that element, and indexing a bare string returns
            # its first character: a link ending right after the revision, such as
            # /tree/main, used to come back with a revision of "m".
            $rest = @(if ($rest.Count -gt 1) { $rest[1..($rest.Count - 1)] })
            if ($rest.Count -gt 0) {
                # branch names like refs/pr/3 span three segments
                if ($rest[0] -eq 'refs' -and $rest.Count -ge 3) {
                    $rev  = ($rest[0..2]) -join '/'
                    $rest = @(if ($rest.Count -gt 3) { $rest[3..($rest.Count - 1)] })
                } else {
                    $rev  = $rest[0]
                    $rest = @(if ($rest.Count -gt 1) { $rest[1..($rest.Count - 1)] })
                }
            }
            $path = ($rest -join '/')
            $isFile = ($verb -in @('blob', 'resolve', 'raw')) -and $path -ne ''
        }
    }

    $prefix = switch ($kind) { 'datasets' { 'datasets/' } 'spaces' { 'spaces/' } default { '' } }
    if ($repo -notmatch '^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)?$') { return $null }
    if ($path) { Assert-SafeRelativePath $path }

    return [pscustomobject]@{
        Kind    = $kind
        Repo    = $repo
        Rev     = $rev
        Path    = $path
        IsFile  = $isFile
        WebBase = "https://huggingface.co/$prefix$repo"
        ApiBase = "https://huggingface.co/api/$kind/$repo"
    }
}

function Get-HFTree {
    param($Info, [string]$Token)

    $headers = @{ 'User-Agent' = 'hf-download-ps/1.0' }
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }

    $encRev = ($Info.Rev -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    $url = "$($Info.ApiBase)/tree/$encRev"
    if ($Info.Path) { $url += '/' + (($Info.Path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/') }
    $url += '?recursive=true&expand=false'

    $all    = New-Object System.Collections.Generic.List[object]
    $seen   = New-Object System.Collections.Generic.HashSet[string]
    $pages  = 0
    $script:RepoCommit = ''

    while ($url) {
        # The next-page URL comes from the server, so every hop is re-checked
        # rather than trusted. A server that keeps pointing back at itself would
        # otherwise spin until the page cap, and a host swap would hand the
        # bearer token to somewhere it does not belong.
        if (++$pages -gt 100) { throw 'This repository has too many files to list completely.' }
        $url = Assert-HFUrl $url
        if (-not $seen.Add($url)) { throw 'The file list kept repeating itself; stopping.' }

        $resp = Invoke-HFApiRequest -Url $url -Headers $headers

        # Pin the listing to the commit it came from. Without this a branch that
        # moves between the listing and the download hands back different bytes
        # than the ones whose sizes and hashes were just shown.
        if (-not $script:RepoCommit) {
            $commit = $resp.Headers['x-repo-commit']
            if ($commit -is [array]) { $commit = $commit[0] }
            $commit = ([string]$commit).Trim().ToLowerInvariant()
            if ($commit -match '^[0-9a-f]{40}$') { $script:RepoCommit = $commit }
        }

        $page = $resp.Content | ConvertFrom-Json
        foreach ($e in $page) {
            # LFS entries carry the SHA-256 of the real file. Keep it where one
            # exists so the transfer has something to verify against; plain git
            # blobs have only a SHA-1 tree hash, which is not that.
            $digest = ''
            if ($e.PSObject.Properties['lfs'] -and $e.lfs) {
                foreach ($candidate in @($e.lfs.sha256, $e.lfs.oid)) {
                    if ($candidate) { $digest = ([string]$candidate) -replace '^(?i:sha256:)', ''; break }
                }
            }
            if ($digest -notmatch '^[0-9a-fA-F]{64}$') { $digest = '' }
            Add-Member -InputObject $e -NotePropertyName 'sha256' `
                       -NotePropertyValue $digest.ToLowerInvariant() -Force
            $all.Add($e) | Out-Null
        }

        $url = $null
        $linkHeader = $resp.Headers['Link']
        if ($linkHeader) {
            if ($linkHeader -is [array]) { $linkHeader = $linkHeader -join ', ' }
            if ($linkHeader -match '<([^>]+)>;\s*rel="next"') { $url = $Matches[1] }
        }
    }
    return $all
}

function Assert-SafeRelativePath {
    param([string]$Path)
    if (-not $Path -or [IO.Path]::IsPathRooted($Path) -or $Path -match '[\\:<>"|?*\x00-\x1F]') { throw 'Unsafe repository file path.' }
    foreach ($segment in $Path.Split('/')) {
        # The console device names and the superscript digit forms of COM/LPT are
        # reserved too, and NTFS caps a single name component at 255 characters.
        if (-not $segment -or $segment.Length -gt 255 -or $segment -in @('.', '..') -or
            $segment -match '[. ]$' -or
            $segment -match '^(?i:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)') {
            throw 'Unsafe repository file path.'
        }
    }
}

function Get-RemoteFileInfo {
    param([string]$Url, [string]$Token)
    # Deliberately do not follow the redirect. huggingface.co answers the first
    # hop with x-linked-size, the true size of an LFS file, and staying on that
    # host keeps the request inside the IPv4 pin above; the redirect target is a
    # CDN hostname that varies. Content-Length here is only the LFS pointer, so
    # it counts only when the file came back inline with a 200.
    $h = @{ 'User-Agent' = 'hf-download-ps/1.0' }
    if ($Token) { $h['Authorization'] = "Bearer $Token" }

    # First hop, no redirect. Every LFS file - which is every model weight worth
    # measuring - gets x-linked-size here, so the probe that matters never leaves
    # the host the IPv4 pin covers. Depending on the status code PS 5.1 either
    # returns this response or throws with it attached, so read both.
    $response = $null
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Head -Headers $h -UseBasicParsing `
                                      -MaximumRedirection 0 -TimeoutSec 20 -ErrorAction Stop
    } catch {
        if ($_.Exception.Response) { $response = $_.Exception.Response }
    }
    $size = $null
    $digest = ''
    if ($response) {
        $commit = ([string](Get-ResponseHeader $response 'x-repo-commit')).Trim().ToLowerInvariant()
        if ($commit -match '^[0-9a-f]{40}$') { $script:RepoCommit = $commit }

        # For an LFS object the ETag is the SHA-256 of the content, which is the only
        # digest a direct file link can be verified against.
        foreach ($name in @('x-linked-etag', 'ETag')) {
            $tag = ([string](Get-ResponseHeader $response $name)).Trim().Trim('"').TrimStart('W/').Trim('"')
            if ($tag -match '^[0-9a-f]{64}$') { $digest = $tag.ToLowerInvariant(); break }
        }

        $linked = Get-ResponseHeader $response 'x-linked-size'
        if ($linked) { $size = [int64]$linked }
    }

    # Small non-LFS files carry no x-linked-size, and Content-Length on a
    # redirect or an error is the length of that response's own body, not the
    # file. Follow through to the final 200 and only trust the length there.
    #
    # The follow-through used to be -MaximumRedirection 10 with $h still attached.
    # Windows PowerShell 5.1 does not strip a hand-set Authorization header across a
    # redirect, so that handed the bearer token to whichever CDN host answered - the
    # exact thing Invoke-HFApiRequest exists to prevent. Resolve-HFDownload walks the
    # chain properly and drops the credential the moment it leaves huggingface.co.
    if ($null -eq $size) {
        try {
            $resolved = Resolve-HFDownload -Url $Url -Token $Token
            $final = @{ 'User-Agent' = 'hf-download-ps/1.0' }
            if ($resolved.SendToken -and $Token) { $final['Authorization'] = "Bearer $Token" }
            $r = Invoke-WebRequest -Uri $resolved.Url -Method Head -Headers $final -UseBasicParsing `
                                   -MaximumRedirection $resolved.MaxRedirect -TimeoutSec 20 -ErrorAction Stop
            if ((Get-ResponseStatus $r) -eq 200) {
                $length = Get-ResponseHeader $r 'Content-Length'
                if ($length) { $size = [int64]$length }
            }
        } catch { }
    }
    return [pscustomobject]@{ Size = $size; Sha256 = $digest }
}

# Kept for callers that only want the number.
function Get-RemoteSize {
    param([string]$Url, [string]$Token)
    return (Get-RemoteFileInfo -Url $Url -Token $Token).Size
}

function Select-FilesFromTree {
    param($Files)

    Write-Host ''
    Write-Info ('Files in this repo ({0}):' -f $Files.Count)
    Write-Host ''
    for ($i = 0; $i -lt $Files.Count; $i++) {
        $size = if ($Files[$i].size) { Format-Size $Files[$i].size } else { '' }
        Write-Host ('  {0,3}. {1,-58} {2,10}' -f ($i + 1), $Files[$i].path, $size)
    }
    Write-Host ''
    Write-Host '  Enter numbers (1,4), a range (2-6), "all", or part of a filename.' -ForegroundColor DarkGray
    $sel = (Read-Host 'Which file(s)').Trim()
    if (-not $sel) { return @() }

    if ($sel -match '^(all|\*)$') { return $Files }

    $chosen = New-Object System.Collections.Generic.List[object]
    if ($sel -match '^[\d,\s\-]+$') {
        foreach ($tok in ($sel -split '[,\s]+' | Where-Object { $_ })) {
            if ($tok -match '^(\d+)\s*-\s*(\d+)$') {
                $a = [int]$Matches[1]; $b = [int]$Matches[2]
                if ($a -gt $b) { $t = $a; $a = $b; $b = $t }
                for ($n = $a; $n -le $b; $n++) {
                    if ($n -ge 1 -and $n -le $Files.Count) { $chosen.Add($Files[$n - 1]) | Out-Null }
                }
            } elseif ($tok -match '^\d+$') {
                $n = [int]$tok
                if ($n -ge 1 -and $n -le $Files.Count) { $chosen.Add($Files[$n - 1]) | Out-Null }
                else { Write-Warn2 ("  ignoring out-of-range number: {0}" -f $n) }
            }
        }
    } else {
        # substring match on the path
        $matched = @($Files | Where-Object { $_.path -like "*$sel*" })
        if ($matched.Count -eq 0) { Write-Warn2 ("No file matched '{0}'." -f $sel); return @() }
        foreach ($m in $matched) { $chosen.Add($m) | Out-Null }
    }

    return @($chosen | Sort-Object -Property path -Unique)
}

function Get-QuantName {
    param([string]$Path)
    # Prefer the filename; fall back to a quant-named parent directory.
    $pattern = '(?<![a-z0-9])((?:UD-)?(?:IQ[1-8](?:_[A-Z0-9]+)*|Q[1-8](?:_[A-Z0-9]+)*|TQ[12]_0|MXFP4|NVFP4|BF16|FP16|F16|F32))(?![a-z0-9])'
    # IgnoreCase on its own is culture-sensitive in .NET, and there is no inline flag for
    # culture invariance. On a Turkish or Azerbaijani system the dotless I means "IQ" does
    # not match "iq", so a perfectly ordinary repository reported no recognized
    # quantizations at all. Every token here is ASCII, so invariant is simply correct.
    $options = [Text.RegularExpressions.RegexOptions]'IgnoreCase, CultureInvariant'
    foreach ($part in @($Path.Split('/') | Select-Object -Last 1) + @($Path.Split('/'))) {
        $match = [regex]::Match($part, $pattern, $options)
        if ($match.Success) { return $match.Groups[1].Value.ToUpperInvariant() }
    }
    return ''
}

function Get-QuantBits {
    param([string]$Quant)
    if ($Quant -match '(?:IQ|Q|TQ)([1-8])') { return [int]$Matches[1] }
    if ($Quant -match 'FP4') { return 4 }
    if ($Quant -match '16') { return 16 }
    if ($Quant -match '32') { return 32 }
    return 0
}

function Get-CompanionKind {
    param([string]$Path)
    # Invariant for the same reason as Get-QuantName: these words contain "i", and a
    # Turkish locale does not consider "I" and "i" the same letter.
    $options = [Text.RegularExpressions.RegexOptions]'IgnoreCase, CultureInvariant'
    $is = { param($pattern) [regex]::IsMatch($Path, $pattern, $options) }
    if (-not (& $is '\.gguf$')) { return '' }
    if (& $is '(^|/)(mmproj|vision|vision_encoder|projector)([-_./]|$)') { return 'vision' }
    # A model with -MTP- in its name can contain its own MTP head. Only
    # explicit sidecar prefixes/directories are treated as separate downloads.
    if (& $is '(^|/)(mtp|draft|draft_model|nextn)([-_./]|$)') { return 'MTP' }
    return ''
}

function Get-ModelBundles {
    param([array]$Files)
    $groups = @{}
    foreach ($file in $Files) {
        $key = $file.path -replace '(?i)-\d{5}-of-\d{5}(?=\.gguf$)', ''
        if (-not $groups.ContainsKey($key)) { $groups[$key] = @() }
        $groups[$key] += $file
    }
    foreach ($key in @($groups.Keys | Sort-Object)) {
        $members = @($groups[$key] | Sort-Object path)
        $complete = $true
        $expected = 1
        $indices = @()
        foreach ($member in $members) {
            if ($member.path -match '-(\d{5})-of-(\d{5})\.gguf$') {
                $count = [int]$Matches[2]
                if ($expected -ne 1 -and $expected -ne $count) { $complete = $false }
                $expected = $count
                $indices += [int]$Matches[1]
            }
        }
        if ($indices.Count -gt 0) {
            if ($expected -ne $members.Count -or (@($indices | Sort-Object -Unique).Count -ne $expected) -or
                ($indices | Measure-Object -Minimum).Minimum -ne 1 -or ($indices | Measure-Object -Maximum).Maximum -ne $expected) { $complete = $false }
        }
        [pscustomobject]@{ Name = $key; Quant = (Get-QuantName $key); Files = $members
            Size = ($members | Measure-Object -Property size -Sum).Sum; Complete = $complete }
    }
}

function Read-PickerChoice {
    param([string]$Prompt, [array]$Labels, [int]$Default = -1)
    for ($i = 0; $i -lt $Labels.Count; $i++) {
        $suffix = if ($i -eq $Default) { ' [default]' } else { '' }
        Write-Host ('  {0}. {1}{2}' -f ($i + 1), $Labels[$i], $suffix)
    }
    while ($true) {
        $answer = (Read-Host "$Prompt (number, or B to go back)").Trim()
        if ($answer -match '^(b|back)$') { return -1 }
        if (-not $answer -and $Default -ge 0) { return $Default }
        $number = 0
        if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $Labels.Count) { return ($number - 1) }
        Write-Warn2 'Choose one of the listed numbers.'
    }
}

function Read-PickerYesNo {
    param([string]$Prompt)
    while ($true) {
        $answer = (Read-Host "$Prompt [y/N]").Trim()
        if (-not $answer -or $answer -match '^(n|no)$') { return $false }
        if ($answer -match '^(y|yes)$') { return $true }
        Write-Warn2 'Enter Y or N.'
    }
}

function Get-PickerDefault {
    $settings = Get-DownloaderSettings
    return [string]$settings.quant
}

function Set-PickerDefault {
    param([string]$Quant)
    try {
        $settings = Get-DownloaderSettings
        $settings.quant = $Quant
        Save-DownloaderSettings $settings
        Write-Ok "Default saved: $Quant"
    } catch { Write-Warn2 'Could not save the preference. Your file selection still works.' }
}

function Select-OneBundle {
    param([array]$Bundles, [string]$Prompt)
    if ($Bundles.Count -eq 1) { return $Bundles[0] }
    $labels = @($Bundles | ForEach-Object { '{0} ({1}; {2} file(s))' -f $_.Name, (Format-Size $_.Size), $_.Files.Count })
    $index = Read-PickerChoice -Prompt $Prompt -Labels $labels
    if ($index -lt 0) { return $null }
    return $Bundles[$index]
}

function Select-QuantizedFiles {
    param([array]$Files, [array]$CompanionFiles)
    $main = @($Files | Where-Object { $_.path -match '(?i)\.gguf$' -and -not (Get-CompanionKind $_.path) })
    $bundles = @(Get-ModelBundles -Files $main | Where-Object { $_.Quant })
    if (-not $bundles.Count) {
        Write-Warn2 'No recognized GGUF quantizations here. Choose specific files instead.'
        return @()
    }
    $preferred = Get-PickerDefault
    $bits = @($bundles | ForEach-Object { Get-QuantBits $_.Quant } | Sort-Object -Unique)
    while ($true) {
        Write-Info 'Choose bit level'
        $bitLabels = @($bits | ForEach-Object { "$_-bit" })
        $defaultBit = -1
        if ($preferred -and $preferred -in $bundles.Quant) { $defaultBit = [array]::IndexOf($bits, (Get-QuantBits $preferred)) }
        $bitIndex = Read-PickerChoice -Prompt 'Bit level' -Labels $bitLabels -Default $defaultBit
        if ($bitIndex -lt 0) { return @() }
        $quants = @($bundles | Where-Object { (Get-QuantBits $_.Quant) -eq $bits[$bitIndex] } | Select-Object -ExpandProperty Quant -Unique | Sort-Object)
        Write-Info 'Choose exact quantization'
        $quantIndex = Read-PickerChoice -Prompt 'Quantization' -Labels $quants -Default ([array]::IndexOf($quants, $preferred))
        if ($quantIndex -lt 0) { continue }
        $quant = $quants[$quantIndex]
        $bundle = Select-OneBundle -Bundles @($bundles | Where-Object { $_.Quant -eq $quant }) -Prompt 'Choose model'
        if (-not $bundle) { continue }
        if (-not $bundle.Complete) { Write-Warn2 'This split model is missing shards. Choose another model or check the repository.'; continue }
        Write-Ok ('Selected {0} ({1}, {2} file(s))' -f $bundle.Name, (Format-Size $bundle.Size), $bundle.Files.Count)
        if ($quant -ne $preferred -and (Read-PickerYesNo 'Remember this quantization as your default?')) { Set-PickerDefault $quant }
        $selected = @($bundle.Files)
        foreach ($kind in @('vision', 'MTP')) {
            $candidates = @(Get-ModelBundles -Files @($CompanionFiles | Where-Object { (Get-CompanionKind $_.path) -eq $kind }))
            if (-not $candidates.Count) {
                Write-Host "  No separate $kind file detected in this repository. It may be embedded or hosted elsewhere." -ForegroundColor DarkGray
                continue
            }
            Write-Info "Detected possible $kind companion(s) in this repository:"
            foreach ($candidate in $candidates) { Write-Host ('  {0} ({1})' -f $candidate.Name, (Format-Size $candidate.Size)) }
            if (-not (Read-PickerYesNo "Download a $kind companion too?")) { continue }
            $companion = Select-OneBundle -Bundles $candidates -Prompt "Choose the $kind file for this model"
            if ($companion) {
                if (-not $companion.Complete) { Write-Warn2 "The $kind companion is missing shards; returning to model selection."; $selected = @(); break }
                $selected += $companion.Files
            }
        }
        if (-not $selected.Count) { continue }
        Write-Info 'Download selection:'
        foreach ($file in $selected) { Write-Host ('  {0} ({1})' -f $file.path, (Format-Size $file.size)) }
        Write-Info ('Total: {0}' -f (Format-Size (($selected | Measure-Object size -Sum).Sum)))
        if (Read-PickerYesNo 'Download these files?') { return @($selected | Sort-Object path -Unique) }
    }
}

function Select-DownloadFiles {
    param([array]$Files, [array]$CompanionFiles)
    while ($true) {
        Write-Info 'How would you like to choose files?'
        $mode = Read-PickerChoice -Prompt 'Selection mode' -Labels @('Choose quantization', 'Choose specific files') -Default 0
        if ($mode -lt 0) { return @() }
        if ($mode -eq 1) { return @(Select-FilesFromTree -Files $Files) }
        $selected = @(Select-QuantizedFiles -Files $Files -CompanionFiles $CompanionFiles)
        if ($selected.Count) { return $selected }
    }
}

# --------------------------------------------------------------- downloading ---

# The transfer flags. -x 16 = 16 connections per server, -s 16 = split the file
# into 16 parts. min-split-size matters: aria2 defaults to 20M, which means -s 16
# silently does nothing on anything under ~320M.
function Get-Aria2Args {
    $a = @(
        '-x', [string]$script:TransferConnections,
        '-s', [string]$script:TransferConnections,
        '--min-split-size=1M',
        '--continue=true',
        '--auto-file-renaming=false',
        '--file-allocation=none',
        '--max-tries=5',
        '--retry-wait=3',
        '--timeout=60',
        '--connect-timeout=30',
        '--show-console-readout=true',   # live speed / percent / ETA line
        '--summary-interval=0',
        '--download-result=hide',
        '--console-log-level=warn',
        '--user-agent=hf-download-ps/1.0'
    )
    $a += '--disable-ipv6=true'
    # Without this aria2 reads %APPDATA%\aria2\aria2.conf and %USERPROFILE%\.aria2\aria2.conf.
    # Such a file can set check-certificate=false, redirect dir=, or run a program through
    # on-download-complete, none of which this script would see or report.
    $a += '--no-conf=true'
    return $a
}

# Every /resolve/ URL for an LFS file - which is every model weight - answers with a
# redirect to a different origin (cdn-lfs.huggingface.co, cas-bridge.xethub.hf.co and
# friends). aria2 replays --header values on every hop, so handing it an unresolved URL
# together with the bearer token means the token is sent to that third-party host. Those
# CDN URLs are pre-signed and need no credential at all.
#
# So the chain is walked here instead, exactly as Invoke-HFApiRequest does for listings:
# the token goes only to huggingface.co, and the moment the chain leaves that origin the
# signed URL is handed over with no header.
function Resolve-HFDownload {
    param([string]$Url, [string]$Token)
    $headers = @{ 'User-Agent' = 'hf-download-ps/1.0' }
    if ($Token) { $headers['Authorization'] = 'Bearer ' + $Token }
    $current = Assert-HFUrl $Url
    for ($hop = 0; $hop -le 10; $hop++) {
        try {
            $null = Invoke-WebRequest -Uri $current -Method Head -Headers $headers -UseBasicParsing `
                                      -MaximumRedirection 0 -TimeoutSec 30 -ErrorAction Stop
            # Served straight from huggingface.co. aria2 may carry the header, but only
            # because redirects are switched off for this item so it cannot be forwarded.
            return [pscustomobject]@{ Url = $current; SendToken = [bool]$Token; MaxRedirect = 0 }
        } catch {
            $response = $_.Exception.Response
            if (-not $response) { throw }
            $status = Get-ResponseStatus $response
            if ($status -lt 300 -or $status -gt 399) {
                throw (Get-HFAccessMessage $status)
            }
            $location = Get-ResponseHeader $response 'Location'
            if (-not $location) { throw 'Hugging Face returned an incomplete download redirect.' }
            $next = [uri]::new([uri]$current, [string]$location)
            if ($next.Scheme -ne 'https' -or $next.UserInfo) { throw 'Hugging Face returned an unsafe download address.' }
            if ($next.Host -ne 'huggingface.co') {
                # Left the origin: signed URL, no credential, and aria2 may follow the
                # rest of the chain on its own because there is nothing left to leak.
                return [pscustomobject]@{ Url = $next.AbsoluteUri; SendToken = $false; MaxRedirect = 10 }
            }
            $current = $next.AbsoluteUri
        }
    }
    throw 'Hugging Face redirected the download too many times.'
}

# Every download goes through a manifest on aria2's stdin, including single ones.
# A --header argument would put the bearer token on the command line, where any
# other process on the machine can read it for as long as the transfer runs, and
# a temp file would leave it on disk if the script were killed mid-download.
function New-Aria2Manifest {
    param([array]$Items, [string]$Token)
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Items) {
        # Resolve-HFDownload has already walked the redirect chain, so this is either a
        # signed CDN URL (no credential, aria2 may follow the rest) or a huggingface.co
        # URL that answered directly. A token is emitted only in the second case, and
        # always beside max-redirect=0 so aria2 cannot forward it anywhere.
        $url = $item.Url
        $sendToken = $true
        $maxRedirect = 0
        if ($item.PSObject.Properties['Resolved'] -and $item.Resolved) {
            $url         = $item.Resolved.Url
            $sendToken   = [bool]$item.Resolved.SendToken
            $maxRedirect = [int]$item.Resolved.MaxRedirect
        }
        $lines.Add($url)
        # Write to .part and rename only after the bytes check out, so an
        # interrupted transfer never leaves something at the real name that
        # later looks finished.
        $lines.Add('  out=' + $item.Out + '.part')
        $lines.Add('  max-redirect=' + $maxRedirect)
        if ($item.PSObject.Properties['Sha256'] -and $item.Sha256) {
            $lines.Add('  checksum=sha-256=' + $item.Sha256)
        }
        if ($Token -and $sendToken) { $lines.Add('  header=Authorization: Bearer ' + $Token) }
    }
    return (($lines -join "`n") + "`n")
}

# A run from before .part staging left its in-progress file at the final name
# with an .aria2 control file beside it. Adopt that rather than starting over.
function Move-StrandedDownload {
    param([string]$Target)
    $partial = $Target + '.part'
    if (Test-Path -LiteralPath $partial) { return }
    if (-not (Test-Path -LiteralPath $Target)) { return }
    if (-not (Test-Path -LiteralPath ($Target + '.aria2'))) { return }
    Move-Item -LiteralPath $Target -Destination $partial -Force
    Move-Item -LiteralPath ($Target + '.aria2') -Destination ($partial + '.aria2') -Force
}

# Is the file already on disk the file we were about to fetch? A matching size
# is the cheap first pass. When the API gave a SHA-256 the bytes are checked
# against it as well, because a same-size file is not necessarily the same file.
function Test-CompleteFile {
    param([string]$Path, $Size, [string]$Sha256)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if (Test-Path -LiteralPath ($Path + '.aria2')) { return $false }
    if ($Size -and (Get-Item -LiteralPath $Path).Length -ne $Size) { return $false }
    if ($Sha256) { return ((Get-FileSha256 -Path $Path) -eq $Sha256) }
    return [bool]$Size
}

# The gate a .part file has to pass before it is promoted to the real name.
# Unlike Test-CompleteFile this refuses a file of unknown size only when aria2
# also left a control file behind, since the transfer itself just reported ok.
# The server chooses the relative path, so confirm the resolved target really sits inside
# the destination, and that no directory on the way there is a symbolic link or junction
# someone placed beforehand. Assert-SafeRelativePath rejects the obvious traversals; this
# is the containment check that does not depend on having enumerated every trick.
function Assert-InsideDestination {
    param([string]$DestDir, [string]$Target)
    $root = [IO.Path]::GetFullPath($DestDir).TrimEnd('\') + '\'
    $full = [IO.Path]::GetFullPath($Target)
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('The download path escaped the selected folder: {0}' -f $Target)
    }
    # Windows PowerShell 5.1 does not opt into long paths even where the registry enables
    # them, and the download runs to "<name>.part", which is five characters longer than
    # the file the user is expecting. Checking here names the file and suggests the fix,
    # rather than failing later with a bare PathTooLongException.
    if (($full.Length + 6) -gt 260) {
        throw ('The full path would be {0} characters, past the {1}-character Windows limit: {2}. Choose a shorter download folder.' -f ($full.Length + 6), 260, $Target)
    }
    $current = $root.TrimEnd('\')
    foreach ($segment in ($full.Substring($root.Length) -split '\\')) {
        if (-not $segment) { continue }
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) { break }
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw ('Refusing to write through a symbolic link or junction: {0}' -f $current)
        }
    }
}

function Test-FinishedPartial {
    param([string]$Path, $Size, [string]$Sha256)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if (Test-Path -LiteralPath ($Path + '.aria2')) { return $false }
    if ($Size -and (Get-Item -LiteralPath $Path).Length -ne $Size) { return $false }
    if ($Sha256) { return ((Get-FileSha256 -Path $Path) -eq $Sha256) }
    # Fails closed. With neither a size nor a digest there is nothing that distinguishes a
    # complete file from one aria2 truncated while still exiting 0, and this function's
    # answer is what promotes a .part to its real name.
    if (-not $Size) { return $false }
    return $true
}

function Invoke-Aria2Download {
    param(
        [string]$Aria2,
        [array]$Items,         # objects with .Url, .Out (relative), .Size, .Sha256
        [string]$DestDir,
        [string]$Token
    )

    # Hugging Face repositories are git repositories made on Linux, so a handful of names
    # Windows cannot hold is ordinary. Throwing on the first one used to kill the whole
    # queue after the user had already chosen every file, with a message naming neither
    # the file nor the reason. Skip those and download the rest.
    $safe = New-Object System.Collections.Generic.List[object]
    $unsafe = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Items) {
        try { Assert-SafeRelativePath $item.Out; $safe.Add($item) | Out-Null }
        catch { $unsafe.Add([string]$item.Out) | Out-Null }
    }
    if ($unsafe.Count) {
        Write-Warn2 ('{0} file(s) cannot be saved under a Windows filename and will be skipped:' -f $unsafe.Count)
        foreach ($name in $unsafe) { Write-Warn2 ('    ' + $name) }
    }
    if (-not $safe.Count) { throw ('None of the {0} selected file(s) can be saved safely on Windows.' -f $Items.Count) }
    $Items = $safe.ToArray()

    if (-not (Test-Path -LiteralPath $DestDir)) {
        # See Save-DownloaderSettings: New-Item -Path would read [ ] as a wildcard.
        [IO.Directory]::CreateDirectory($DestDir) | Out-Null
    }

    # One destination path is fetched once. A queue that named the same file twice
    # used to be harmless; with .part staging the second copy would find the file
    # already promoted and report a phantom failure.
    #
    # The comparison is case-insensitive because the filesystem is. A repository holding
    # both Config.json and config.json is legal on Linux and one file here: with an
    # ordinal comparer both entries survived, and in a batch they went into one manifest
    # with the same out= line, so two aria2 workers wrote the same file at once.
    $unique = New-Object System.Collections.Generic.List[object]
    $seenOut = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $collisions = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Items) {
        if ($seenOut.Add($item.Out)) { $unique.Add($item) | Out-Null }
        elseif ($unique.Where({ $_.Out -ceq $item.Out }, 'First').Count -eq 0) { $collisions.Add([string]$item.Out) | Out-Null }
    }
    if ($collisions.Count) {
        Write-Warn2 ('{0} file(s) differ only by capitalisation from one already queued and will be skipped:' -f $collisions.Count)
        foreach ($name in $collisions) { Write-Warn2 ('    ' + $name) }
    }
    $Items = $unique.ToArray()

    # Counted over what is actually still to fetch. Summing every item meant a 50 GB
    # repository that was 45 GB downloaded still demanded 52 GB free, so the one thing
    # the user needed - finishing the last 5 GB - was the thing it refused to do.
    $needed = 0
    foreach ($item in $Items) {
        if (-not $item.Size) { continue }
        $target = Join-Path $DestDir ($item.Out -replace '/', '\')
        if (Test-CompleteFile -Path $target -Size $item.Size -Sha256 $item.Sha256) { continue }
        $remaining = $item.Size
        $partial = $target + '.part'
        if (Test-Path -LiteralPath $partial) {
            try { $remaining = $item.Size - (Get-Item -LiteralPath $partial).Length } catch { }
            if ($remaining -lt 0) { $remaining = $item.Size }
        }
        $needed += $remaining
    }
    Assert-FreeSpace -DestDir $DestDir -Needed $needed

    $lock = Lock-Destination -DestDir $DestDir
    try {
        Invoke-Aria2DownloadCore -Aria2 $Aria2 -Items $Items -DestDir $DestDir -Token $Token
    } finally {
        Unlock-Destination $lock
    }
}

function Invoke-Aria2DownloadCore {
    param(
        [string]$Aria2,
        [array]$Items,
        [string]$DestDir,
        [string]$Token
    )

    $total = $Items.Count
    $knownTotal = 0
    foreach ($it in $Items) { if ($it.Size) { $knownTotal += $it.Size } }

    Write-Host ''
    Write-Host ('  Saving to : {0}' -f $DestDir) -ForegroundColor DarkGray
    Write-Host ('  Transfer  : aria2c, {0} connections per file' -f $script:TransferConnections) -ForegroundColor DarkGray
    if ($total -gt 1) {
        $sizeNote = if ($knownTotal -gt 0) { ', ' + (Format-Size $knownTotal) + ' total' } else { '' }
        Write-Host ('  Queue     : {0} files{1}' -f $total, $sizeNote) -ForegroundColor DarkGray
    }

    $okCount = 0
    $skipCount = 0
    $failed = New-Object System.Collections.Generic.List[string]
    $bytesGot = 0
    $overall = [Diagnostics.Stopwatch]::StartNew()

    # Starting a fresh aria2 per file costs about a second (DNS + TLS + the HF
    # redirect). That is nothing next to a multi-GB model, but it adds up over a
    # pile of small config files. So: big files get their own live progress bar,
    # everything small goes out in one batched call.
    $soloMin = 50MB
    $solo  = @()
    $batch = @()
    foreach ($it in $Items) {
        if ((-not $it.Size) -or $it.Size -ge $soloMin) { $solo += $it } else { $batch += $it }
    }
    if ($batch.Count -eq 1) { $solo += $batch; $batch = @() }   # batching one file buys nothing

    $steps = $solo.Count + $(if ($batch.Count -gt 0) { 1 } else { 0 })
    $step  = 0

    foreach ($it in $solo) {
      # $ErrorActionPreference is Stop for the whole script, so a terminating error from
      # any one file - the target open in LM Studio, a path over 260 characters, an ACL
      # that denies the rename - used to unwind past every remaining file in the queue.
      # One file failing is a failure of that file.
      try {
        $step++
        $target = Join-Path $DestDir ($it.Out -replace '/', '\')

        Write-Host ''
        Write-Rule
        $sizeText = if ($it.Size) { '   ' + (Format-Size $it.Size) } else { '' }
        Write-Host ('  [{0}/{1}] {2}{3}' -f $step, $steps, $it.Out, $sizeText) -ForegroundColor White
        Write-Rule

        if (Test-CompleteFile -Path $target -Size $it.Size -Sha256 $it.Sha256) {
            Write-Host '  already downloaded - skipping' -ForegroundColor DarkYellow
            $skipCount++
            $bytesGot += $it.Size
            continue
        }

        Assert-InsideDestination -DestDir $DestDir -Target $target
        Move-StrandedDownload -Target $target
        $partial  = $target + '.part'
        $it | Add-Member -NotePropertyName Resolved -NotePropertyValue (Resolve-HFDownload -Url $it.Url -Token $Token) -Force
        $manifest = New-Aria2Manifest -Items @($it) -Token $Token
        $a2args   = @('--input-file=-', '--dir', $DestDir) + (Get-Aria2Args)

        $sw = [Diagnostics.Stopwatch]::StartNew()
        # Only stdin is redirected; output still goes straight to the console, so
        # the progress bar animates live.
        $manifest | & $Aria2 @a2args
        $code = $LASTEXITCODE
        $sw.Stop()
        Clear-Line

        if ($code -eq 0 -and (Test-FinishedPartial -Path $partial -Size $it.Size -Sha256 $it.Sha256)) {
            $len = (Get-Item -LiteralPath $partial).Length
            Move-Item -LiteralPath $partial -Destination $target -Force
            $bytesGot += $len
            $secs = [Math]::Max($sw.Elapsed.TotalSeconds, 0.001)
            $verified = if ($it.Sha256) { '  (SHA-256 verified)' } else { '' }
            Write-Host ('  done  {0}  in {1}  (avg {2}/s){3}' -f `
                        (Format-Size $len), (Format-Duration $sw.Elapsed), `
                        (Format-Size ($len / $secs)), $verified) -ForegroundColor Green
            $okCount++
        } else {
            if ($code -eq 0) {
                # aria2 was happy but the bytes were not what the listing promised.
                # The .part file stays put so it can be looked at, and because a
                # later run can resume it rather than restart.
                Write-Err '  FAILED  the file did not match its expected size or SHA-256.'
                Write-Warn2 ('  The partial download was kept at: {0}' -f $partial)
            } else {
                Write-Err ('  FAILED  (aria2c exit code {0})' -f $code)
                if ($code -eq 3)  { Write-Warn2 '  File not found on the server (404).' }
                if ($code -eq 22) { Write-Warn2 '  Access denied. Gated or private repo? Set HF_TOKEN and retry.' }
            }
            $failed.Add($it.Out) | Out-Null
        }
      } catch {
        Clear-Line
        Write-Err ('  FAILED  {0}' -f $_.Exception.Message)
        if ($_.Exception -is [IO.PathTooLongException]) { Write-Warn2 '  The full path is too long for Windows. Choose a shorter download folder.' }
        elseif ($_.Exception -is [IO.IOException]) { Write-Warn2 '  The file may be open in another program, such as LM Studio.' }
        $failed.Add($it.Out) | Out-Null
      }
    }

    if ($batch.Count -gt 0) {
        $step++
        $todo = @()
        foreach ($it in $batch) {
            $t = Join-Path $DestDir ($it.Out -replace '/', '\')
            if (Test-CompleteFile -Path $t -Size $it.Size -Sha256 $it.Sha256) {
                $skipCount++; $bytesGot += $it.Size
            } else {
                Move-StrandedDownload -Target $t
                $todo += $it
            }
        }

        $batchBytes = 0
        foreach ($it in $batch) { if ($it.Size) { $batchBytes += $it.Size } }

        Write-Host ''
        Write-Rule
        Write-Host ('  [{0}/{1}] {2} small files   {3}' -f `
                    $step, $steps, $batch.Count, (Format-Size $batchBytes)) -ForegroundColor White
        Write-Rule

        if ($todo.Count -eq 0) {
            Write-Host '  all already downloaded - skipping' -ForegroundColor DarkYellow
        } else {
            foreach ($item in $todo) {
                $item | Add-Member -NotePropertyName Resolved -NotePropertyValue (Resolve-HFDownload -Url $item.Url -Token $Token) -Force
            }
            $manifest = New-Aria2Manifest -Items $todo -Token $Token

            $a2args = @('--input-file=-', '--dir', $DestDir,
                        '--max-concurrent-downloads=5') + (Get-Aria2Args)

            $sw = [Diagnostics.Stopwatch]::StartNew()
            $manifest | & $Aria2 @a2args
            $code = $LASTEXITCODE
            $sw.Stop()
            Clear-Line

            # A file on disk is not a finished file: aria2 can exit non-zero with
            # truncated output and a leftover .aria2 control file. Judge each one
            # the same way the solo path does, or a half-written config lands in
            # the library reported as complete.
            $got = 0
            $batchFailed = 0
            foreach ($it in $todo) {
                # Per file, for the same reason the solo loop is: a rename that throws
                # must not take the rest of the batch down with it.
                try {
                    $t = Join-Path $DestDir ($it.Out -replace '/', '\')
                    Assert-InsideDestination -DestDir $DestDir -Target $t
                    $partial = $t + '.part'
                    if ($code -eq 0 -and (Test-FinishedPartial -Path $partial -Size $it.Size -Sha256 $it.Sha256)) {
                        $got++
                        $bytesGot += (Get-Item -LiteralPath $partial).Length
                        Move-Item -LiteralPath $partial -Destination $t -Force
                    } else {
                        $batchFailed++
                        $failed.Add($it.Out) | Out-Null
                    }
                } catch {
                    Write-Err ('  {0}: {1}' -f $it.Out, $_.Exception.Message)
                    $batchFailed++
                    $failed.Add($it.Out) | Out-Null
                }
            }
            $okCount += $got

            # Count only this batch: $failed already holds the solo failures above.
            if ($batchFailed -eq 0) {
                Write-Host ('  done  {0} files  in {1}' -f $got, (Format-Duration $sw.Elapsed)) `
                           -ForegroundColor Green
            } else {
                Write-Err ('  {0} of {1} small files failed (aria2c exit code {2})' -f `
                           $batchFailed, $todo.Count, $code)
            }
        }
    }

    $overall.Stop()

    Write-Host ''
    Write-Rule
    if ($failed.Count -eq 0) {
        Write-Ok ('  All done.  {0} downloaded{1}  |  {2}  |  {3}' -f `
                  $okCount,
                  $(if ($skipCount) { ", $skipCount skipped" } else { '' }),
                  (Format-Size $bytesGot),
                  (Format-Duration $overall.Elapsed))
    } else {
        Write-Warn2 ('  Finished with problems: {0} ok, {1} failed.' -f $okCount, $failed.Count)
        foreach ($f in $failed) { Write-Host ('    x {0}' -f $f) -ForegroundColor Red }
    }
    if ($okCount -gt 0 -or $skipCount -gt 0) {
        Write-Host ('  Files are in: {0}' -f $DestDir) -ForegroundColor DarkGray
    }
    Write-Rule
}

# -------------------------------------------------------------------- main ---

function Invoke-OneLink {
    param([string]$Link, [string]$Aria2, [string]$ModelsDir, [string]$Token)

    $info = ConvertFrom-HFLink -Link $Link
    if (-not $info) { Write-Err 'That does not look like a Hugging Face link.'; return }

    Write-Host ''
    Write-Info ('Repo: {0}  ({1}, branch {2})' -f $info.Repo, $info.Kind, $info.Rev)

    # Cleared per link so a repo that reports no commit cannot inherit the one
    # from the previous link in the same session.
    $script:RepoCommit = ''
    $encRev = ($info.Rev -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    $items  = @()
    # Mirror Hugging Face's owner/repository layout, which is also LM Studio's
    # normal library layout. It prevents files from separate repos colliding,
    # while keeping MTP, mmproj/vision, tokenizer, and other companion files
    # together with the GGUF that uses them.
    $dest   = Join-Path $ModelsDir ($info.Repo -replace '/', '\')
    if ($info.Kind -ne 'models') { $dest = Join-Path (Join-Path $ModelsDir $info.Kind) ($info.Repo -replace '/', '\') }

    if ($info.IsFile) {
        $encPath = ($info.Path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
        $fileUrl = "$($info.WebBase)/resolve/$encRev/$encPath`?download=true"
        Write-Host 'Checking file size...' -ForegroundColor DarkGray
        $probe  = Get-RemoteFileInfo -Url $fileUrl -Token $Token
        $size   = $probe.Size
        $digest = $probe.Sha256
        if (-not $size -and -not $digest) {
            throw 'Hugging Face reported neither a size nor a checksum for that file, so a finished download could not be told from a truncated one. Paste the repository link instead of the direct file link.'
        }
        # The probe above may have reported the commit this branch points at.
        # Pin to it so the bytes fetched are the ones that were just measured.
        if ($script:RepoCommit) {
            $fileUrl = "$($info.WebBase)/resolve/$($script:RepoCommit)/$encPath`?download=true"
        }
        $items = @([pscustomobject]@{
            Url  = $fileUrl
            # Retain a direct-link file's repo-relative path too. For example,
            # an MTP/ or vision/ companion remains beside its main model rather
            # than being flattened into the repository root.
            Out    = $info.Path
            Size   = $size
            # For an LFS object this is the content SHA-256 from the ETag. A direct file
            # link used to carry no digest at all, which left size as the only check -
            # and size was allowed to be unknown, so nothing was checked.
            Sha256 = $digest
        })
    } else {
        Write-Info 'Listing repo files...'
        try {
            $tree = Get-HFTree -Info $info -Token $Token
        } catch {
            Write-Err ('Could not list the repo: {0}' -f $_.Exception.Message)
            Write-Warn2 'If it is gated or private, set HF_TOKEN first.'
            return
        }

        $files = @($tree | Where-Object { $_.type -eq 'file' } | Sort-Object path)
        if ($files.Count -eq 0) { Write-Warn2 'No files found there.'; return }

        $companionFiles = $files
        if ($info.Path) {
            # Search the repo root as companions often live outside the quant folder.
            $rootInfo = $info.PSObject.Copy()
            $rootInfo.Path = ''
            # Get-HFTree clears $script:RepoCommit before its first request, so a failure
            # here used to leave the pin blank and silently fall back to the mutable
            # branch name - defeating the guarantee printed a few lines below. Keep the
            # commit the folder listing established.
            $pinnedCommit = $script:RepoCommit
            try {
                $companionFiles = @(Get-HFTree -Info $rootInfo -Token $Token | Where-Object { $_.type -eq 'file' })
            } catch {
                Write-Warn2 'Could not check the rest of the repository for companions; only this folder was checked.'
            } finally {
                if (-not $script:RepoCommit) { $script:RepoCommit = $pinnedCommit }
            }
        }
        $picked = @(Select-DownloadFiles -Files $files -CompanionFiles $companionFiles)
        if ($picked.Count -eq 0) { Write-Warn2 'Nothing selected.'; return }

        # Download from the exact commit the listing came from. A branch that
        # moves between listing and download would otherwise hand back different
        # bytes than the sizes and hashes shown a moment ago.
        if ($script:RepoCommit) {
            $encRev = $script:RepoCommit
            Write-Host ('  Pinned to commit {0}' -f $script:RepoCommit.Substring(0, 12)) -ForegroundColor DarkGray
        }

        foreach ($f in $picked) {
            $encPath = ($f.path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
            $digest = ''
            if ($f.PSObject.Properties['sha256']) { $digest = [string]$f.sha256 }
            $items += [pscustomobject]@{
                Url    = "$($info.WebBase)/resolve/$encRev/$encPath`?download=true"
                Out    = $f.path
                Size   = $f.size
                Sha256 = $digest
            }
        }
    }

    Invoke-Aria2Download -Aria2 $Aria2 -Items $items -DestDir $dest -Token $Token
}

Clear-Host
Write-Host '=========================================' -ForegroundColor DarkCyan
Write-Host '  Hugging Face -> aria2c downloader'       -ForegroundColor DarkCyan
Write-Host '=========================================' -ForegroundColor DarkCyan

Enable-IPv4Only
$models = Get-DownloadFolder -Requested $OutputDir
Write-Host ('Saving to: {0}' -f $models) -ForegroundColor DarkGray

$aria2 = Resolve-Aria2Path
if (-not $aria2) { $aria2 = Install-Aria2 }
if (-not $aria2) { Write-Host ''; Read-Host 'Press Enter to close'; exit 1 }

$token = Get-HFToken
if ($token) { Write-Host 'Using a Hugging Face token from the environment or token cache.' -ForegroundColor DarkGray }

$first = $true
while ($true) {
    Write-Host ''
    if ($first -and $Url) {
        $link = $Url
        Write-Host ("Link: {0}" -f $link)
    } else {
        $link = (Read-Host 'Paste Hugging Face link (blank to quit)').Trim()
    }
    $first = $false
    if (-not $link) { break }

    try {
        Invoke-OneLink -Link $link -Aria2 $aria2 -ModelsDir $models -Token $token
    } catch {
        Write-Err ('Error: {0}' -f $_.Exception.Message)
    }
}

Write-Host ''
Write-Host 'Bye.' -ForegroundColor DarkGray

