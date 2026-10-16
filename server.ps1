<#
  墨语 · 本地服务器
  ---------------------------------------------------------------------------
  用 Windows 自带的 PowerShell + HttpListener 实现，零第三方依赖、零安装。

  职责：
    1. 提供应用静态文件（index.html / js / css / lib）
    2. 提供数据存储 API，把书籍与笔记写进本文件夹的 data/ 目录
    3. 打开时自动唤起浏览器

  数据存放位置：
    data/library.json   书架元数据、笔记、书签、阅读设置
    data/books/<id>.json  单本书的全部章节正文
    data/                整个文件夹复制到另一台电脑即可继续使用
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 以脚本所在目录为根，这样整个文件夹可以随意移动
$Root = $PSScriptRoot
$DataDir = Join-Path $Root 'data'

$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-Info($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Write-Err($msg)  { Write-Host $msg -ForegroundColor Red }

# ── MIME 类型 ────────────────────────────────────────────────────────────
$ExtMap = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon'
  '.woff' = 'font/woff'
  '.woff2'= 'font/woff2'
  '.ttf'  = 'font/ttf'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/markdown; charset=utf-8'
}

function Get-MimeType($path) {
  $ext = [System.IO.Path]::GetExtension($path).ToLower()
  if ($ExtMap.ContainsKey($ext)) { return $ExtMap[$ext] }
  return 'application/octet-stream'
}

# ── 数据目录准备 ─────────────────────────────────────────────────────────
# books 子目录必须始终存在，否则导入书籍时写入会失败
if (-not (Test-Path (Join-Path $DataDir 'books'))) {
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'books') | Out-Null
}

# ── JSON 读写 ────────────────────────────────────────────────────────────
function Read-Json($path) {
  if (-not (Test-Path $path)) { return $null }
  $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  try { return $raw | ConvertFrom-Json } catch { return $null }
}

# 用临时文件 + 移动的方式写，避免中途崩溃损坏数据文件
function Write-Json($path, $obj) {
  $dir = Split-Path $path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $json = $obj | ConvertTo-Json -Depth 64 -Compress
  $tmp = "$path.tmp"
  [System.IO.File]::WriteAllText($tmp, $json, $Utf8NoBom)
  if (Test-Path $path) { Remove-Item $path -Force }
  Move-Item $tmp $path -Force
}

$LibraryPath = Join-Path $DataDir 'library.json'
$BooksDir    = Join-Path $DataDir 'books'

# 空的 library 结构模板
function New-EmptyLibrary {
  return [ordered]@{
    version   = 1
    books     = @()
    notes     = @()
    bookmarks = @()
    kv        = [ordered]@{}
  }
}

# 每次访问都从磁盘读，不做内存缓存。
# 用户可能手动备份、整理或删除 data 目录里的文件，缓存会把内存里的旧内容
# 覆盖回去，表现为「明明删了却复活」。
function Read-Library {
  $data = Read-Json $LibraryPath
  if ($null -eq $data) { return (New-EmptyLibrary) }
  # 补齐可能缺失的字段，避免旧版本文件结构不完整导致后续写入失败
  if ($null -eq $data.books)     { $data | Add-Member -NotePropertyName books -NotePropertyValue @() -Force }
  if ($null -eq $data.notes)     { $data | Add-Member -NotePropertyName notes -NotePropertyValue @() -Force }
  if ($null -eq $data.bookmarks) { $data | Add-Member -NotePropertyName bookmarks -NotePropertyValue @() -Force }
  if ($null -eq $data.kv)        { $data | Add-Member -NotePropertyName kv -NotePropertyValue ([ordered]@{}) -Force }
  return $data
}

# 首次运行时生成一个空库文件
if (-not (Test-Path $LibraryPath)) {
  Write-Json $LibraryPath (New-EmptyLibrary)
}

# ── 响应辅助 ─────────────────────────────────────────────────────────────
function Send-Bytes($ctx, $bytes, $mime, $code) {
  $ctx.Response.StatusCode = $code
  $ctx.Response.ContentType = $mime
  $ctx.Response.ContentLength64 = $bytes.Length
  try {
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {}
  $ctx.Response.Close()
}

function Send-Json($ctx, $obj, $code) {
  $json = $obj | ConvertTo-Json -Depth 64 -Compress
  $bytes = $Utf8NoBom.GetBytes($json)
  Send-Bytes $ctx $bytes 'application/json; charset=utf-8' $(if ($code) { $code } else { 200 })
}

function Send-Error($ctx, $msg, $code) {
  Send-Json $ctx @{ error = $msg } $(if ($code) { $code } else { 400 })
}

function Read-Body($ctx) {
  $ms = New-Object System.IO.MemoryStream
  $ctx.Request.InputStream.CopyTo($ms)
  return $ms.ToArray()
}

# ── 静态文件服务 ─────────────────────────────────────────────────────────
function Serve-Static($ctx, $urlPath) {
  $rel = [System.Uri]::UnescapeDataString($urlPath.TrimStart('/'))
  if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }

  # 防目录穿越：解析后的路径必须仍在根目录内
  $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
  if (-not $full.StartsWith($Root)) {
    Send-Error $ctx '非法路径' 403
    return
  }
  if (-not (Test-Path $full) -or (Get-Item $full).PSIsContainer) {
    Send-Error $ctx '文件不存在' 404
    return
  }

  # Service Worker 之类的文件不要缓存，改代码后刷新即可生效
  $noCache = ($full -match '\.(html|css|js|mjs|webmanifest)$') -or ($rel -eq 'sw.js')
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $ctx.Response.StatusCode = 200
  $ctx.Response.ContentType = Get-MimeType $full
  $ctx.Response.ContentLength64 = $bytes.Length
  if ($noCache) {
    $ctx.Response.AddHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }
  try { $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) } catch {}
  $ctx.Response.Close()
}

