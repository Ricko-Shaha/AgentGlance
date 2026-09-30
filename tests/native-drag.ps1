param([int]$TargetPid, [int]$FromScreenX, [int]$FromScreenY, [int]$ToScreenX, [int]$ToScreenY)
$ErrorActionPreference = 'Stop'
$target = Get-Process -Id $TargetPid
if ($target.MainWindowTitle -notlike 'AgentGlance*') { throw 'Only the AgentGlance test window may be dragged.' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AgentGlanceDragTest {
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[void][AgentGlanceDragTest]::SetThreadDpiAwarenessContext([IntPtr](-4))
$rect = New-Object AgentGlanceDragTest+Rect
[void][AgentGlanceDragTest]::GetWindowRect($target.MainWindowHandle, [ref]$rect)
[void][AgentGlanceDragTest]::SetForegroundWindow($target.MainWindowHandle)
$startX = $FromScreenX
$startY = $FromScreenY
[void][AgentGlanceDragTest]::SetCursorPos($startX, $startY)
try {
    [AgentGlanceDragTest]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    # Keep screen coordinates fixed even while the target window moves.
    for ($step = 1; $step -le 20; $step++) {
        [void][AgentGlanceDragTest]::SetCursorPos($startX + [int](($ToScreenX - $startX) * $step / 20), $startY + [int](($ToScreenY - $startY) * $step / 20))
        Start-Sleep -Milliseconds 15
    }
} finally {
    [AgentGlanceDragTest]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    # Moving the pointer after release must not move the dropped widget.
    [void][AgentGlanceDragTest]::SetCursorPos($ToScreenX + 240, $ToScreenY + 120)
}
