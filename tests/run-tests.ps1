$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path $PSScriptRoot -Parent) 'hf-download.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Import definitions only: never run the downloader entry point or transfer engine.
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text.Replace('$PSScriptRoot', ("'" + $PSScriptRoot.Replace("'", "''") + "'")))) }
}
$script:AppSettingsPath = Join-Path ([IO.Path]::GetTempPath()) ('hf-downloader-test-' + [guid]::NewGuid().ToString('N') + '.json')
$script:checks = 0
function Assert($condition, $message) { if (-not $condition) { throw $message }; $script:checks++ }
function File($path) { [pscustomobject]@{ path = $path; size = 1024; type = 'file' } }
foreach ($pair in @(
    @('model-IQ3_XXS.gguf', 'IQ3_XXS'), @('model-UD-IQ3_S.gguf', 'UD-IQ3_S'),
    @('Q4_K_M/model-00001-of-00002.gguf','Q4_K_M'), @('model-Q8_0.gguf','Q8_0'),
    @('model-BF16.gguf','BF16'), @('model-IQ4_XS.gguf','IQ4_XS'), @('model-TQ1_0.gguf','TQ1_0')
)) { Assert ((Get-QuantName $pair[0]) -eq $pair[1]) "Quant parsing failed: $($pair[0])" }
Assert ((Get-CompanionKind 'MTP/model-Q8_0.gguf') -eq 'MTP') 'MTP directory'
Assert ((Get-CompanionKind 'mtp-model-Q8_0.gguf') -eq 'MTP') 'MTP prefix'
Assert ((Get-CompanionKind 'mmproj-model-F16.gguf') -eq 'vision') 'Vision prefix'
Assert ((Get-CompanionKind 'model-MTP-Q4_K_M.gguf') -eq '') 'Embedded MTP main model was excluded'
Assert ((Get-CompanionKind 'MTP/README.md') -eq '') 'Non-model companion'
$files = @((File 'IQ3_XXS/model-IQ3_XXS-00001-of-00002.gguf'), (File 'IQ3_XXS/model-IQ3_XXS-00002-of-00002.gguf'),
    (File 'model-Q4_K_M.gguf'), (File 'mmproj-F16.gguf'), (File 'MTP/mtp-Q8_0.gguf'), (File 'README.md'))
$bundles = @(Get-ModelBundles $files[0..1])
Assert ($bundles.Count -eq 1 -and $bundles[0].Files.Count -eq 2 -and $bundles[0].Complete) 'Complete shards'
$missing = @(Get-ModelBundles @($files[0]))
Assert (-not $missing[0].Complete) 'Missing shards'
$different = @(Get-ModelBundles @((File 'model-a-Q4_K_M.gguf'), (File 'model-b-Q4_K_M.gguf')))
Assert ($different.Count -eq 2) 'Different models merged'
function Read-Host { param($Prompt); if (-not $script:answers.Count) { throw "Unexpected prompt: $Prompt" }; $script:answers.Dequeue() }
function Get-PickerDefault { return 'IQ3_XXS' }
function Set-PickerDefault { param($Quant); $script:saved = $Quant }
function Answers([string[]]$values) { $script:answers = New-Object 'System.Collections.Generic.Queue[string]'; foreach ($value in $values) { $script:answers.Enqueue($value) } }
Answers @('', '', '', 'y', 'y', 'y')
$picked = @(Select-DownloadFiles -Files $files -CompanionFiles $files)
Assert ($picked.Count -eq 4) 'Default quant with both companions'
Assert ($script:answers.Count -eq 0) 'Unused default flow answers'
Answers @('1', '2', '1', 'y', 'n', 'n', 'y')
$picked = @(Select-DownloadFiles -Files $files -CompanionFiles $files)
Assert ($picked.Count -eq 1 -and $picked[0].path -eq 'model-Q4_K_M.gguf') 'Different quant / decline companions'
Assert ($script:saved -eq 'Q4_K_M') 'Save chosen default'
Answers @('2', '1-2')
$picked = @(Select-DownloadFiles -Files $files -CompanionFiles $files)
Assert ($picked.Count -eq 2) 'Manual selection regression'
Answers @('oops', '9', 'b')
$choice = Read-PickerChoice -Prompt 'test' -Labels @('one')
Assert ($choice -eq -1) 'Invalid menu handling'
Answers @('1', 'b', 'b')
$picked = @(Select-DownloadFiles -Files $files -CompanionFiles $files)
Assert ($picked.Count -eq 0) 'Back navigation'
Answers @('1', '2', '1', 'n', 'y')
$picked = @(Select-DownloadFiles -Files @($files[0..2]) -CompanionFiles @())
Assert ($picked.Count -eq 1) 'No companion repository'
# Confirm the actual preference serialization survives a new read.
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $statement.Name -in @('Get-PickerDefault','Set-PickerDefault')) { . ([scriptblock]::Create($statement.Extent.Text.Replace('$PSScriptRoot', ("'" + $PSScriptRoot.Replace("'", "''") + "'")))) }
}
Set-PickerDefault 'IQ3_XXS'
Assert ((Get-PickerDefault) -eq 'IQ3_XXS') 'Preference round trip'

