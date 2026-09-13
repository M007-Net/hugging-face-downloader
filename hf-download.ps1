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
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
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
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
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
        if ($v) { return $v.Trim() }
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
        if ($t) { return $t }
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

    $parts = @($s -split '/' | Where-Object { $_ -ne '' })
    if ($parts.Count -eq 0) { return $null }

    $kind = 'models'
    if ($parts[0] -eq 'datasets') { $kind = 'datasets'; $parts = $parts[1..($parts.Count - 1)] }
    elseif ($parts[0] -eq 'spaces') { $kind = 'spaces';  $parts = $parts[1..($parts.Count - 1)] }

    if ($parts.Count -eq 0) { return $null }

    # repo id: "owner/name", or just "name" for canonical repos like gpt2
    if ($parts.Count -ge 2 -and $parts[1] -notin @('blob', 'resolve', 'tree', 'raw')) {
        $repo = $parts[0] + '/' + $parts[1]
        $rest = @()
        if ($parts.Count -gt 2) { $rest = $parts[2..($parts.Count - 1)] }
    } else {
        $repo = $parts[0]
        $rest = @()
        if ($parts.Count -gt 1) { $rest = $parts[1..($parts.Count - 1)] }
    }

    $rev  = 'main'
    $path = ''
    $isFile = $false

    if ($rest.Count -gt 0) {
        $verb = $rest[0]
        if ($verb -in @('blob', 'resolve', 'tree', 'raw')) {
            $rest = if ($rest.Count -gt 1) { $rest[1..($rest.Count - 1)] } else { @() }
            if ($rest.Count -gt 0) {
                # branch names like refs/pr/3 span three segments
                if ($rest[0] -eq 'refs' -and $rest.Count -ge 3) {
                    $rev  = ($rest[0..2]) -join '/'
                    $rest = if ($rest.Count -gt 3) { $rest[3..($rest.Count - 1)] } else { @() }
                } else {
                    $rev  = $rest[0]
                    $rest = if ($rest.Count -gt 1) { $rest[1..($rest.Count - 1)] } else { @() }
                }
            }
            $path = ($rest -join '/')
            $isFile = ($verb -in @('blob', 'resolve', 'raw')) -and $path -ne ''
        }
    }

    $prefix = switch ($kind) { 'datasets' { 'datasets/' } 'spaces' { 'spaces/' } default { '' } }
    if ($repo -notmatch '^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)?$') { return $null }
    $path = [uri]::UnescapeDataString($path)
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

    $all = New-Object System.Collections.Generic.List[object]
    $guard = 0
    while ($url -and $guard -lt 50) {
        $guard++
        $resp = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -MaximumRedirection 5
        $page = $resp.Content | ConvertFrom-Json
        foreach ($e in $page) { $all.Add($e) | Out-Null }

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
        if (-not $segment -or $segment -in @('.', '..') -or $segment -match '[. ]$' -or
            $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe repository file path.' }
    }
}