# ── 数据 API ─────────────────────────────────────────────────────────────
function Handle-Api($ctx, $route, $segments) {
  switch -Wildcard ($route) {
    '/api/ping' {
      Send-Json $ctx @{ ok = $true; dataDir = $DataDir; app = 'moyu-reader' } 200
      return
    }

    # 整库读写：书架元数据 + 笔记 + 书签 + 设置
    '/api/library' {
      if ($ctx.Request.HttpMethod -eq 'GET') {
        Send-Json $ctx (Read-Library) 200
      } elseif ($ctx.Request.HttpMethod -eq 'PUT') {
        $body = Read-Body $ctx
        $incoming = ($Utf8NoBom.GetString($body)) | ConvertFrom-Json
        $newLib = [ordered]@{
          version   = 1
          books     = @($incoming.books)
          notes     = @($incoming.notes)
          bookmarks = @($incoming.bookmarks)
          kv        = $incoming.kv
        }
        Write-Json $LibraryPath $newLib
        Send-Json $ctx @{ ok = $true } 200
      } else {
        Send-Error $ctx '不支持的方法' 405
      }
      return
    }

    # 单本书正文：/api/book/<id>
    '/api/*' {
      $id = $segments[2]
      if ([string]::IsNullOrWhiteSpace($id) -or $id -match '[^A-Za-z0-9_-]') {
        Send-Error $ctx '书籍 ID 非法' 400
        return
      }
      $path = Join-Path $BooksDir "$id.json"
      if ($ctx.Request.HttpMethod -eq 'GET') {
        $doc = Read-Json $path
        if ($null -eq $doc) { Send-Json $ctx @{ bookId = $id; chapters = @() } 200 }
        else { Send-Json $ctx $doc 200 }
      } elseif ($ctx.Request.HttpMethod -eq 'PUT') {
        $body = Read-Body $ctx
        $doc = ($Utf8NoBom.GetString($body)) | ConvertFrom-Json
        Write-Json $path $doc
        Send-Json $ctx @{ ok = $true } 200
      } elseif ($ctx.Request.HttpMethod -eq 'DELETE') {
        if (Test-Path $path) { Remove-Item $path -Force }
        Send-Json $ctx @{ ok = $true } 200
      } else {
        Send-Error $ctx '不支持的方法' 405
      }
      return
    }

    default {
      Send-Error $ctx '未知接口' 404
      return
    }
  }
}

# ── 主循环 ───────────────────────────────────────────────────────────────
$Port = 0
$Listener = $null
# 从 8899 起找一个未被占用的端口，最多试 50 个
for ($try = 8899; $try -lt 8950; $try++) {
  $tmp = New-Object System.Net.HttpListener
  $tmp.Prefixes.Add("http://127.0.0.1:$try/")
  try {
    $tmp.Start()
    $Listener = $tmp
    $Port = $try
    break
  } catch {
    $tmp.Close()
    continue
  }
}

if ($null -eq $Listener) {
  Write-Err '无法启动：8899-8949 端口都被占用，请关闭其他占用端口的程序后重试。'
  Read-Host '按回车键退出'
  exit 1
}

$Url = "http://127.0.0.1:$Port/"
Write-Host ''
Write-Host '  ┌────────────────────────────────────────────┐'
Write-Host '  │           墨语 · 本地电子书阅读器           │'
Write-Host '  └────────────────────────────────────────────┘'
Write-Host ''
Write-Ok "  已在浏览器中打开： $Url"
Write-Host "  数据目录：$DataDir"
Write-Host "  整个文件夹复制到别的电脑，数据会一起带走。"
Write-Host ''
Write-Host '  用法：直接把书拖进网页即可。'
Write-Host '  关闭：直接关掉这个黑色窗口，或按 Ctrl+C。'
Write-Host ''

Start-Process $Url

while ($Listener.IsListening) {
  try {
    $ctx = $Listener.GetContext()
  } catch {
    break
  }

  try {
    $urlPath = $ctx.Request.Url.AbsolutePath
    $segments = @($urlPath -split '/' | Where-Object { $_ -ne '' })

    if ($segments.Count -gt 0 -and $segments[0] -eq 'api') {
      # 两段路径 /api/xxx 精确匹配，三段 /api/book/xxx 走通配
      if ($segments.Count -ge 3) { $route = '/api/*' }
      else { $route = '/api/' + $segments[1] }
      Handle-Api $ctx $route $segments
    } else {
      Serve-Static $ctx $urlPath
    }
  } catch {
    try {
      Send-Error $ctx ('服务器错误：' + $_.Exception.Message) 500
    } catch {}
  }
}

$Listener.Close()