# Exercise full link-to-queue integration with mocked repository and transfers.
function Get-HFTree { param($Info, $Token); $script:queriedPaths += $Info.Path; if ($Info.Path) { return $script:files[0..1] }; return $script:files }
function Invoke-Aria2Download { param($Aria2, $Items, $DestDir, $Token); $script:queue = @($Items) }
$script:queriedPaths = @()
Answers @('', '', '', 'y', 'y', 'y')
Invoke-OneLink -Link 'https://huggingface.co/example/repo/tree/main/IQ3_XXS' -Aria2 'unused' -ModelsDir $PSScriptRoot -Token ''
Assert ($script:queue.Count -eq 4) 'Subfolder companion discovery'
Assert ($script:queriedPaths.Count -eq 2 -and $script:queriedPaths[1] -eq '') 'Companions searched at repo root'
Assert ($script:queue[0].Out -like 'IQ3_XXS/*') 'Repo relative output path preserved'
Assert ($script:queue[0].Url -like 'https://huggingface.co/example/repo/resolve/main/*') 'Queue URL'

$liveData = Get-Content (Join-Path $PSScriptRoot 'repository-fixture.json') -Raw | ConvertFrom-Json
$live = @($liveData | Where-Object { $_.type -eq 'file' })
$liveMain = @($live | Where-Object { $_.path -match '\.gguf$' -and -not (Get-CompanionKind $_.path) })
$liveBundles = @(Get-ModelBundles $liveMain)
Assert (@($liveBundles | Where-Object { $_.Quant -eq 'IQ4_XS' }).Count -eq 1) 'Fixture IQ4_XS'
Assert (@($live | Where-Object { (Get-CompanionKind $_.path) -eq 'MTP' }).Count -gt 0) 'Fixture MTP detection'
Assert (@($live | Where-Object { (Get-CompanionKind $_.path) -eq 'vision' }).Count -gt 0) 'Fixture vision detection'
Assert (@($liveBundles | Where-Object { $_.Quant -eq 'BF16' -and $_.Files.Count -eq 2 -and $_.Complete }).Count -eq 1) 'Fixture split grouping'
$script:TransferConnections = 4
$script:TransferDisableIPv6 = $true
$transferArgs = @(Get-Aria2Args)
Assert ($transferArgs[1] -eq '4' -and $transferArgs[3] -eq '4') 'Configurable connections'
Assert ('--disable-ipv6=true' -in $transferArgs) 'IPv4-only transfer mode'
$script:TransferDisableIPv6 = $false
Assert ('--disable-ipv6=true' -in @(Get-Aria2Args)) 'IPv4-only mode cannot be disabled'
# The bearer token must never reach the command line, where every other process
# on the machine can read it, and never a file on disk, where a killed run would
# leave it behind. It goes to aria2 on stdin and nowhere else.
Assert (-not (@(Get-Aria2Args) -match 'Authorization')) 'Token is not passed as an argument'
$digest = 'ab' * 32
$manifest = New-Aria2Manifest -Items @([pscustomobject]@{
    Url = 'https://huggingface.co/a/b/resolve/main/m.gguf'; Out = 'm.gguf'; Sha256 = $digest }) -Token 'secret-token'
Assert ($manifest -match "`n") 'The manifest is content, not the path of a file on disk'
Assert ($manifest -match 'header=Authorization: Bearer secret-token') 'Token travels in the manifest'
Assert ($manifest -match '(?m)^\s+out=m\.gguf\.part\s*$') 'Manifest downloads to a .part file'
Assert ($manifest -match ('(?m)^\s+checksum=sha-256=' + $digest + '\s*$')) 'Manifest carries the LFS digest'
$anonManifest = New-Aria2Manifest -Items @([pscustomobject]@{ Url = 'https://x/y'; Out = 'y'; Sha256 = '' }) -Token ''
Assert ($anonManifest -notmatch 'Authorization') 'No auth header without a token'
Assert ($anonManifest -notmatch 'checksum') 'No checksum line without a digest'

