# Explicit exception for a real Store screenshot; never used by build/test/release.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:CLIPDROP_ALLOW_CI_SCREENSHOT -ne 'true') {
    throw 'App launch is allowed only in the explicitly authorized Windows screenshot workflow.'
}

$root = Split-Path $PSScriptRoot -Parent
$packageDirectory = Join-Path $root '.build/screenshot-package'
$output = Join-Path $root 'dist/store-listing'
$unpacked = Join-Path $env:RUNNER_TEMP 'clipdrop-screenshot-app'
$expectedHash = '252c28872cc1990b4c13aae8595eb7a8c924eb24dbe08d1b6b419a8592def442'
$report = Get-Content (Join-Path $packageDirectory 'store-report.json') -Raw | ConvertFrom-Json
if ($report.sourceCommit -ne '3a755fadeef38dbf7d2e62c5b8884be40e81d592' -or $report.identity.test -ne $false) {
    throw 'Unexpected source package.'
}
$package = Join-Path $packageDirectory 'ClipDrop-Store-x64-1.3.1.0.msix'
if ((Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'The MSIX does not match the approved artifact.'
}
New-Item -ItemType Directory -Force $output | Out-Null
if (Test-Path $unpacked) { throw 'Screenshot extraction directory already exists.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem, System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
[IO.Compression.ZipFile]::ExtractToDirectory($package, $unpacked)
$executable = Join-Path $unpacked 'ClipDrop.exe'
if ((Get-FileHash $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $report.payload.'ClipDrop.exe') {
    throw 'Unexpected app executable.'
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ScreenshotDesktop {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Mode {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public ushort SpecVersion, DriverVersion, Size, DriverExtra;
        public uint Fields;
        public int PositionX, PositionY;
        public uint Orientation, FixedOutput;
        public short Color, Duplex, YResolution, TTOption, Collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FormName;
        public ushort LogPixels;
        public uint BitsPerPel, PelsWidth, PelsHeight, DisplayFlags, DisplayFrequency;
        public uint ICMMethod, ICMIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool EnumDisplaySettings(string device, int mode, ref Mode settings);
    public static bool CurrentMode(ref Mode settings) { return EnumDisplaySettings(null, -1, ref settings); }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int ChangeDisplaySettings(ref Mode settings, uint flags);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect rect, int size);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string name, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SystemParametersInfo(uint action, uint param, string value, uint flags);
    [DllImport("user32.dll")] public static extern bool SetSysColors(int count, int[] elements, int[] colors);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
'@
[ScreenshotDesktop]::SetProcessDPIAware() | Out-Null
$originalMode = New-Object ScreenshotDesktop+Mode
$originalMode.Size = [Runtime.InteropServices.Marshal]::SizeOf($originalMode)
Write-Host "Capture process session: $((Get-Process -Id $PID).SessionId); interactive: $([Environment]::UserInteractive); display mode structure: $($originalMode.Size) bytes"
if (-not [ScreenshotDesktop]::CurrentMode([ref]$originalMode)) {
    throw "Cannot query display; Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()); bounds $([Windows.Forms.Screen]::PrimaryScreen.Bounds)"
}
$mode = $originalMode
$mode.PelsWidth = 1920
$mode.PelsHeight = 1080
$mode.Fields = 0x180000
$resolutionResult = [ScreenshotDesktop]::ChangeDisplaySettings([ref]$mode, 0)
if ($resolutionResult -ne 0) {
    $mode.PelsWidth = 1366
    $mode.PelsHeight = 768
    $resolutionResult = [ScreenshotDesktop]::ChangeDisplaySettings([ref]$mode, 0)
}
# This is the runner desktop, not an image background added after capture.
[ScreenshotDesktop]::SystemParametersInfo(20, 0, '', 3) | Out-Null
[ScreenshotDesktop]::SetSysColors(1, @(1), @(0x00352C26)) | Out-Null
$taskbar = [ScreenshotDesktop]::FindWindow('Shell_TrayWnd', $null)
[ScreenshotDesktop]::ShowWindow($taskbar, 0) | Out-Null
$app = $null
$closed = $false
$originalBrowserArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
try {
    $screen = [Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($screen.Width -lt 1366 -or $screen.Height -lt 768) {
        throw "Desktop too small: $($screen.Width)x$($screen.Height); display change result $resolutionResult"
    }
    # Minimize the runner's terminal before opening the app. The central crop of
    # the larger desktop also excludes desktop shortcuts and the OS watermark.
    $shell = New-Object -ComObject Shell.Application
    $shell.MinimizeAll()
    Start-Sleep -Seconds 1
    # The debugging endpoint exists only in this disposable runner. It applies
    # display zoom to the live page, without editing source or packaged files.
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
    $app = Start-Process -FilePath $executable -WorkingDirectory $unpacked -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 500
        $app.Refresh()
        if ($app.HasExited) { throw "ClipDrop exited before capture: $($app.ExitCode)" }
    } while ($app.MainWindowHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
    $hwnd = $app.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { throw 'ClipDrop did not create a window.' }
    $rect = New-Object ScreenshotDesktop+Rect
    if (-not [ScreenshotDesktop]::GetWindowRect($hwnd, [ref]$rect)) { throw 'Cannot measure ClipDrop window.' }
    $frame = New-Object ScreenshotDesktop+Rect
    if ([ScreenshotDesktop]::DwmGetWindowAttribute($hwnd, 9, [ref]$frame, 16) -ne 0) { throw 'Cannot measure visible window frame.' }
    $invisibleWidth = ($rect.Right - $rect.Left) - ($frame.Right - $frame.Left)
    $invisibleHeight = ($rect.Bottom - $rect.Top) - ($frame.Bottom - $frame.Top)
    $x = $screen.X + [int](($screen.Width - 1366 - $invisibleWidth) / 2)
    $y = $screen.Y + [int](($screen.Height - 768 - $invisibleHeight) / 2)
    [ScreenshotDesktop]::ShowWindow($hwnd, 9) | Out-Null
    [ScreenshotDesktop]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, (1366 + $invisibleWidth), (768 + $invisibleHeight), 0x0040) | Out-Null
    [ScreenshotDesktop]::SetForegroundWindow($hwnd) | Out-Null

    $page = $null
    do {
        Start-Sleep -Milliseconds 300
        try {
            $pages = Invoke-RestMethod 'http://127.0.0.1:9222/json/list'
            $page = $pages | Where-Object { $_.type -eq 'page' -and $_.url -match '^https?://tauri\.localhost/?' } | Select-Object -First 1
        } catch { }
    } while ($null -eq $page -and [DateTime]::UtcNow -lt $deadline)
    if ($null -eq $page) { throw 'The runner-only WebView zoom endpoint is unavailable.' }
    $socket = New-Object Net.WebSockets.ClientWebSocket
    try {
        $token = [Threading.CancellationToken]::None
        $socket.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $token).GetAwaiter().GetResult()
        $command = @{ id = 1; method = 'Runtime.evaluate'; params = @{
            expression = "document.documentElement.style.zoom = '2.4'; ({ zoom: getComputedStyle(document.documentElement).zoom, width: innerWidth })"
            returnByValue = $true
        }} | ConvertTo-Json -Depth 5 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($command)
        $socket.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $token).GetAwaiter().GetResult()
        do {
            $buffer = New-Object byte[] 65536
            $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $token).GetAwaiter().GetResult()
            if (-not $received.EndOfMessage) { throw 'Unexpected zoom response size.' }
            $response = [Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count) | ConvertFrom-Json
        } while ($response.id -ne 1)
        if ($response.error -or $response.result.exceptionDetails -or $response.result.result.value.zoom -ne '2.4') { throw 'Live display zoom failed.' }
    } finally { $socket.Dispose() }

    # UI Automation verifies the real WebView rendered before capturing pixels.
    $names = @()
    do {
        Start-Sleep -Milliseconds 500
        $element = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $elements = $element.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        $names = @($elements | ForEach-Object { $_.Current.Name })
    } while (($names -notcontains 'Enlace del video' -or $names -notcontains 'Pegar') -and [DateTime]::UtcNow -lt $deadline)
    if ($names -notcontains 'Enlace del video' -or $names -notcontains 'Pegar' -or $names -notcontains 'Descargar') {
        throw "The app UI is not ready: $($names -join ' | ')"
    }
    if ($names -match 'Falta yt-dlp|No se pudo|Reinstal') { throw 'The app shows a startup error.' }
    [ScreenshotDesktop]::SetCursorPos($screen.Right - 1, $screen.Bottom - 1) | Out-Null
    Start-Sleep -Seconds 2
    if ([ScreenshotDesktop]::DwmGetWindowAttribute($hwnd, 9, [ref]$frame, 16) -ne 0) { throw 'Cannot measure capture frame.' }
    if (($frame.Right - $frame.Left) -ne 1366 -or ($frame.Bottom - $frame.Top) -ne 768) { throw 'Unexpected window capture size.' }
    $bitmap = New-Object Drawing.Bitmap 1366, 768
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($frame.Left, $frame.Top, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $output 'ClipDrop-Windows-1366x768.png'), [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
} finally {
    if ($null -ne $app) {
        $app.Refresh()
        if (-not $app.HasExited) {
            $app.CloseMainWindow() | Out-Null
            if (-not $app.WaitForExit(5000)) { Stop-Process -Id $app.Id -Force }
        }
        $closed = -not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)
    }
    [ScreenshotDesktop]::ShowWindow($taskbar, 5) | Out-Null
    [ScreenshotDesktop]::ChangeDisplaySettings([ref]$originalMode, 0) | Out-Null
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $originalBrowserArguments
}
if (-not $closed) { throw 'ClipDrop did not close.' }
$evidence = [ordered]@{
    sourceRun = 41741531111
    sourceCommit = $report.sourceCommit
    msixSha256 = $expectedHash
    executableSha256 = $report.payload.'ClipDrop.exe'
    capture = 'Real Windows window only; live UI display zoom 240%, no bitmap scaling or desktop padding'
    webViewDisplayZoom = 2.4
    width = 1366
    height = 768
    launchedOnlyOnCi = $true
    installedWithPackageIdentity = $false
    appClosed = $closed
    downloadedVideos = $false
    browserSessionsRead = $false
    capturedAt = [DateTime]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText((Join-Path $output 'screenshot-report.json'), ($evidence | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
Write-Host 'Captured the real ClipDrop UI and closed the app. No video download or browser session access.'
