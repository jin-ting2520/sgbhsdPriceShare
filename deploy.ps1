# ============================================================
#  三国冰河时代富甲天下跑商价格分享 - 一键部署脚本（Windows PowerShell）
#  用法：
#    .\deploy.ps1            构建并启动（默认）
#    .\deploy.ps1 start      同上
#    .\deploy.ps1 update     重新构建并重启
#    .\deploy.ps1 stop       停止
#    .\deploy.ps1 logs       跟踪日志
#    .\deploy.ps1 status     查看状态
#    .\deploy.ps1 backup     备份 MySQL（无 mysql 服务时备份 SQLite）到 .\backup
#    .\deploy.ps1 restore    从 .\backup 的 .sql / .db 恢复数据库
#    .\deploy.ps1 clean      停止并删除容器（保留数据卷）
#  可用环境变量 PORT 覆盖端口（默认 3000）
# ============================================================
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'update', 'stop', 'restart', 'logs', 'status', 'backup', 'restore', 'clean')]
  [string]$Command = 'start',

  [Parameter(Position = 1)]
  [string]$RestoreFile = ''
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not $env:PORT) { $env:PORT = '3000' }
$AppName = 'sgbhsd-price-share'
$Compose = 'docker compose'

function Test-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host '[错误] 未检测到 docker，请先安装 Docker Desktop（https://docs.docker.com/get-docker/）' -ForegroundColor Red
    exit 1
  }
  try { docker info | Out-Null } catch {
    Write-Host '[错误] Docker Desktop 未运行' -ForegroundColor Red
    exit 1
  }
}

function Wait-Health {
  Write-Host "  => 等待服务就绪（http://localhost:$env:PORT，首次启动初始化 MySQL 可能较慢）..."
  for ($i = 0; $i -lt 90; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$env:PORT/api/health" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) {
        Write-Host '  => 启动成功！' -ForegroundColor Green
        return $true
      }
    } catch { Start-Sleep -Seconds 1 }
  }
  Write-Host '  => 启动超时，请执行 .\deploy.ps1 logs 查看日志' -ForegroundColor Yellow
  return $false
}

switch ($Command) {
  'start' {
    Test-Docker
    New-Item -ItemType Directory -Force -Path 'data', 'backup' | Out-Null
    Write-Host "==> 构建镜像并启动 $AppName"
    & $Compose build
    & $Compose up -d
    Wait-Health | Out-Null
    Write-Host ''
    Write-Host "  访问地址 : http://localhost:$env:PORT"
    Write-Host "  数据存储 : MySQL 数据卷 mysql-data（SQLite 兜底/迁移源：$(Join-Path (Get-Location) 'data\price.db')）"
    Write-Host '  备份命令 : .\deploy.ps1 backup'
    Write-Host ''
  }
  'update' {
    Test-Docker
    Write-Host '==> 重新构建并重启'
    & $Compose build
    & $Compose up -d
    Wait-Health | Out-Null
  }
  'stop' {
    Test-Docker
    Write-Host "==> 停止 $AppName"
    & $Compose stop
  }
  'restart' {
    Test-Docker
    & $Compose restart
    Wait-Health | Out-Null
  }
  'logs' {
    Test-Docker
    & $Compose logs -f --tail 100
  }
  'status' {
    Test-Docker
    & $Compose ps
  }
  'backup' {
    Test-Docker
    New-Item -ItemType Directory -Force -Path 'backup' | Out-Null
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $services = & $Compose ps --status running --services 2>$null
    if ($services -contains 'mysql') {
      $file = "backup\mysql-$ts.sql"
      & $Compose exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --databases "$MYSQL_DATABASE" > "/backup/mysql-$1.sql"' sh $ts
    } else {
      $file = "backup\price-$ts.db"
      try {
        & $Compose cp app:/app/data/price.db $file
      } catch {
        Copy-Item -LiteralPath 'data\price.db' -Destination $file -Force
      }
    }
    Write-Host "==> 已备份到 $file"
  }
  'restore' {
    Test-Docker
    if (-not $RestoreFile -or -not (Test-Path -LiteralPath $RestoreFile)) {
      Write-Host '用法: .\deploy.ps1 restore backup\mysql-YYYYmmdd-HHMMSS.sql'
      Write-Host '      .\deploy.ps1 restore backup\price-YYYYmmdd-HHMMSS.db'
      if (Test-Path 'backup') { Get-ChildItem backup | Select-Object -ExpandProperty Name }
      exit 1
    }
    $ok = Read-Host "确认用 $RestoreFile 覆盖当前数据库？（容器将重启）[y/N]"
    if ($ok -ne 'y' -and $ok -ne 'Y') { exit 0 }
    if ($RestoreFile -like '*.sql') {
      $base = Split-Path -Leaf $RestoreFile
      & $Compose stop app | Out-Null
      & $Compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" < "/backup/$1"' sh $base
      & $Compose start app | Out-Null
    } else {
      Copy-Item -LiteralPath $RestoreFile -Destination 'data\price.db' -Force
      & $Compose restart app
    }
    Write-Host '==> 已恢复并重启' -ForegroundColor Green
  }
  'clean' {
    Test-Docker
    $ok = Read-Host '确认停止并删除容器？（MySQL 数据卷与 .\data 会保留）[y/N]'
    if ($ok -ne 'y' -and $ok -ne 'Y') { exit 0 }
    & $Compose down
    Write-Host '==> 已清理（数据仍在 Docker 卷 mysql-data 与 .\data 目录）'
  }
}