# --- token shape -------------------------------------------------------------
# A control character would end the header line early and let the rest of the
# token be read as another aria2 option.
foreach ($badToken in @("hf_abc`ndef", "hf_abc`tdef", "hf_abc`0def", ('hf_' + ('a' * 5000)))) {
    $rejected = $false
    try { Assert-ValidToken $badToken } catch { $rejected = $true }
    Assert $rejected 'Reject a malformed token'
}
Assert ((Assert-ValidToken 'hf_QwErTy1234567890') -eq 'hf_QwErTy1234567890') 'Accept an ordinary token'

# --- pagination destinations -------------------------------------------------
foreach ($badUrl in @('http://huggingface.co/api/models/a/b/tree/main',
                      'https://evil.example.com/api/models/a/b/tree/main',
                      'https://huggingface.co.evil.example/api/models/a/b',
                      'https://user:pass@huggingface.co/api/models/a/b',
                      'not-a-url')) {
    $rejected = $false
    try { Assert-HFUrl $badUrl } catch { $rejected = $true }
    Assert $rejected "Reject pagination URL $badUrl"
}
Assert ((Assert-HFUrl 'https://huggingface.co/api/models/a/b/tree/main?cursor=2') -like 'https://huggingface.co/*') 'Accept a huggingface.co pagination URL'

# --- repository listing ------------------------------------------------------
# Drive Get-HFTree against a stand-in for the HTTP layer. Nothing here touches
# the network; the point is what the walk does with what a server sends back.
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $statement.Name -eq 'Get-HFTree') { . ([scriptblock]::Create($statement.Extent.Text)) }
}
$fakeInfo = [pscustomobject]@{ ApiBase = 'https://huggingface.co/api/models/a/b'; Rev = 'main'; Path = '' }

$script:pageHits = 0
function Invoke-HFApiRequest {
    param([string]$Url, [hashtable]$Headers)
    $script:pageHits++
    return [pscustomobject]@{ Content = '[]'; Headers = @{
        'Link' = '<https://huggingface.co/api/models/a/b/tree/main?cursor=loop>; rel="next"' } }
}
$cycleMessage = ''
try { Get-HFTree -Info $fakeInfo -Token '' } catch { $cycleMessage = $_.Exception.Message }
Assert ($cycleMessage -match 'repeating') 'A file list that points back at itself is refused'
Assert ($script:pageHits -eq 2) 'The repeat is caught on the second fetch, not after 100'

$script:pageHits = 0
function Invoke-HFApiRequest {
    param([string]$Url, [hashtable]$Headers)
    $script:pageHits++
    return [pscustomobject]@{ Content = '[]'; Headers = @{
        'Link' = ('<https://huggingface.co/api/models/a/b/tree/main?cursor={0}>; rel="next"' -f $script:pageHits) } }
}
$capMessage = ''
try { Get-HFTree -Info $fakeInfo -Token '' } catch { $capMessage = $_.Exception.Message }
Assert ($capMessage -match 'too many files') 'An endless file list is refused'
Assert ($script:pageHits -eq 100) 'Listing stops after 100 pages'

function Invoke-HFApiRequest {
    param([string]$Url, [hashtable]$Headers)
    return [pscustomobject]@{ Content = '[]'; Headers = @{
        'Link' = '<https://evil.example.com/api/models/a/b>; rel="next"' } }
}
$swapped = $false
try { Get-HFTree -Info $fakeInfo -Token '' } catch { $swapped = $true }
Assert $swapped 'A next-page link pointing at another host is refused'

