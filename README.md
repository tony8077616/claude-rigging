# claude-config

`~/.claude` 的指令、hooks、subagent 與 advisor-loop 外掛，用 git 記錄每次變動。重灌後一鍵還原。

## 一鍵還原（重灌後）

```powershell
winget install Git.Git
winget install GitHub.cli
winget install Anthropic.ClaudeCode
# 關閉並重新開啟 PowerShell，讓 PATH 生效
gh auth login
gh repo clone tony8077616/claude-rigging $HOME\claude-config
powershell -NoProfile -ExecutionPolicy Bypass -File $HOME\claude-config\install\restore.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File $HOME\claude-config\install\restore.ps1
```

- 前置工具（node、python、uvx、Orca）不會自動安裝，restore 開頭會列出缺少的項目。
- 還原後執行 `claude` 登入（`.credentials.json` 不在 repo 內）。

- 覆寫前的既有檔案會備份到 `~/.claude-restore-backup/<時間>/`。
- `-SkipMcp`、`-SkipPlugins` 可略過 MCP 與外掛註冊。
- advisor-loop 的唯一來源是本 repo 的 `plugin/advisor-loop`。

## 日常

- `powershell -NoProfile -File tools\sync.ps1`：從 `~/.claude` 鏡像到 repo、掃描機密、commit（不推送）。
- `git log -p`、`git show <commit>`：查看改了什麼，確認後 `git push`。
- 看舊版本用 `git show <commit>:<路徑>` 或 `git log -p -- <路徑>`，**不要 checkout 舊 commit**。工作目錄裡的 `plugin/advisor-loop` 是正在運作的 hook 來源，checkout 舊 commit 會讓它消失。

## 路徑 token

- repo 內的家目錄與 repo 路徑以 token 表示：`${HOME}`、`${HOME:fwd}`、`${HOME:json}`、`${REPO}`、`${REPO:fwd}`、`${REPO:json}`，分別對應 `\` 路徑、`/` 路徑、JSON 跳脫的 `\\` 路徑。
- `sync.ps1` 寫入時用執行當下的 `$HOME`、`$Repo` 產生 token；`restore.ps1` 還原時用目標機器的 `$HOME`、`$Repo` 展開。
- repo 不含使用者名稱。去識別化名單 `~/.claude-config.redact`（每行 `原文 => 替換文字`，`#` 開頭為註解）只存在本機，不在 repo 內；找不到名單時 sync 會在寫入任何檔案之前中止；沒有名單的機器要加 `-NoRedact`。名單依檔案順序套用，較長的原文要放在前面。
- 去識別化是**單向**的：從 repo 還原後，名單中的原文不會回來，`block-grep.js` 的範例路徑會是通用版本。`settings.json` 的 `autoMode` 區塊不收進 repo（內容是每台機器自己的環境描述）；還原後請執行 `/auto-mode-setup` 重新產生。
- 若 live 的 `claude/` 或 MCP 設定本身含 token 字串，sync 會中止（無法安全 token 化）。

## 結構

- `claude/`：`~/.claude` 白名單的鏡像。
- `plugin/advisor-loop/`：Advisor 強制迴圈與 ultracode 注入的 plugin。
- `install/`：`restore.ps1`、`mcp-servers.json`、`plugins-to-install.txt`。
- `tools/`：`sync.ps1` 與白名單 `manifest.txt`。
- `.claude-plugin/marketplace.json`：讓本 repo 可被 `claude plugin marketplace add` 加入。

## 刻意不收

`.credentials.json`、`projects/`、`sessions/`、`security/`、`tmp/`、`state/`、外掛快取、memory（含基礎設施細節，先不收）、`~/.claude.json` 其他欄位（只取 `mcpServers`）、各工具安裝的 `skills/*`、舊副本 `hooks/advisor-loop`、`calico/`（第三方修補版的更新器，不屬於本 repo，sync 也會移除它的 hook）。

## 已知限制

- **MCP 參數傳遞（`.exe` 安裝）已修正。** 以下案例已用真 CLI 驗證可正確存入：空白、引號、結尾反斜線、`a\"b`、UNC 路徑、空字串、`%`、`|`、`^`、`&`、`<>`。
- **非 `.exe` 安裝**（npm 的 `.cmd` / `.ps1` shim）：實測 PowerShell 會選到 `claude.ps1`。這類安裝只走簡單路徑；值含空白、引號、結尾反斜線、`%`、`|`、`^` 時會印出手動指令。`&` 與 `<>` 可正常存入。
- 手動指令只在 Git Bash 驗證過。cmd 實測會失敗（單引號被保留、JSON 內的雙引號被吃掉），不要在 cmd 執行。
- restore 必須用 Windows PowerShell 5.1 執行（`powershell -File`）。pwsh 7 會重複跳脫傳給 `.ps1` shim 的 JSON 參數，腳本以 `#Requires -PSEdition Desktop` 在任何動作之前中止。
- **重跑 restore：** 外掛重跑是冪等的；已存在的 MCP 印 `SKIP` 並保留原值；有 `FAIL` 時結束碼仍為 0。
- **已實測：** 官方 marketplace 會自動提供外掛（`context7` 不需先加 marketplace）；不同家目錄與不同 repo 路徑都能正確展開。
- 沒裝 Orca 時出現的 SessionEnd hook 錯誤可以忽略。
- 本 repo 設計為原版 Claude 也能直接使用，不依賴第三方的修補版。`sync` 匯出時會移除 Calico 的更新 hook 與 `calico/` 的檔案，所以 `settings.json` 裡不會有它。
- fallback（找不到 claude 時改寫 `.claude.json`）已在 PS 5.1 用真實副本與合成案例測過：深度 5 的實際設定、大小寫不同的同名 key、20 位大整數、`1e-7`、`0.1`、空陣列、物件陣列、`null`、`true`、空字串 key。除 `mcpServers` 外，所有節點逐一比對一致。`ConvertTo-Json -Depth 50`，超過 50 層的資料沒有測過。
