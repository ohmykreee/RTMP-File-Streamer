param(
  [string]$OutFile = "D:\Tools\StreamingTools\docs\screenshot-idle.png",
  [string]$ProcessName = "RTMPFileStreamer",
  [string]$ExpectTitleLike = "串流器"
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Capture {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Get-WindowTitle([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][Win32Capture]::GetWindowTextW($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

# Pick the window owned by the requested process and whose title matches, so an
# unrelated foreground window can never end up in the screenshot.
$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } |
  Select-Object -First 1
if (-not $proc) { Write-Error "no '$ProcessName' process owns a titled window"; exit 1 }

$h = $proc.MainWindowHandle
if ($ExpectTitleLike -and (Get-WindowTitle $h) -notlike "*$ExpectTitleLike*") {
  Write-Error "window title '$((Get-WindowTitle $h))' does not contain '$ExpectTitleLike'"
  exit 1
}

# Bring it to the front, then confirm it really is the foreground window before
# copying screen pixels.
for ($i = 0; $i -lt 10; $i++) {
  [void][Win32Capture]::ShowWindow($h, 9)   # SW_RESTORE
  [void][Win32Capture]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 350
  if ([Win32Capture]::GetForegroundWindow() -eq $h) { break }
}

$fg = [Win32Capture]::GetForegroundWindow()
if ($fg -ne $h) {
  Write-Error "could not bring '$((Get-WindowTitle $h))' to the foreground (foreground is '$((Get-WindowTitle $fg))')"
  exit 1
}
Start-Sleep -Milliseconds 700

$rect = New-Object Win32Capture+RECT
[void][Win32Capture]::GetWindowRect($h, [ref]$rect)
$w = $rect.Right - $rect.Left
$hgt = $rect.Bottom - $rect.Top
if ($w -le 0 -or $hgt -le 0) { Write-Error "window has no size"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $hgt)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Output "saved $OutFile  ($w x $hgt)  window='$(Get-WindowTitle $h)'"