function Get-RemoteSize {
    param([string]$Url, [string]$Token)
    try {
        $h = @{ 'User-Agent' = 'hf-download-ps/1.0' }
        if ($Token) { $h['Authorization'] = "Bearer $Token" }
        $r = Invoke-WebRequest -Uri $Url -Method Head -Headers $h -UseBasicParsing `
                               -MaximumRedirection 10 -TimeoutSec 20
        foreach ($name in @('x-linked-size', 'Content-Length')) {
            $v = $r.Headers[$name]
            if ($v -is [array]) { $v = $v[0] }
            if ($v) { return [int64]$v }
        }
    } catch { }
    return $null
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
    $pattern = '(?i)(?<![a-z0-9])((?:UD-)?(?:IQ[1-8](?:_[A-Z0-9]+)*|Q[1-8](?:_[A-Z0-9]+)*|TQ[12]_0|MXFP4|NVFP4|BF16|FP16|F16|F32))(?![a-z0-9])'
    foreach ($part in @($Path.Split('/') | Select-Object -Last 1) + @($Path.Split('/'))) {
        if ($part -match $pattern) { return $Matches[1].ToUpperInvariant() }
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
    if ($Path -notmatch '(?i)\.gguf$') { return '' }
    if ($Path -match '(?i)(^|/)(mmproj|vision|vision_encoder|projector)([-_./]|$)') { return 'vision' }
    # A model with -MTP- in its name can contain its own MTP head. Only
    # explicit sidecar prefixes/directories are treated as separate downloads.
    if ($Path -match '(?i)(^|/)(mtp|draft|draft_model|nextn)([-_./]|$)') { return 'MTP' }
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
    param([string]$Token)
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
    if ($Token) { $a += "--header=Authorization: Bearer $Token" }
    return $a
}

function Test-CompleteFile {
    param([string]$Path, $Size)
    if (-not $Size) { return $false }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if (Test-Path -LiteralPath ($Path + '.aria2')) { return $false }
    return ((Get-Item -LiteralPath $Path).Length -eq $Size)
}

function Invoke-Aria2Download {
    param(
        [string]$Aria2,
        [array]$Items,         # objects with .Url, .Out (relative), .Size (may be $null)
        [string]$DestDir,
        [string]$Token
    )

    foreach ($item in $Items) { Assert-SafeRelativePath $item.Out }
    if (-not (Test-Path -LiteralPath $DestDir)) {
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    }

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
        $step++
        $target = Join-Path $DestDir ($it.Out -replace '/', '\')

        Write-Host ''
        Write-Rule
        $sizeText = if ($it.Size) { '   ' + (Format-Size $it.Size) } else { '' }
        Write-Host ('  [{0}/{1}] {2}{3}' -f $step, $steps, $it.Out, $sizeText) -ForegroundColor White
        Write-Rule

        if (Test-CompleteFile -Path $target -Size $it.Size) {
            Write-Host '  already downloaded - skipping' -ForegroundColor DarkYellow
            $skipCount++
            $bytesGot += $it.Size
            continue
        }

        $a2args = @($it.Url, '--dir', $DestDir, '--out', $it.Out) + (Get-Aria2Args -Token $Token)

        $sw = [Diagnostics.Stopwatch]::StartNew()
        & $Aria2 @a2args          # NOT redirected, so the progress bar animates live
        $code = $LASTEXITCODE
        $sw.Stop()
        Clear-Line

        if ($code -eq 0 -and (Test-Path -LiteralPath $target)) {
            $len = (Get-Item -LiteralPath $target).Length
            $bytesGot += $len
            $secs = [Math]::Max($sw.Elapsed.TotalSeconds, 0.001)
            Write-Host ('  done  {0}  in {1}  (avg {2}/s)' -f `
                        (Format-Size $len), (Format-Duration $sw.Elapsed), (Format-Size ($len / $secs))) `
                        -ForegroundColor Green
            $okCount++
        } else {
            Write-Err ('  FAILED  (aria2c exit code {0})' -f $code)
            if ($code -eq 3)  { Write-Warn2 '  File not found on the server (404).' }
            if ($code -eq 22) { Write-Warn2 '  Access denied. Gated or private repo? Set HF_TOKEN and retry.' }
            $failed.Add($it.Out) | Out-Null
        }
    }

    if ($batch.Count -gt 0) {
        $step++
        $todo = @()
        foreach ($it in $batch) {
            $t = Join-Path $DestDir ($it.Out -replace '/', '\')
            if (Test-CompleteFile -Path $t -Size $it.Size) { $skipCount++; $bytesGot += $it.Size }
            else { $todo += $it }
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
            $lines = @()
            foreach ($it in $todo) { $lines += $it.Url; $lines += ('  out=' + $it.Out) }
            $listFile = Join-Path ([IO.Path]::GetTempPath()) `
                                  ("hf-aria2-{0}.txt" -f ([guid]::NewGuid().ToString('N')))
            [IO.File]::WriteAllLines($listFile, $lines, (New-Object Text.UTF8Encoding($false)))

            $a2args = @('--input-file', $listFile, '--dir', $DestDir,
                        '--max-concurrent-downloads=5') + (Get-Aria2Args -Token $Token)

            $sw = [Diagnostics.Stopwatch]::StartNew()
            try {
                & $Aria2 @a2args
                $code = $LASTEXITCODE
            } finally {
                Remove-Item -LiteralPath $listFile -Force -ErrorAction SilentlyContinue
            }
            $sw.Stop()
            Clear-Line

            $got = 0
            foreach ($it in $todo) {
                $t = Join-Path $DestDir ($it.Out -replace '/', '\')
                if (Test-Path -LiteralPath $t) {
                    $got++
                    $bytesGot += (Get-Item -LiteralPath $t).Length
                } else {
                    $failed.Add($it.Out) | Out-Null
                }
            }
            $okCount += $got

            if ($failed.Count -eq 0) {
                Write-Host ('  done  {0} files  in {1}' -f $got, (Format-Duration $sw.Elapsed)) `
                           -ForegroundColor Green
            } else {
                Write-Err ('  {0} of {1} small files failed (aria2c exit code {2})' -f `
                           ($todo.Count - $got), $todo.Count, $code)
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

    $encRev = ($info.Rev -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    $items  = @()
    # Mirror Hugging Face's owner/repository layout, which is also LM Studio's
    # normal library layout. It prevents files from separate repos colliding,
    # while keeping MTP, mmproj/vision, tokenizer, and other companion files
    # together with the GGUF that uses them.
    $dest   = Join-Path $ModelsDir (($info.Repo -replace '/', '\\'))
    if ($info.Kind -ne 'models') { $dest = Join-Path (Join-Path $ModelsDir $info.Kind) ($info.Repo -replace '/', '\') }

    if ($info.IsFile) {
        $encPath = ($info.Path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
        $fileUrl = "$($info.WebBase)/resolve/$encRev/$encPath`?download=true"
        Write-Host 'Checking file size...' -ForegroundColor DarkGray
        $size = Get-RemoteSize -Url $fileUrl -Token $Token
        $items = @([pscustomobject]@{
            Url  = $fileUrl
            # Retain a direct-link file's repo-relative path too. For example,
            # an MTP/ or vision/ companion remains beside its main model rather
            # than being flattened into the repository root.
            Out  = $info.Path
            Size = $size
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
            try {
                $companionFiles = @(Get-HFTree -Info $rootInfo -Token $Token | Where-Object { $_.type -eq 'file' })
            } catch {
                Write-Warn2 'Could not check the rest of the repository for companions; only this folder was checked.'
            }
        }
        $picked = @(Select-DownloadFiles -Files $files -CompanionFiles $companionFiles)
        if ($picked.Count -eq 0) { Write-Warn2 'Nothing selected.'; return }

        foreach ($f in $picked) {
            $encPath = ($f.path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
            $out = $f.path
            $items += [pscustomobject]@{
                Url  = "$($info.WebBase)/resolve/$encRev/$encPath`?download=true"
                Out  = $out
                Size = $f.size
            }
        }
    }

    Invoke-Aria2Download -Aria2 $Aria2 -Items $items -DestDir $dest -Token $Token
}

Clear-Host
Write-Host '=========================================' -ForegroundColor DarkCyan
Write-Host '  Hugging Face -> aria2c downloader'       -ForegroundColor DarkCyan
Write-Host '=========================================' -ForegroundColor DarkCyan

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

