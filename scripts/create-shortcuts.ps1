$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$launcher = Join-Path $projectRoot "release\AgentGlance-$($package.version).exe"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw 'Build the portable app with npm run dist before creating shortcuts.'
}
$launcher = (Resolve-Path -LiteralPath $launcher).Path
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $shortcutPath = Join-Path $folder 'AgentGlance.lnk'
    $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcher
    $shortcut.WorkingDirectory = Split-Path -Parent $launcher
    $shortcut.Arguments = ''
    $shortcut.Description = 'Show your AI status and task context widget'
    $shortcut.IconLocation = "$launcher,0"
    $shortcut.Save()
    $saved = $shortcutShell.CreateShortcut($shortcutPath)
    if ($saved.TargetPath -ne $launcher) { throw "Shortcut verification failed: $shortcutPath" }
    Write-Output $shortcutPath
}
