# llama-server + local-assistant를 한 번에 띄우는 편의 스크립트.
# 실행 전에 .env.example을 .env로 복사하고 LLAMA_CPP_DIR / MODEL_PATH를 채워야 한다.

# repo root의 .env를 파싱해 $env:KEY=VALUE로 로드 (없으면 스킵)
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { return }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        Set-Item -Path "env:$key" -Value $value
    }
}

if (-not $env:LLAMA_CPP_DIR -or -not $env:MODEL_PATH) {
    Write-Error "LLAMA_CPP_DIR / MODEL_PATH가 설정되지 않았습니다. .env.example을 .env로 복사하고 값을 채워주세요."
    exit 1
}

$llamaHost = if ($env:LLAMA_HOST) { $env:LLAMA_HOST } else { '127.0.0.1' }
$llamaPort = if ($env:LLAMA_PORT) { $env:LLAMA_PORT } else { '8080' }

# 아래 성능 인자(-ngl, --n-cpu-moe, --threads, -c, --cache-type-*, --reasoning-budget 등)는
# 이 컴퓨터의 GPU/CPU 사양(VRAM 크기, 코어 수)에 맞춘 값이다. 다른 하드웨어에서는
# llama.cpp 문서를 참고해 직접 조정할 것.
Start-Process pwsh -ArgumentList '-NoExit', '-Command', @"
cd '$($env:LLAMA_CPP_DIR)'
./build/bin/Release/llama-server -m '$($env:MODEL_PATH)' --jinja -ngl 99 --n-cpu-moe 34 --threads 18 --threads-batch 18 -c 75000 --no-mmap --reasoning-budget 4092 --cache-type-k q8_0 --cache-type-v q8_0 -fa on --host $llamaHost --port $llamaPort
"@

Start-Process pwsh -ArgumentList '-NoExit', '-Command', @"
cd '$PSScriptRoot'
npm start
"@
