# Wrapper per l'esecuzione schedulata (Task Scheduler, il 15 di ogni mese) di
# rentri_monitor_mensile.py. Usa il percorso UNC (non la lettera di rete H:) perche' un task
# schedulato non eredita sempre le unita' mappate della sessione interattiva.
$ErrorActionPreference = "Stop"
$root = "\\nas-storage\Disco H\PREZZI\RENTRI_scarico"
$python = "C:\Users\GiovanniDilillo\AppData\Local\Microsoft\WindowsApps\python.exe"

Set-Location $root

$logDir = Join-Path $root "monitor_mensile\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$log = Join-Path $logDir "run_$stamp.log"

& $python "monitor_mensile\rentri_monitor_mensile.py" *>&1 | Tee-Object -FilePath $log

# tieni solo gli ultimi 24 log (2 anni di storico mensile), il resto si accumulerebbe all'infinito
Get-ChildItem $logDir -Filter "run_*.log" | Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 24 | Remove-Item -Force
