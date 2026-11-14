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
- 去識別化是**單向**的：從 repo 還原後，名單中的原文不會回來，settings 的 environment 區塊與 `block-grep.js` 的範例路徑會是通用版本。在本機執行 restore 時，live 的 environment 區塊也會被換成通用版本，自動模式的前提會跟著改變。
- 若 live 的 `claude/` 或 MCP 設定本身含 token 字串，sync 會中止（無法安全 token 化）。

## 結構

- `claude/`：`~/.claude` 白名單的鏡像。
- `plugin/advisor-loop/`：Advisor 強制迴圈與 ultracode 注入的 plugin。
- `install/`：`restore.ps1`、`mcp-servers.json`、`plugins-to-install.txt`。
- `tools/`：`sync.ps1` 與白名單 `manifest.txt`。
- `.claude-plugin/marketplace.json`：讓本 repo 可被 `claude plugin marketplace add` 加入。

## 刻意不收

`.credentials.json`、`projects/`、`sessions/`、`security/`、`tmp/`、`state/`、外掛快取、memory（含基礎設施細節，先不收）、`~/.claude.json` 其他欄位（只取 `mcpServers`）、各工具安裝的 `skills/*`、舊副本 `hooks/advisor-loop`。

## 已知限制

- MCP 參數含空白時 `claude mcp add-json` 會失敗，restore 會印出可手動執行的指令。目前三筆 MCP 都沒有空白。
- 路徑已 token 化，不同家目錄的還原尚未實測。
- `anthropic-plugin-directory` 的外掛假設由官方 marketplace 自動提供，未實測。
- 已安裝 advisor-loop 的機器上還原時，外掛安裝步驟的結果未實測；建議加 `-SkipPlugins`。
