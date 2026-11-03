$ErrorActionPreference = 'Stop'
$dist = Join-Path $PSScriptRoot '..\dist'
$version = (Get-Content (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version
$reportPath = Join-Path $dist 'defender-report.json'
$targets = @(
    [ordered]@{ path = (Resolve-Path (Join-Path $dist 'win-unpacked')).Path; kind = 'unpacked-application'; status = 'skipped'; reason = 'Scan not started.' },
    [ordered]@{ path = (Resolve-Path (Join-Path $dist "ClipDrop-Setup-x64-$version.exe")).Path; kind = 'nsis-installer'; status = 'skipped'; reason = 'Scan not started.' }
)
$report = [ordered]@{ status = 'skipped'; reason = ''; scannedAt = [DateTime]::UtcNow.ToString('o'); signatures = $null; targets = $targets }
try {
    $status = Get-MpComputerStatus
    if (-not $status.AntivirusEnabled) {
        $report.reason = 'Defender antivirus is not enabled on this runner.'
    } else {
        $report.signatures = [string]$status.AntivirusSignatureVersion
        foreach ($target in $targets) {
            try {
                Start-MpScan -ScanType CustomScan -ScanPath $target.path
                $detections = @(Get-MpThreatDetection | Where-Object {
                    @($_.Resources | Where-Object { $_.IndexOf($target.path, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0
                })
                if ($detections.Count -gt 0) {
                    $target.status = 'detected'
                    $target.reason = 'Defender reported a threat for this path.'
                } else {
                    $target.status = 'completed'
                    $target.reason = 'Custom scan completed; no threat reported for this path.'
                }
            } catch {
                $target.reason = 'Defender scan was unavailable or could not complete for this path.'
            }
        }
        if (@($targets | Where-Object { $_.status -eq 'detected' }).Count -gt 0) {
            $report.status = 'detected'
            $report.reason = 'Defender reported a threat; do not release.'
        } elseif (@($targets | Where-Object { $_.status -ne 'completed' }).Count -eq 0) {
            $report.status = 'completed'
            $report.reason = 'Both the unpacked application and NSIS installer were scanned without a reported threat.'
        } else {
            $report.reason = 'At least one target could not be scanned; consult targets for coverage.'
        }
    }
} catch {
    $report.reason = 'Defender scan was unavailable or could not complete on this runner.'
}
$report | ConvertTo-Json -Depth 5 | Set-Content -Path $reportPath -Encoding utf8
Get-Content $reportPath
if ($report.status -eq 'detected') { throw 'Defender detected a threat; do not release this package.' }
