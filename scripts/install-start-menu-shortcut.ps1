# Friday - Start Menu Shortcut Installer
#
# Creates a "Friday" entry in the Windows Start Menu that launches the app
# silently via the hidden VBS wrapper (no console flash).
#
# Usage:
#   npm run install-shortcut
#   -- or --
#   powershell -ExecutionPolicy Bypass -File scripts\install-start-menu-shortcut.ps1
#
# Re-runnable: overwrites any existing Friday.lnk in the user's Start Menu.

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VbsPath     = Join-Path $ProjectRoot 'launch-hidden.vbs'
$IconPath    = Join-Path $ProjectRoot 'public\icon.ico'
$StartMenu   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$LnkPath     = Join-Path $StartMenu 'Friday.lnk'
$Wscript     = Join-Path $env:WINDIR 'System32\wscript.exe'

if (-not (Test-Path $VbsPath)) {
    Write-Error "Launcher not found: $VbsPath"
    exit 1
}

if (-not (Test-Path $StartMenu)) {
    New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null
}

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($LnkPath)
$lnk.TargetPath       = $Wscript
$lnk.Arguments        = "`"$VbsPath`""
$lnk.WorkingDirectory = $ProjectRoot
$lnk.Description      = 'Friday - Personal AI Assistant'
$lnk.WindowStyle      = 7  # Minimized; the Electron window is the real UI
if (Test-Path $IconPath) {
    $lnk.IconLocation = $IconPath
} else {
    Write-Host "(note) public\icon.ico not found - shortcut will use the default wscript icon" -ForegroundColor Yellow
}
$lnk.Save()

Write-Host ""
Write-Host "Created Start Menu shortcut:" -ForegroundColor Green
Write-Host "  $LnkPath"
Write-Host ""
Write-Host "Launch Friday: press Start, type 'Friday', press Enter."
