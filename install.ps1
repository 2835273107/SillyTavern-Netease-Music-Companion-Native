param(
    [Parameter(Mandatory = $true)]
    [string]$SillyTavernPath
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$root = (Resolve-Path -LiteralPath $SillyTavernPath).Path

foreach ($required in @('config.yaml', 'public\scripts\extensions\third-party', 'plugins')) {
    $candidate = Join-Path $root $required
    if (-not (Test-Path -LiteralPath $candidate)) {
        throw "SillyTavern path is invalid or incomplete. Missing: $candidate"
    }
}

$frontendTarget = Join-Path $root 'public\scripts\extensions\third-party\netease-music-companion-native'
$backendTarget = Join-Path $root 'plugins\netease-music-companion-native'
New-Item -ItemType Directory -Path $frontendTarget -Force | Out-Null
New-Item -ItemType Directory -Path $backendTarget -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $source 'manifest.json') -Destination (Join-Path $frontendTarget 'manifest.json') -Force
Copy-Item -LiteralPath (Join-Path $source 'index.js') -Destination (Join-Path $frontendTarget 'index.js') -Force

foreach ($file in @('index.js', 'together-bridge.js', 'package.json', 'config.example.json')) {
    Copy-Item -LiteralPath (Join-Path $source "plugin\$file") -Destination (Join-Path $backendTarget $file) -Force
}
$nativeTarget = Join-Path $backendTarget 'together-native'
New-Item -ItemType Directory -Path $nativeTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'plugin\together-native\service.py') -Destination (Join-Path $nativeTarget 'service.py') -Force
Copy-Item -LiteralPath (Join-Path $source 'plugin\.gitignore') -Destination (Join-Path $backendTarget '.gitignore') -Force
Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination (Join-Path $backendTarget 'README.md') -Force

$apiRuntimeTarget = Join-Path $backendTarget 'netease-api-runtime'
New-Item -ItemType Directory -Path $apiRuntimeTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'plugin\netease-api-runtime\package.json') -Destination (Join-Path $apiRuntimeTarget 'package.json') -Force

$apiEntry = Join-Path $apiRuntimeTarget 'node_modules\NeteaseCloudMusicApi\app.js'
if (-not (Test-Path -LiteralPath $apiEntry)) {
    $npmCommand = Get-Command npm.cmd -ErrorAction Stop
    Push-Location $apiRuntimeTarget
    try {
        & $npmCommand.Source install --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw 'Failed to install the managed NeteaseCloudMusicApi runtime.'
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host 'Managed NeteaseCloudMusicApi runtime already installed.'
}

$configTarget = Join-Path $backendTarget 'config.json'
if (-not (Test-Path -LiteralPath $configTarget)) {
    Copy-Item -LiteralPath (Join-Path $source 'plugin\config.example.json') -Destination $configTarget
    Write-Host 'Created config.json from config.example.json. Replace char_alt with your own account or edit the label in the extension.'
} else {
    Write-Host 'Existing config.json was preserved.'
}

Write-Host ''
Write-Host 'Netease Music Companion Native installed.'
Write-Host "Frontend: $frontendTarget"
Write-Host "Backend:  $backendTarget"
Write-Host 'Ensure enableServerPlugins: true in config.yaml, then restart SillyTavern.'
