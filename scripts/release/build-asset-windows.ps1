# Build Windows release asset: ff-cli-windows-x64.zip and .sha256
# Run from repo root or scripts/release. Uses env: FF_CLI_OUTPUT_DIR, FF_CLI_NODE_VERSION, FF_CLI_VERSION.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-ZipArchiveWithProgress {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$RootFolderName
    )

    if (Test-Path $ArchivePath) {
        Remove-Item -Path $ArchivePath -Force
    }

    $sourceRoot = [System.IO.Path]::GetFullPath($SourceDirectory)
    if (-not $sourceRoot.EndsWith("\")) {
        $sourceRoot = "$sourceRoot\"
    }

    $files = Get-ChildItem -Path $SourceDirectory -Recurse -File
    $totalFiles = $files.Count
    $index = 0

    $fileStream = [System.IO.File]::Open($ArchivePath, [System.IO.FileMode]::CreateNew)
    try {
        $zipArchive = New-Object System.IO.Compression.ZipArchive(
            $fileStream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false
        )
        try {
            foreach ($file in $files) {
                $filePath = [System.IO.Path]::GetFullPath($file.FullName)
                if (-not $filePath.StartsWith($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw "Cannot compute relative path for $filePath"
                }
                $relativePath = $filePath.Substring($sourceRoot.Length)
                $entryName = [System.IO.Path]::Combine($RootFolderName, $relativePath) -replace "\\", "/"
                $entry = $zipArchive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Fastest)

                $entryStream = $entry.Open()
                $sourceStream = [System.IO.File]::OpenRead($file.FullName)
                try {
                    $sourceStream.CopyTo($entryStream)
                }
                finally {
                    $sourceStream.Dispose()
                    $entryStream.Dispose()
                }

                $index++
                if (($index % 250 -eq 0) -or ($index -eq $totalFiles)) {
                    Write-Host "Zipping files: $index/$totalFiles"
                }
            }
        }
        finally {
            $zipArchive.Dispose()
        }
    }
    finally {
        $fileStream.Dispose()
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ROOT_DIR = (Resolve-Path (Join-Path $ScriptDir "../..")).Path
$OUTPUT_DIR = if ($env:FF_CLI_OUTPUT_DIR) { $env:FF_CLI_OUTPUT_DIR } else { Join-Path $ROOT_DIR "release" }
$VERSION = if ($env:FF_CLI_VERSION) { $env:FF_CLI_VERSION } else {
    (Get-Content (Join-Path $ROOT_DIR "package.json") | ConvertFrom-Json).version
}

$OS = "windows"
$ARCH = "x64"
$ASSET_NAME = "ff-cli-$OS-$ARCH"
$ARCHIVE_NAME = "$ASSET_NAME.zip"

$WORKDIR = New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_.FullName }
try {
    Write-Host "Building ff-cli bundle..."
    Set-Location $ROOT_DIR
    npm ci
    npm run bundle

    $PACKAGE_DIR = Join-Path $WORKDIR $ASSET_NAME
    New-Item -ItemType Directory -Path (Join-Path $PACKAGE_DIR "bin") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $PACKAGE_DIR "lib") -Force | Out-Null

    Copy-Item (Join-Path $ROOT_DIR "dist\ff-cli.js") (Join-Path $PACKAGE_DIR "lib\ff-cli.js")
    Copy-Item (Join-Path $ROOT_DIR "package.json") (Join-Path $PACKAGE_DIR "package.json")
    Copy-Item (Join-Path $ROOT_DIR "LICENSE") (Join-Path $PACKAGE_DIR "LICENSE")
    New-Item -ItemType Directory -Path (Join-Path $PACKAGE_DIR "lib\node_modules") -Force | Out-Null
    Copy-Item -Recurse (Join-Path $ROOT_DIR "node_modules\@napi-rs") (Join-Path $PACKAGE_DIR "lib\node_modules\@napi-rs")

    $ffCliCmd = @"
@echo off
set "BASE_DIR=%~dp0.."
set "APP=%BASE_DIR%\lib\ff-cli.js"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Install Node.js, then run this command again.
  exit /b 1
)
node "%APP%" %*
"@
    [System.IO.File]::WriteAllText((Join-Path $PACKAGE_DIR "bin\ff-cli.cmd"), $ffCliCmd)

    $requirements = @"
Runtime requirement:
- Node.js 22 or newer must be installed and available in PATH.

Verify:
- node -v

Run:
- .\bin\ff-cli.cmd --help
"@
    [System.IO.File]::WriteAllText((Join-Path $PACKAGE_DIR "RUNTIME_REQUIREMENTS.txt"), $requirements)

    New-Item -ItemType Directory -Path $OUTPUT_DIR -Force | Out-Null
    $zipPath = Join-Path $OUTPUT_DIR $ARCHIVE_NAME
    Write-Host "Creating zip archive..."
    New-ZipArchiveWithProgress -SourceDirectory $PACKAGE_DIR -ArchivePath $zipPath -RootFolderName $ASSET_NAME

    $hash = Get-FileHash -Path $zipPath -Algorithm SHA256
    $hash.Hash.ToLower() + "  " + (Split-Path -Leaf $zipPath) | Out-File -FilePath "$zipPath.sha256" -Encoding ASCII

    Write-Host "Built $ARCHIVE_NAME (version $VERSION) in $OUTPUT_DIR"
}
finally {
    Remove-Item -Path $WORKDIR -Recurse -Force -ErrorAction SilentlyContinue
}
