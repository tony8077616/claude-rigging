#Requires -Version 5.1
<#
  sync.ps1
  功能：把 ~/.claude 中 manifest.txt 列出的項目鏡像到本資料夾，
        另外產生 mcp-servers.json 與 plugins-to-install.txt，掃描機密後 commit。
  讀取：~/.claude 與 ~/.claude.json（只取 mcpServers 屬性，其他屬性絕不寫出）。
  寫入：只寫在本腳本所在資料夾內。
  安全：只要懷疑有機密（掃描命中）就中止，不會 commit。
  用法：
    .\sync.ps1            鏡像 + 掃描 + commit
    .\sync.ps1 -NoCommit  只鏡像 + 掃描
#>
[CmdletBinding()]
param(
    [string]$Source = (Join-Path $HOME '.claude'),
    [string]$ClaudeJson = (Join-Path $HOME '.claude.json'),
    [switch]$NoCommit,
    [switch]$NoRedact,   # 沒有個人名稱名單的機器才用；名單遺失時預設中止，避免專案名外洩
    [string]$RedactFile = (Join-Path $HOME '.claude-config.redact')
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
# 在任何寫入之前檢查：名單遺失時，claude\ 不會被清空重建
if (-not $NoRedact -and -not (Test-Path -LiteralPath $RedactFile)) {
    throw "找不到去識別化名單 $RedactFile。請從備份還原；只有沒有個人名稱的機器才加 -NoRedact。未寫入任何檔案。"
}

function Test-Excluded([string]$path) {
    return ($path -match '\.bak' -or $path -match 'node_modules' -or $path -match '__pycache__')
}

function Copy-ToRepo([string]$from, [string]$to) {
    $dir = Split-Path -Parent $to
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    Copy-Item -LiteralPath $from -Destination $to -Force
}

# ---- Step 1：鏡像 ----
$manifest = Join-Path $PSScriptRoot 'manifest.txt'
$entries = [System.IO.File]::ReadAllLines($manifest, [System.Text.Encoding]::UTF8) |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -ne '' -and -not $_.StartsWith('#') }

