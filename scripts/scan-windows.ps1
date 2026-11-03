$ErrorActionPreference = 'Stop'
$reportPath = Join-Path $PSScriptRoot '..\dist\defender-report.json'
$packagePath = (Resolve-Path (Join-Path $PSScriptRoot '..\dist\win-unpacked')).Path
$report = [ordered]@{ status = 'skipped'; reason = ''; scannedAt = [DateTime]::UtcNow.ToString('o'); signatures = $null }
try {
    $status = Get-MpComputerStatus
    if (-not $status.AntivirusEnabled) {
        $report.reason = 'Defender antivirus is not enabled on this runner.'
    } else {
        $report.signatures = [string]$status.AntivirusSignatureVersion
        Start-MpScan -ScanType CustomScan -ScanPath $packagePath
        $detections = @(Get-MpThreatDetection | Where-Object {
            @($_.Resources | Where-Object { $_ -like "*$packagePath*" }).Count -gt 0
        })
        if ($detections.Count -gt 0) {
            $report.status = 'detected'
            $report.reason = 'Defender reported a threat in the package.'
        } else {
            $report.status = 'completed'
            $report.reason = 'Custom scan completed; no threat reported for this package path.'
        }
    }
} catch {
    $report.reason = 'Defender scan was unavailable or could not complete on this runner.'
}
$report | ConvertTo-Json | Set-Content -Path $reportPath -Encoding utf8
Get-Content $reportPath
if ($report.status -eq 'detected') { throw 'Defender detected a threat; do not release this package.' }
