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
$script:TransferDisableIPv6 = $false
$transferArgs = @(Get-Aria2Args '')
Assert ($transferArgs[1] -eq '4' -and $transferArgs[3] -eq '4') 'Configurable connections'
Assert ('--disable-ipv6=true' -notin $transferArgs) 'IPv6 available by default'
$script:TransferDisableIPv6 = $true
Assert ('--disable-ipv6=true' -in @(Get-Aria2Args '')) 'Optional IPv4 only mode'
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
Assert ((ConvertFrom-HFLink 'https://huggingface.co/owner/repo/blob/main/model%20name.gguf').Path -eq 'model name.gguf') 'Encoded filename'
foreach ($badPath in @('../escape.gguf', '/absolute.gguf', 'C:/escape.gguf', 'dir\escape.gguf', 'dir/CON.gguf', 'dir/file:stream')) {
    $rejected = $false
    try { Assert-SafeRelativePath $badPath } catch { $rejected = $true }
    Assert $rejected "Reject $badPath"
}
$tempModel = $script:AppSettingsPath + '.gguf'
try {
    [IO.File]::WriteAllBytes($tempModel, [byte[]]@(1,2,3))
    Assert (Test-CompleteFile $tempModel 3) 'Complete file'
    [IO.File]::WriteAllText(($tempModel + '.aria2'), 'partial')
    Assert (-not (Test-CompleteFile $tempModel 3)) 'Partial download not skipped'
} finally {
    Remove-Item -LiteralPath $tempModel, ($tempModel + '.aria2'), $script:AppSettingsPath -ErrorAction SilentlyContinue
}
Write-Host "PASS: $script:checks checks; no downloads started."




