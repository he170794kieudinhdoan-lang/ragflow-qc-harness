# Clean Windows dev launcher for RAGFlow QC Harness
# Avoids uvicorn --reload CTRL_C console-group kills and clears stale Vite port-5173 processes.

Write-Host "Cleaning stale RAGFlow QC Harness processes on ports 8000 / 5173..." -ForegroundColor Cyan
Get-NetTCPConnection -LocalPort 8000,5173 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue
        if ($proc -and ($proc.CommandLine -match "ragflow-qc-harness" -or $proc.CommandLine -match "uvicorn")) {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
    }

Start-Sleep -Milliseconds 400

$BackendPy = Join-Path $PSScriptRoot "backend\.venv\Scripts\python.exe"
if (-not (Test-Path $BackendPy)) {
    $RootVenvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
    if (Test-Path $RootVenvPy) {
        $BackendPy = $RootVenvPy
    } else {
        $BackendPy = "python"
    }
}

Write-Host "Starting Backend (http://127.0.0.1:8000) using $BackendPy..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot\backend'; & '$BackendPy' -m uvicorn main:app --host 127.0.0.1 --port 8000"

Write-Host "Starting Frontend (http://localhost:5173) in dedicated window..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot\frontend'; npm run dev"

Write-Host "Done! Open http://localhost:5173 in your browser." -ForegroundColor Yellow
