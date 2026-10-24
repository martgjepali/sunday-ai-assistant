# Creates "SUNDAY" shortcuts on the Desktop and in the Start menu that launch
# the production build (run `npm run build` after code changes).
# Usage: npm run shortcuts

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root "node_modules\electron\dist\electron.exe"
# A new file name forces Windows to load the icon fresh instead of a cached copy.
$icon = Join-Path $root "electron\sunday.ico"

if (-not (Test-Path $electron)) { throw "Electron isn't installed. Run 'npm install' first." }
if (-not (Test-Path (Join-Path $root ".next\BUILD_ID"))) { Write-Warning "No production build yet - run 'npm run build' before launching SUNDAY." }

$targets = @(
  [Environment]::GetFolderPath("Desktop"),
  [Environment]::GetFolderPath("Programs")   # Start menu
)

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $targets) {
  $path = Join-Path $dir "SUNDAY.lnk"
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $electron
  $lnk.Arguments = "`"$root`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = "SUNDAY - your personal AI"
  $lnk.Save()
  Write-Output "Created $path"
}
