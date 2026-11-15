#Requires -Version 5.1
#Requires -PSEdition Desktop
# 必須用 Windows PowerShell 5.1 執行：pwsh 7 會重複跳脫傳給 .ps1 shim 的 JSON 參數（已實測）
<#
  restore.ps1 - 把這個 repo 還原到 ~/.claude

  - 每個會被覆寫的既有檔案，會先備份到 ~/.claude-restore-backup/<timestamp>/
  - 永遠不讀取或寫入 .credentials.json
  - 永遠不整份複製 ~/.claude.json（只合併其中的 mcpServers 屬性）

  用法：
    .\restore.ps1 -DryRun   預覽，不寫入任何檔案
    .\restore.ps1           實際套用
#>
[CmdletBinding()]
param(
    [string]$Target = (Join-Path $HOME '.claude'),
    [string]$ClaudeJson = (Join-Path $HOME '.claude.json'),
    [switch]$DryRun,
    [switch]$SkipMcp,
    [switch]$SkipPlugins
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path (Split-Path -Parent $Target) ('.claude-restore-backup\' + $stamp)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---- Step 1：外部前置工具 ----
Write-Host '外部前置工具'
foreach ($name in @('node', 'git', 'python', 'gh', 'uvx', 'claude')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { Write-Host "OK   $name" } else { Write-Host "MISS $name" }
}
$orcaHook = Join-Path $HOME '.orca\agent-hooks\orca-agent-hook.exe'
if (Test-Path -LiteralPath $orcaHook) {
    Write-Host 'OK   Orca hook'
} else {
    Write-Host 'MISS Orca hook (statusLine 與 Stop hook 依賴它)'
}

# ---- Step 2：token 展開表（用執行當下的自動變數 $HOME、$Repo）----
# repo 內的 ${HOME}、${REPO} 等 token 會換成本機實際路徑；與 sync.ps1 的 $tokenPairs 對應。
$expand = [ordered]@{
    '${REPO:json}' = $Repo.Replace('\', '\\')
    '${REPO:fwd}'  = $Repo.Replace('\', '/')
    '${REPO}'      = $Repo
    '${HOME:json}' = $HOME.Replace('\', '\\')
    '${HOME:fwd}'  = $HOME.Replace('\', '/')
    '${HOME}'      = $HOME
}
function Expand-Tokens([string]$text, [string]$where) {
    foreach ($k in $expand.Keys) { $text = $text.Replace($k, $expand[$k]) }
    if ($text -match '\$\{(HOME|REPO)') { throw "未展開的路徑 token：$where" }
    return $text
}

# ---- Step 3：檔案清單 ----
$claudeRoot = Join-Path $Repo 'claude'
$repoFwd = $Repo.Replace('\', '/')
$textExt = @('.json', '.js', '.mjs', '.ts', '.ps1', '.md', '.py', '.cmd', '.txt', '.conf')
$files = @()
foreach ($f in (Get-ChildItem -LiteralPath $claudeRoot -Recurse -File -Force)) {
    $rp = $f.FullName.Substring($claudeRoot.Length).TrimStart('\', '/')
    $files += [pscustomobject]@{ Rp = $rp; Src = $f.FullName; Ext = $f.Extension.ToLowerInvariant() }
}

# 預檢：所有文字檔先展開並檢查殘留 token，全部通過才開始複製（DryRun 也跑）
foreach ($item in $files) {
    if ($textExt -contains $item.Ext) { $null = Expand-Tokens ([System.IO.File]::ReadAllText($item.Src, $utf8NoBom)) $item.Rp }
}

# ---- Step 4：複製 ----
$copied = 0
$backedUp = 0
$rewritten = 0
foreach ($item in $files) {
    $rp = $item.Rp
    $dst = Join-Path $Target $rp
    $exists = Test-Path -LiteralPath $dst
    if ($DryRun) {
        if ($exists) {
            Write-Host "would back up  $rp"
            $backedUp++
        }
        Write-Host "would copy  $rp"
        $copied++
    } else {
        if ($exists) {
            $bak = Join-Path $backupRoot $rp
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bak) | Out-Null
            Copy-Item -LiteralPath $dst -Destination $bak -Force
            $backedUp++
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath $item.Src -Destination $dst -Force
        $copied++
    }
    if ($textExt -contains $item.Ext) {
        $raw = [System.IO.File]::ReadAllBytes($item.Src)
        $hasBom = $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF
        $enc = if ($hasBom) { New-Object System.Text.UTF8Encoding($true) } else { $utf8NoBom }
        $text = [System.IO.File]::ReadAllText($item.Src, $utf8NoBom)
        $new = Expand-Tokens $text $rp
        if ($item.Rp -eq 'settings.json') {
            # advisor-loop 改由本 repo 的 marketplace（claude-config）提供
            $new = $new.Replace('advisor-loop@local-advisor', 'advisor-loop@claude-config')
            $new = $new.Replace('"local-advisor": {', '"claude-config": {')
            $settingsFinal = $new
            $settingsEnc = $enc
        }
        if ($new -ne $text) {
            if ($DryRun) {
                Write-Host "would rewrite  $rp"
            } else {
                [System.IO.File]::WriteAllText($dst, $new, $enc)
            }
            $rewritten++
        }
    }
}
Write-Host "摘要：copied $copied, backed up $backedUp, rewritten $rewritten, dry-run $($DryRun.IsPresent)"

# ---- Step 5：合併 MCP 設定 ----
$mcpFile = Join-Path $Repo 'install\mcp-servers.json'
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($SkipMcp) {
    Write-Host '略過 MCP（-SkipMcp）'
} elseif ($claudeCmd -and (Test-Path -LiteralPath $mcpFile)) {
    # 優先用 claude CLI 註冊，不直接改寫 ~/.claude.json
    $mcpObj = (Expand-Tokens (Get-Content -LiteralPath $mcpFile -Raw -Encoding UTF8) 'install/mcp-servers.json') | ConvertFrom-Json
    # 依 MSVCRT 規則把單一參數組成命令列字串，避開 PowerShell 5.1 的原生參數傳遞
    function ConvertTo-WinArg([string]$s) {
        $bsChar = [char]92; $qChar = [char]34
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append($qChar)
        $bs = 0
        foreach ($ch in $s.ToCharArray()) {
            if ($ch -eq $bsChar) { $bs++; continue }
            if ($ch -eq $qChar) { [void]$sb.Append($bsChar, $bs * 2 + 1); [void]$sb.Append($qChar) }
            else { [void]$sb.Append($bsChar, $bs); [void]$sb.Append($ch) }
            $bs = 0
        }
        [void]$sb.Append($bsChar, $bs * 2)
        [void]$sb.Append($qChar)
        $sb.ToString()
    }
    foreach ($prop in $mcpObj.PSObject.Properties) {
        $json = $prop.Value | ConvertTo-Json -Depth 20 -Compress
        if ($DryRun) { Write-Host "would add-json mcp $($prop.Name)"; continue }
        $manual = "claude mcp add-json -s user $($prop.Name) '" + $json.Replace("'", "'\''") + "'"
        # 參數是否簡單（JSON 內無空白、無 \"，也無 cmd 特殊字元）：.cmd 會再經過 cmd.exe 解析，只能走簡單路徑
        $plain = $json -notmatch '[\s%^&|<>]|\\"'
        if ($claudeCmd.Source -like '*.exe') {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $claudeCmd.Source
            $psi.Arguments = ((@('mcp', 'add-json', '-s', 'user', $prop.Name, $json) | ForEach-Object { ConvertTo-WinArg $_ }) -join ' ')
            $psi.UseShellExecute = $false
            $psi.RedirectStandardInput = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
            $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
            $psi.CreateNoWindow = $true
            $proc = [System.Diagnostics.Process]::Start($psi)
            $proc.StandardInput.Close()
            $errTask = $proc.StandardError.ReadToEndAsync()
            $outText = $proc.StandardOutput.ReadToEnd() + $errTask.Result
            $proc.WaitForExit()
            $code = $proc.ExitCode
        } elseif ($plain) {
            # 原生 stderr 經 2>&1 會變成 ErrorRecord，必須暫時改成 Continue，否則 Stop 會中斷整個 restore
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            try { $outText = (& $claudeCmd.Source mcp add-json -s user $prop.Name ($json.Replace('"', '\"')) 2>&1 | Out-String) }
            finally { $ErrorActionPreference = $prevEAP }
            $code = $LASTEXITCODE
        } else {
            Write-Host "FAIL mcp $($prop.Name)：claude 是 .cmd，無法安全傳入含空白、引號或結尾反斜線的參數。手動指令（Git Bash）：$manual"
            continue
        }
        if ($code -eq 0) { Write-Host "OK   mcp $($prop.Name)"; continue }
        if ($outText -match 'already exists') { Write-Host "SKIP mcp $($prop.Name)（機器上已存在，保留現有設定）"; continue }
        $firstLine = ($outText -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
        Write-Host "FAIL mcp $($prop.Name)（exit $code）：$firstLine。手動指令（請在 Git Bash 執行）：$manual"
    }
} elseif (-not (Test-Path -LiteralPath $mcpFile)) {
    Write-Host '略過 MCP 合併（repo 內沒有 mcp-servers.json）'
} else {
    $servers = (Expand-Tokens (Get-Content -LiteralPath $mcpFile -Raw -Encoding UTF8) 'install/mcp-servers.json') | ConvertFrom-Json
    if (Test-Path -LiteralPath $ClaudeJson) {
        if (-not $DryRun) {
            New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
            Copy-Item -LiteralPath $ClaudeJson -Destination (Join-Path $backupRoot '.claude.json') -Force
        }
        $cj = Get-Content -LiteralPath $ClaudeJson -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $cj = New-Object PSObject
    }
    $cj | Add-Member -NotePropertyName mcpServers -NotePropertyValue $servers -Force
    if ($DryRun) {
        Write-Host "would merge mcpServers into $ClaudeJson"
    } else {
        [System.IO.File]::WriteAllText($ClaudeJson, ($cj | ConvertTo-Json -Depth 50), $utf8NoBom)
        Write-Host "已合併 mcpServers 到 $ClaudeJson"
    }
}

# ---- Step 6：外掛清單 ----
$pluginFile = Join-Path $Repo 'install\plugins-to-install.txt'
if (Test-Path -LiteralPath $pluginFile) {
    Write-Host ''
    Write-Host '外掛與 marketplace 指令（由 sync.ps1 產生，需要 claude CLI）：'
    Write-Host ([System.IO.File]::ReadAllText($pluginFile, $utf8NoBom))
}
if ($SkipPlugins) {
    Write-Host '略過外掛註冊（-SkipPlugins）'
} elseif (-not $claudeCmd) {
    Write-Host '找不到 claude CLI，外掛請依上方指令手動執行'
} elseif (Test-Path -LiteralPath $pluginFile) {
    # 順序：先加 marketplace（檔案內的 + 本 repo），再 install。參數用陣列傳入，路徑含空白也安全。
    $fileLines = @(Get-Content -LiteralPath $pluginFile -Encoding UTF8)
    $plans = New-Object System.Collections.Generic.List[object]
    foreach ($l in $fileLines) { if ($l -like 'claude plugin marketplace add *') { $plans.Add(@($l.Substring(7).Split(' '))) } }
    $plans.Add(@('plugin', 'marketplace', 'add', $Repo))
    $plans.Add(@('plugin', 'install', 'advisor-loop@claude-config'))
    foreach ($l in $fileLines) { if ($l -like 'claude plugin install *' -and $l -notlike '*advisor-loop@claude-config*') { $plans.Add(@($l.Substring(7).Split(' '))) } }
    foreach ($p in $plans) {
        if ($DryRun) { Write-Host ('would run: claude ' + ($p -join ' ')); continue }
        Write-Host ('> claude ' + ($p -join ' '))
        & $claudeCmd.Source @p
    }
}
# 外掛安裝可能改寫 enabledPlugins，所以最後把已改寫的 settings.json 再寫回一次
if ($settingsFinal -and -not $DryRun -and -not $SkipPlugins) {
    $wEnc = if ($settingsEnc) { $settingsEnc } else { $utf8NoBom }
    [System.IO.File]::WriteAllText((Join-Path $Target 'settings.json'), $settingsFinal, $wEnc)
    Write-Host '已重新寫回 settings.json（外掛安裝不會改動還原後的設定）'
}

# ---- Step 7：後續步驟 ----
Write-Host ''
Write-Host '後續步驟：'
Write-Host '1) 開啟 Claude Code 並登入（.credentials.json 不在 repo 內，需要重新登入）'
Write-Host '2) 安裝上方列出的外掛'
Write-Host '3) 安裝「外部前置工具」中標示 MISS 的工具'
Write-Host "4) 若有備份，備份位置是 $backupRoot"