function Invoke-HFApiRequest {
    param([string]$Url, [hashtable]$Headers)
    return [pscustomobject]@{
        Content = ('[{"type":"file","path":"m.gguf","size":10,"lfs":{"sha256":"' + ('ab' * 32) +
                   '"}},{"type":"file","path":"n.gguf","size":10,"lfs":{"oid":"sha256:' + ('cd' * 32) +
                   '"}},{"type":"file","path":"r.md","size":2}]')
        Headers = @{ 'x-repo-commit' = ('c' * 40) }
    }
}
$tree = @(Get-HFTree -Info $fakeInfo -Token '')
Assert ($tree.Count -eq 3) 'Listing returns every entry'
Assert ($tree[0].sha256 -eq ('ab' * 32)) 'LFS SHA-256 is kept'
Assert ($tree[1].sha256 -eq ('cd' * 32)) 'An oid written as sha256:... is accepted too'
Assert ($tree[2].sha256 -eq '') 'A plain git blob carries no SHA-256'
Assert ($script:RepoCommit -eq ('c' * 40)) 'The listing pins the commit it came from'
# Enable-IPv4Only must refuse IPv6 candidates for every accepted HF hostname.
Enable-IPv4Only
$v4Delegate = [Net.ServicePointManager]::FindServicePoint([uri]'https://huggingface.co').BindIPEndPointDelegate
Assert ($null -ne $v4Delegate) 'IPv4-only bind delegate installed'
$v6Refused = $false
try { $v4Delegate.Invoke($null, (New-Object Net.IPEndPoint ([Net.IPAddress]::IPv6Loopback), 443), 0) } catch { $v6Refused = $true }
Assert $v6Refused 'IPv6 addresses are refused for metadata calls'
Assert ($null -eq $v4Delegate.Invoke($null, (New-Object Net.IPEndPoint ([Net.IPAddress]::Loopback), 443), 0)) 'IPv4 addresses are allowed through'
$settings = Get-DownloaderSettings
$settings.outputDir = Join-Path ([IO.Path]::GetTempPath()) 'model-downloads'
Save-DownloaderSettings $settings
Set-PickerDefault 'Q8_0'
Assert ((Get-DownloaderSettings).outputDir -eq $settings.outputDir) 'Saving quant preserves output preference'
Assert ((Get-DownloadFolder -Requested $PSScriptRoot) -eq $PSScriptRoot) 'Explicit folder wins'
$previousOutput = $env:HF_DOWNLOADER_OUTPUT
try {
    $env:HF_DOWNLOADER_OUTPUT = $PSScriptRoot
    Assert ((Get-DownloadFolder '') -eq $PSScriptRoot) 'Environment folder override'
    $env:HF_DOWNLOADER_OUTPUT = ''
    Assert ((Get-DownloadFolder '') -eq $settings.outputDir) 'Saved folder'
} finally { $env:HF_DOWNLOADER_OUTPUT = $previousOutput }
Assert ($null -eq (ConvertFrom-HFLink 'https://example.com/owner/repo')) 'Reject other hosts'
Assert ($null -eq (ConvertFrom-HFLink '../repo')) 'Reject unsafe repo'
# A bare kind prefix is an index page, not a repository. PowerShell reads 1..0
# as @(1, 0), so an unguarded slice used to turn these into a repo named
# "datasets" and produce a confusing 404 instead of a clear rejection.
Assert ($null -eq (ConvertFrom-HFLink 'https://huggingface.co/datasets')) 'Reject bare datasets index'
Assert ($null -eq (ConvertFrom-HFLink 'https://huggingface.co/spaces')) 'Reject bare spaces index'
Assert ((ConvertFrom-HFLink 'https://huggingface.co/datasets/owner/repo').Kind -eq 'datasets') 'Dataset repo still parses'
Assert ((ConvertFrom-HFLink 'https://huggingface.co/datasets/owner/repo').Repo -eq 'owner/repo') 'Dataset repo id'
Assert ((ConvertFrom-HFLink 'https://huggingface.co/spaces/owner/repo').Kind -eq 'spaces') 'Space repo still parses'
Assert ((ConvertFrom-HFLink 'https://huggingface.co/owner/repo/blob/main/model%20name.gguf').Path -eq 'model name.gguf') 'Encoded filename'
# The revision segment used to be left percent-encoded and then escaped again on
# the way out, so a branch link copied from the web UI asked the API for
# "feature%252Ffoo" and got a 404.
Assert ((ConvertFrom-HFLink 'https://huggingface.co/owner/repo/tree/feature%2Ffoo').Rev -eq 'feature/foo') 'Encoded branch name is decoded'
Assert ((ConvertFrom-HFLink 'https://huggingface.co/owner/repo/tree/refs%2Fpr%2F3').Rev -eq 'refs/pr/3') 'Encoded pull-request ref'
Assert ((ConvertFrom-HFLink 'https://huggingface.co/owner/repo/tree/refs/pr/3').Rev -eq 'refs/pr/3') 'Unencoded pull-request ref still parses'
# A link that ends right after the revision leaves a one-element slice, which
# PowerShell hands back as a bare string; indexing it returned 'm' for 'main'.
Assert ((ConvertFrom-HFLink 'https://huggingface.co/owner/repo/tree/main').Rev -eq 'main') 'A link ending at the revision keeps the whole revision'
Assert ((ConvertFrom-HFLink 'https://huggingface.co/owner/repo/tree/main').Path -eq '') 'No path after a bare revision'
Assert ((ConvertFrom-HFLink 'https://huggingface.co/owner/repo/blob/main/m.gguf').Path -eq 'm.gguf') 'Single-segment file path'
# Decoded exactly once: a literal percent in a filename must survive as one.
Assert ((ConvertFrom-HFLink 'https://huggingface.co/owner/repo/blob/main/model%2520name.gguf').Path -eq 'model%20name.gguf') 'Paths are decoded once, not twice'
foreach ($badPath in @('../escape.gguf', '/absolute.gguf', 'C:/escape.gguf', 'dir\escape.gguf', 'dir/CON.gguf', 'dir/file:stream',
                       'dir/CONIN$.gguf', 'CONOUT$', 'dir/PRN', 'dir/AUX.txt', 'dir/NUL',
                       ('COM' + [char]0x00B9 + '/x.gguf'), ('dir/LPT' + [char]0x00B2 + '.bin'),
                       'dir/trailing.', 'dir/trailing ', ('a' * 256))) {
    $rejected = $false
    try { Assert-SafeRelativePath $badPath } catch { $rejected = $true }
    Assert $rejected "Reject $badPath"
}
# Names that merely start with a reserved word are ordinary files.
foreach ($goodPath in @('CONSOLE/readme.md', 'dir/COM10.bin', 'dir/nullable.json', (('a' * 250) + '.gguf'))) {
    Assert-SafeRelativePath $goodPath
    $script:checks++
}
$tempModel = $script:AppSettingsPath + '.gguf'
try {
    [IO.File]::WriteAllBytes($tempModel, [byte[]]@(1,2,3))
    # SHA-256 of the bytes 01 02 03.
    $knownHash = (Get-FileHash -LiteralPath $tempModel -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert (Test-CompleteFile $tempModel 3) 'Complete file'
    Assert (Test-CompleteFile -Path $tempModel -Size 3 -Sha256 $knownHash) 'Existing file matching its digest is reused'
    # Same size, different bytes: the reason a digest is worth checking at all.
    Assert (-not (Test-CompleteFile -Path $tempModel -Size 3 -Sha256 ('ab' * 32))) 'Existing file with the wrong digest is refetched'
    Assert (-not (Test-CompleteFile -Path $tempModel -Size 4)) 'Existing file of the wrong size is refetched'
    Assert (Test-FinishedPartial -Path $tempModel -Size 3 -Sha256 $knownHash) 'A verified partial may be promoted'
    Assert (-not (Test-FinishedPartial -Path $tempModel -Size 3 -Sha256 ('ab' * 32))) 'A partial that fails its digest is not promoted'
    [IO.File]::WriteAllText(($tempModel + '.aria2'), 'partial')
    Assert (-not (Test-CompleteFile $tempModel 3)) 'Partial download not skipped'
    Assert (-not (Test-FinishedPartial -Path $tempModel -Size 3 -Sha256 '')) 'A leftover control file blocks promotion'
} finally {
    Remove-Item -LiteralPath $tempModel, ($tempModel + '.aria2'), $script:AppSettingsPath -ErrorAction SilentlyContinue
}
# --- batched small-file reporting -------------------------------------------
# The batch path used to call a file "downloaded" whenever it existed on disk,
# so an aria2 run that aborted part-way reported truncated files as complete.
# Re-import the real transfer function (the integration block above mocks it)
# and drive it with a stub aria2 that fails in controlled ways.
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $statement.Name -eq 'Invoke-Aria2Download') { . ([scriptblock]::Create($statement.Extent.Text)) }
}
$stubRoot = Join-Path ([IO.Path]::GetTempPath()) ('hf-stub-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stubRoot -Force | Out-Null
$stubAria = Join-Path $stubRoot 'stub-aria2.ps1'
# The stub stands in for aria2c. It is a .ps1 rather than an executable, so the
# manifest arrives on the PowerShell pipeline ($input) where a real aria2c would
# read it from stdin. Either way the property under test is the same: the
# manifest is piped in, never written to disk and never put on the command line.
Set-Content -LiteralPath $stubAria -Encoding UTF8 -Value @'
# No param() block on purpose. A [Parameter()] attribute would make this an
# advanced function, and those reject pipeline input they cannot bind; a real
# aria2c.exe is a native process and simply reads stdin.
$Rest = @($args)
$piped = @($input)
$dir = ''
for ($i = 0; $i -lt $Rest.Count; $i++) { if ($Rest[$i] -eq '--dir') { $dir = $Rest[$i + 1] } }
$manifest = ''
if ($Rest -contains '--input-file=-') { $manifest = ($piped -join "`n") }
if ($env:HFD_STUB_LOG) {
    Set-Content -LiteralPath $env:HFD_STUB_LOG -Value (($Rest -join ' ') + "`n--- manifest ---`n" + $manifest)
}
$bytes = if ($env:HFD_STUB_BYTES) { [int]$env:HFD_STUB_BYTES } else { 1 }
foreach ($line in ($manifest -split "`r?`n")) {
    if ($line -match '^\s+out=(.+?)\s*$') {
        $target = Join-Path $dir ($Matches[1] -replace '/', '\')
        New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
        # Short by default: a truncated file, exactly what an aborted run leaves.
        Set-Content -LiteralPath $target -Value ('x' * $bytes) -NoNewline
        if ($env:HFD_STUB_PARTIAL -eq '1') { Set-Content -LiteralPath ($target + '.aria2') -Value 'p' -NoNewline }
    }
}
exit ([int]$env:HFD_STUB_CODE)
'@
function Get-TranscriptOf {
    param([scriptblock]$Body)
    $file = Join-Path $stubRoot ('out-' + [guid]::NewGuid().ToString('N') + '.txt')
    Start-Transcript -LiteralPath $file | Out-Null
    try { & $Body } finally { Stop-Transcript | Out-Null }
    return (Get-Content -LiteralPath $file -Raw)
}
$smallItems = @(
    [pscustomobject]@{ Url = 'https://huggingface.co/a/b/resolve/main/one.json'; Out = 'one.json'; Size = 4096 },
    [pscustomobject]@{ Url = 'https://huggingface.co/a/b/resolve/main/two.json'; Out = 'two.json'; Size = 8192 }
)
$env:HFD_STUB_CODE = '1'; $env:HFD_STUB_PARTIAL = '1'
$destA = Join-Path $stubRoot 'a'
$textA = Get-TranscriptOf { Invoke-Aria2Download -Aria2 $stubAria -Items $smallItems -DestDir $destA -Token '' }
Assert ($textA -match 'Finished with problems') 'Aborted batch is reported as a failure'
Assert ($textA -notmatch 'All done') 'Truncated batch files are never called done'
Assert ($textA -match '2 of 2 small files failed') 'Failed batch count is accurate'

# A batch that really succeeds must still read as clean, and the count must come
# from this batch alone rather than from failures recorded earlier in the run.
$env:HFD_STUB_CODE = '0'; $env:HFD_STUB_PARTIAL = '0'
$exactItems = @(
    [pscustomobject]@{ Url = 'https://huggingface.co/a/b/resolve/main/tiny.txt';  Out = 'tiny.txt';  Size = 1; Sha256 = '' },
    [pscustomobject]@{ Url = 'https://huggingface.co/a/b/resolve/main/tiny2.txt'; Out = 'tiny2.txt'; Size = 1; Sha256 = '' }
)
$destB = Join-Path $stubRoot 'b'
$env:HFD_STUB_LOG = Join-Path $stubRoot 'stub-call.txt'
$textB = Get-TranscriptOf { Invoke-Aria2Download -Aria2 $stubAria -Items $exactItems -DestDir $destB -Token 'secret-token' }
Assert ($textB -match 'All done') 'Complete download reports success'
# Verified bytes are promoted to the real name and nothing is left half-written.
Assert (Test-Path -LiteralPath (Join-Path $destB 'tiny.txt')) 'Verified file is promoted to its real name'
Assert (-not (Test-Path -LiteralPath (Join-Path $destB 'tiny.txt.part'))) 'No .part file is left behind on success'
Assert (-not (Test-Path -LiteralPath (Join-Path $destB '.hugging-face-downloader.lock'))) 'The destination lock is released'
$stubCall = Get-Content -LiteralPath $env:HFD_STUB_LOG -Raw
$stubArgs = ($stubCall -split '--- manifest ---')[0]
Assert ($stubArgs -notmatch 'secret-token') 'The token never appears on the aria2 command line'
Assert ($stubArgs -match '--input-file=-') 'The manifest is read from stdin'
Assert (($stubCall -split '--- manifest ---')[1] -match 'Bearer secret-token') 'The token reaches aria2 through the manifest'
Assert (@(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter 'hf-aria2-*.txt' -ErrorAction SilentlyContinue).Count -eq 0) 'No manifest is written to the temp folder'
Remove-Item Env:HFD_STUB_LOG -ErrorAction SilentlyContinue

# A queue naming the same file twice is one download, not a phantom failure.
$destDup = Join-Path $stubRoot 'dup'
$textDup = Get-TranscriptOf { Invoke-Aria2Download -Aria2 $stubAria -Items ($exactItems[0], $exactItems[0]) -DestDir $destDup -Token '' }
Assert ($textDup -match 'All done') 'A duplicated queue entry is collapsed, not failed'

# aria2 reporting success does not make the bytes right. A file whose SHA-256
# does not match must stay at .part and be reported as a failure.
$destHash = Join-Path $stubRoot 'hash'
$hashItems = @([pscustomobject]@{ Url = 'https://huggingface.co/a/b/resolve/main/w.bin'; Out = 'w.bin'; Size = 1; Sha256 = ('ab' * 32) })
$textHash = Get-TranscriptOf { Invoke-Aria2Download -Aria2 $stubAria -Items $hashItems -DestDir $destHash -Token '' }
Assert ($textHash -match 'Finished with problems') 'A digest mismatch fails the download'
Assert (-not (Test-Path -LiteralPath (Join-Path $destHash 'w.bin'))) 'Unverified bytes never reach the real filename'
Assert (Test-Path -LiteralPath (Join-Path $destHash 'w.bin.part')) 'The unverified partial is kept for inspection'

# --- destination lock and disk preflight -------------------------------------
$lockDir = Join-Path $stubRoot 'lock'
New-Item -ItemType Directory -Force -Path $lockDir | Out-Null
$held = Lock-Destination -DestDir $lockDir
$secondRun = $false
try { Lock-Destination -DestDir $lockDir } catch { $secondRun = $true }
Assert $secondRun 'A second run cannot lock a folder that is already being written'
Unlock-Destination $held
$reacquired = Lock-Destination -DestDir $lockDir
Assert ($null -ne $reacquired) 'The lock can be taken again once released'
Unlock-Destination $reacquired
Assert (-not (Test-Path -LiteralPath (Join-Path $lockDir '.hugging-face-downloader.lock'))) 'Releasing the lock removes its file'

$noRoom = $false
try { Assert-FreeSpace -DestDir $stubRoot -Needed ([int64]900PB) } catch { $noRoom = $true }
Assert $noRoom 'A download larger than the volume is refused before it starts'
Assert-FreeSpace -DestDir $stubRoot -Needed 1024
$script:checks++
$env:HFD_STUB_CODE = '3'; $env:HFD_STUB_PARTIAL = '0'
$mixed = @([pscustomobject]@{ Url = 'https://huggingface.co/a/b/resolve/main/big.gguf'; Out = 'big.gguf'; Size = 200MB }) + $smallItems
$destC = Join-Path $stubRoot 'c'
$textC = Get-TranscriptOf { Invoke-Aria2Download -Aria2 $stubAria -Items $mixed -DestDir $destC -Token '' }
Assert ($textC -match 'FAILED') 'Solo failure reported'
Remove-Item -Recurse -Force $stubRoot -ErrorAction SilentlyContinue
Remove-Item Env:HFD_STUB_CODE, Env:HFD_STUB_PARTIAL -ErrorAction SilentlyContinue

Write-Host "PASS: $script:checks checks; no downloads started."

# The suite deliberately runs a stub aria2c that exits non-zero, so $LASTEXITCODE
# is left at 3 even on a clean pass. GitHub Actions takes a pwsh step's exit code
# from $LASTEXITCODE, so without this the Tests workflow failed on green.
# Assert throws on failure, so reaching this line means every check passed.
exit 0