# 先清空 claude\，避免 manifest 移除的項目在 repo 留下舊副本
if (Test-Path -LiteralPath (Join-Path $Repo 'claude')) { Remove-Item -LiteralPath (Join-Path $Repo 'claude') -Recurse -Force }
foreach ($rel in $entries) {
    $src = Join-Path $Source $rel
    $dst = Join-Path $Repo ('claude\' + $rel)
    if (Test-Path -LiteralPath $dst) {
        Remove-Item -LiteralPath $dst -Recurse -Force
    }
    if (-not (Test-Path -LiteralPath $src)) {
        Write-Host "MISSING  $rel"
        continue
    }
    if (Test-Path -LiteralPath $src -PathType Container) {
        foreach ($f in (Get-ChildItem -LiteralPath $src -Recurse -File -Force)) {
            if (Test-Excluded $f.FullName) { continue }
            $inner = $f.FullName.Substring($Source.Length).TrimStart('\', '/')
            Copy-ToRepo $f.FullName (Join-Path $Repo ('claude\' + $inner))
        }
    } else {
        Copy-ToRepo $src $dst
    }
    Write-Host "OK       $rel"
}

# ---- Step 1b：advisor-loop 外掛（排除 test 檔與 *.bak）----
$pluginSrc = Join-Path $Source 'local-marketplace\advisor-loop'
$pluginDst = Join-Path $Repo 'plugin\advisor-loop'
$pluginFiles = @()
if (Test-Path -LiteralPath $pluginSrc) { $pluginFiles = @(Get-ChildItem -LiteralPath $pluginSrc -Recurse -File -Force) }
if ($pluginFiles.Count -gt 0 -and (Test-Path -LiteralPath $pluginDst)) { Remove-Item -LiteralPath $pluginDst -Recurse -Force }
foreach ($f in $pluginFiles) {
    if (Test-Excluded $f.FullName) { continue }
    if ($f.Name -match '^test(-ultracode)?\.js$') { continue }
    $inner = $f.FullName.Substring($pluginSrc.Length).TrimStart('\', '/')
    Copy-ToRepo $f.FullName (Join-Path $pluginDst $inner)
}
if ($pluginFiles.Count -gt 0) { Write-Host 'OK       plugin\advisor-loop' } else { Write-Host 'SKIP     plugin\advisor-loop（來源不存在，repo 內的版本保持不變）' }

# ---- Step 2：MCP（只取 mcpServers）----
$cj = [System.IO.File]::ReadAllText($ClaudeJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($null -eq $cj.mcpServers) { throw "mcpServers not found in $ClaudeJson" }
$mcpText = $cj.mcpServers | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText((Join-Path $Repo 'install\mcp-servers.json'), $mcpText, $utf8NoBom)
Write-Host 'OK       mcp-servers.json (mcpServers only)'

# ---- Step 3：外掛清單（不複製 cache 路徑）----
$installed = [System.IO.File]::ReadAllText((Join-Path $Source 'plugins\installed_plugins.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$markets = [System.IO.File]::ReadAllText((Join-Path $Source 'plugins\known_marketplaces.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# 由 sync.ps1 產生。restore.ps1 會依序執行這些指令（需要 claude CLI）。')
foreach ($mp in $markets.PSObject.Properties) {
    $s = $mp.Value.source
    if ($s.source -eq 'github') { $lines.Add("claude plugin marketplace add $($s.repo)") }
    elseif ($s.source -eq 'git') { $lines.Add("claude plugin marketplace add $($s.url)") }
}
foreach ($p in $installed.plugins.PSObject.Properties.Name) {
    if ($p -eq 'advisor-loop@local-advisor') { continue }
    $lines.Add("claude plugin install $p")
}
[System.IO.File]::WriteAllText((Join-Path $Repo 'install\plugins-to-install.txt'), (($lines -join "`n") + "`n"), $utf8NoBom)
Write-Host 'OK       plugins-to-install.txt'

# ---- Step 3a：移除 autoMode 區塊（內容是每台機器自己的環境描述；還原後執行 /auto-mode-setup 重新產生）----
$settingsRepo = Join-Path $Repo 'claude\settings.json'
$sBefore = [System.IO.File]::ReadAllText($settingsRepo, $utf8NoBom)
$sAfter = [regex]::Replace($sBefore, '(?ms)^  "autoMode": \{.*?^  \},?\r?\n', '')
if ($sBefore.Contains('"autoMode"') -and $sAfter -eq $sBefore) { throw 'autoMode 區塊格式不符，無法安全移除，中止' }
if ($sAfter -ne $sBefore) { [System.IO.File]::WriteAllText($settingsRepo, $sAfter, $utf8NoBom) }
Write-Host 'OK       移除 autoMode 區塊'

# ---- Step 3b：路徑 token 化（用執行當下的自動變數 $Repo、$HOME）----
# 本機絕對路徑換成 token（${REPO}、${HOME}，及正斜線與 JSON 跳脫寫法）；restore.ps1 會換回目標機器的路徑。
# 較長的路徑先換：repo 位在家目錄底下，JSON 跳脫寫法先於一般寫法。
$tokenPairs = @(
    @{ From = $Repo.Replace('\', '\\'); To = '${REPO:json}' },
    @{ From = $Repo.Replace('\', '/');  To = '${REPO:fwd}' },
    @{ From = $Repo;                    To = '${REPO}' },
    @{ From = $HOME.Replace('\', '\\'); To = '${HOME:json}' },
    @{ From = $HOME.Replace('\', '/');  To = '${HOME:fwd}' },
    @{ From = $HOME;                    To = '${HOME}' }
)
$textExts = @('.json', '.js', '.mjs', '.ts', '.ps1', '.md', '.py', '.cmd', '.txt', '.conf')
# 撞名防護：live 本身若含 token 字串，restore 會把它誤展開，必須中止
$guardFiles = @(Get-ChildItem -LiteralPath (Join-Path $Repo 'claude') -Recurse -File -Force | Where-Object { $textExts -contains $_.Extension.ToLowerInvariant() }) +
    @(Get-Item -LiteralPath (Join-Path $Repo 'install\mcp-servers.json'))
foreach ($gf in $guardFiles) {
    $gt = [System.IO.File]::ReadAllText($gf.FullName, $utf8NoBom)
    if ($gt.Contains('${HOME') -or $gt.Contains('${REPO')) { throw "live 內含 token 字串，無法安全 token 化：$($gf.Name)" }
}
$tokenGitDir = (Join-Path $Repo '.git') + '\'
$tokenized = 0
foreach ($tf in (Get-ChildItem -LiteralPath $Repo -Recurse -File -Force)) {
    if ($tf.FullName.StartsWith($tokenGitDir)) { continue }
    # plugin/ 與 .claude-plugin/ 是 live 來源，不做 token 化；若出現家目錄路徑，交給掃描規則報錯
    if ($tf.FullName.StartsWith((Join-Path $Repo 'plugin') + '\') -or $tf.FullName.StartsWith((Join-Path $Repo '.claude-plugin') + '\')) { continue }
    if ($textExts -notcontains $tf.Extension.ToLowerInvariant()) { continue }
    $raw = [System.IO.File]::ReadAllBytes($tf.FullName)
    $hasBom = $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF
    $enc = if ($hasBom) { New-Object System.Text.UTF8Encoding($true) } else { $utf8NoBom }
    $text = [System.IO.File]::ReadAllText($tf.FullName, $utf8NoBom)
    $new = $text
    foreach ($p in $tokenPairs) {
        $new = [regex]::Replace($new, [regex]::Escape($p.From), $p.To.Replace('$', '$$'), 'IgnoreCase')
    }
    if ($new -ne $text) {
        [System.IO.File]::WriteAllText($tf.FullName, $new, $enc)
        $tokenized++
    }
}
Write-Host "OK       路徑 token 化：改寫 $tokenized 個檔案"

# ---- Step 3c：去識別化（名單在 repo 外，單向；格式：原文 => 替換文字）----
$redactFile = $RedactFile
if ($NoRedact) {
    Write-Warning '已指定 -NoRedact，略過去識別化'
} elseif (-not (Test-Path -LiteralPath $redactFile)) {
    throw "找不到去識別化名單 $redactFile（沒有名單請加 -NoRedact；名單遺失時不會 commit）"
} else {
    $redact = @()
    foreach ($rl in [System.IO.File]::ReadAllLines($redactFile, [System.Text.Encoding]::UTF8)) {
        if ($rl.Trim() -eq '' -or $rl.TrimStart().StartsWith('#')) { continue }
        $ix = $rl.IndexOf(' => ')
        if ($ix -lt 1) { throw "去識別化名單格式錯誤（缺少 ' => '）" }
        $redact += , @($rl.Substring(0, $ix), $rl.Substring($ix + 4))
    }
    $claudeFiles = @(Get-ChildItem -LiteralPath (Join-Path $Repo 'claude') -Recurse -File -Force | Where-Object { $textExts -contains $_.Extension.ToLowerInvariant() })
    $redacted = 0
    foreach ($cf in $claudeFiles) {
        $raw = [System.IO.File]::ReadAllBytes($cf.FullName)
        $hasBom = $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF
        $enc = if ($hasBom) { New-Object System.Text.UTF8Encoding($true) } else { $utf8NoBom }
        $text = [System.IO.File]::ReadAllText($cf.FullName, $utf8NoBom)
        $new = $text
        foreach ($rp in $redact) {
            $new = [regex]::Replace($new, [regex]::Escape($rp[0]), $rp[1].Replace('$', '$$'), 'IgnoreCase')
        }
        if ($new -ne $text) {
            [System.IO.File]::WriteAllText($cf.FullName, $new, $enc)
            $redacted++
        }
    }
    # 斷言：不得殘留任何原文；只印序號與檔名
    foreach ($cf in $claudeFiles) {
        $t = [System.IO.File]::ReadAllText($cf.FullName, $utf8NoBom)
        for ($i = 0; $i -lt $redact.Count; $i++) {
            if ($t.IndexOf($redact[$i][0], [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "去識別化後仍殘留名單第 $($i + 1) 條原文：$($cf.Name)" }
        }
    }
    try { $null = [System.IO.File]::ReadAllText((Join-Path $Repo 'claude\settings.json'), $utf8NoBom) | ConvertFrom-Json }
    catch { throw "去識別化後 claude\settings.json 無法解析為 JSON" }
    Write-Host "OK       去識別化：套用 $($redact.Count) 條規則，改寫 $redacted 個檔案"
}
# ---- Step 4：機密掃描（只印規則名與位置，絕不印內容）----
$rules = @(
    @{ Name = 'anthropic-key'; Pattern = 'sk-ant-[A-Za-z0-9_\-]{10,}' },
    @{ Name = 'openai-key';    Pattern = 'sk-[A-Za-z0-9]{20,}' },
    @{ Name = 'github-token';  Pattern = 'gh[pousr]_[A-Za-z0-9]{20,}' },
    @{ Name = 'github-pat';    Pattern = 'github_pat_[A-Za-z0-9_]{20,}' },
    @{ Name = 'aws-key';       Pattern = 'AKIA[0-9A-Z]{16}' },
    @{ Name = 'bearer';        Pattern = 'Bearer\s+[A-Za-z0-9\-\._~\+/]{16,}' },
    @{ Name = 'private-key';   Pattern = '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
    @{ Name = 'secret-kv';     Pattern = '(?i)"?(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|client_secret)"?\s*[:=]\s*"?[^"\s,}\]]{8,}' }
)
# 家目錄改寫後，任何追蹤檔都不該再出現使用者路徑或使用者名稱；名稱在執行時推出，本檔不寫死
$rules += @{ Name = 'home-user-path'; Pattern = '(?i)[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"<>|]+' }
foreach ($name in @($env:USERNAME, (Split-Path -Leaf $HOME)) | Where-Object { $_ }) {
    $rules += @{ Name = 'local-username'; Pattern = '(?i)' + [regex]::Escape($name) }
}
$skipNames = @('sync.ps1', 'restore.ps1', 'README.md')
$gitDir = Join-Path $Repo '.git'
$hits = 0
foreach ($f in (Get-ChildItem -LiteralPath $Repo -Recurse -File -Force)) {
    if ($f.FullName.StartsWith($gitDir + '\')) { continue }
    $relPath = $f.FullName.Substring($Repo.Length).TrimStart('\', '/')
    if ($skipNames -contains $f.Name) { continue }
    if ($f.Length -gt 5MB) {
        Write-Host "SKIP     $relPath (larger than 5 MB, not scanned)"
        continue
    }
    $n = 0
    foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
        $n++
        foreach ($r in $rules) {
            if ($line -match $r.Pattern) {
                Write-Host "HIT $($r.Name)  ${relPath}:$n"
                $hits++
            }
        }
    }
}
if ($hits -gt 0) { throw "secret scan found $hits hit(s); nothing was committed." }
Write-Host 'OK       secret scan passed'

# ---- Step 5：commit ----
if ($NoCommit) {
    Write-Host 'done (-NoCommit)'
    exit 0
}
$ErrorActionPreference = 'Continue'   # git 會把進度寫到 stderr，成敗只看 LASTEXITCODE
Push-Location $Repo
try {
    git add -A
    if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
    $staged = @(git diff --cached --name-status)
    if ($staged.Count -eq 0) {
        Write-Host 'no changes, nothing to commit'
        exit 0
    }
    $msgFile = [System.IO.Path]::GetTempFileName()
    try {
        $body = 'sync ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') + "`r`n`r`n" + ($staged -join "`r`n")
        [System.IO.File]::WriteAllText($msgFile, $body, $utf8NoBom)
        git commit -q -F $msgFile
        if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
    } finally {
        Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue
    }
    Write-Host "committed $($staged.Count) change(s)"
} finally {
    Pop-Location
}
