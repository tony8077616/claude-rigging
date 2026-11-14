---
description: 後端多模型流程（agy 版）。取代 ecc:multi-backend 的 Codex 後端，各階段可指定 agy 模型。
---

# Backend (agy) - 後端導向開發

流程：Research → Ideation → Plan → Execute → Optimize → Review。外部模型一律走 agy（Antigravity），不使用 Codex。

任務：$ARGUMENTS

## 角色與模型

外部模型沒有任何寫檔權限，所有程式修改由 Claude 執行。

| 階段 | 角色檔（`~/.claude/prompts/agy/`） | 預設模型（可在此表調整） |
|------|------|------|
| Ideation | `analyzer.md` | `gemini-4-argon-high` |
| Planning | `architect.md` | `gemini-4-argon-high` |
| Optimize（審查） | `reviewer.md` | `gemini-3.8-flash-high` |

模型可用清單來自 `agy models`。依 cross-ai 規劃，agy 內的 `claude-*` 模型只作為手動備用，不進自動化流程；本表預設只用 Gemini 模型。

## 呼叫方式

`--mode plan` 與 `--model` 必須放在 `-p` 前面，且 prompt 以參數傳入。`--mode plan` 必填：agy 1.5.7 起 headless 預設為 Auto，會直接寫檔。單次 prompt 必須小於約 25KB（Windows 命令列上限約 32K），超過就分批。

```bash
mkdir -p "${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp" && agy --mode plan --model <MODEL> -p "$(cat "${CLAUDE_JOB_DIR:-$HOME/.claude}/tmp/prompt-<phase>.txt")"
```

prompt 檔內容：

```
ROLE: <角色檔內容>
DO NOT use any tools. Output text only.
<TASK>
Requirement: <需求>
Context: <前一階段的結果或 git diff>
</TASK>
OUTPUT: <期望格式>
```

## 流程

0. **分類與預檢**：先做互動形態分類（需求不明 → AskUserQuestion，不派工；方向廣 → 完整流程；明確且小 → 告知使用者，建議跳過多模型規劃）。再做預檢（唯讀）：`agy --version` 可執行、`agy --help` 含 `--mode`、`agy models` 列出降級鏈中的每個 ID；任一失敗就停止並回報。
1. **Research**：用 `mcp__semble__search` 找現有 API、資料模型與服務結構，再用 Glob 找檔案、Read 讀取；不要用 Grep 找內容。需求完整度低於 7 分時停止並向使用者補充。
2. **Ideation**：以 `analyzer.md` 呼叫 agy，產出至少兩個方案與風險。等使用者選擇。
3. **Plan**：以 `architect.md` 呼叫 agy，產出檔案結構、函式設計與依賴關係。Claude 整理成計畫，經使用者核准後存到 `.claude/plan/<task>.md`。
4. **Execute**：Claude 依核准的計畫修改程式，遵守專案既有風格，並處理錯誤、安全與效能。
5. **Optimize**：以 `reviewer.md` 審查 `git diff`（非 git 專案改送完整檔案內容），重點是安全、效能、錯誤處理與 API 相容性。Claude 整理意見，經使用者確認後才修改。
6. **Review**：對照計畫檢查完成度，執行測試，回報問題與建議。

## 規則

1. agy 的後端意見可作為依據，但 Claude 要自行判斷。
2. 外部模型沒有寫檔權限，所有寫檔由 Claude 執行。
3. 每個階段開頭標示 `[Mode: X]`，依序進行，不跳階段。
4. 需要使用者決定時使用 AskUserQuestion。
5. 每次呼叫 agy 都要帶 `--mode plan`，沒有例外。stdout 含 `antigravity-cli/brain/` 或 `implementation plan artifact`，且缺少該階段預期的內容（方案、計畫或審查意見）時，視為失敗：artifact 失敗立即重試一次；暫時性失敗（非零 exit、空輸出、429/503）用背景 `sleep` 退避 30 秒、90 秒後重試。仍失敗就從該階段的預設模型起，依降級鏈 `gemini-4-argon-high` → `gemini-4-hydrogen-high` → `gemini-3.8-flash-high` 換下一個還沒試過的模型（Ideation、Planning 預設為 argon，Optimize 預設為 flash）；全部失敗就告知使用者並停在該階段。
6. 流程結束後刪除本次寫入的 prompt 檔，逐一列出檔名，不用 glob。

## 已驗證的事實

- `agy --mode plan --model <M> -p "..."` 可用（`--mode plan` 與 `--model` 必須放在 `-p` 前）。2026-11-14 實測：不加 `--mode plan` 時 headless 會直接寫檔；加上後可擋寫入，stdout 仍是分析文字與 diff。
- 本指令直接呼叫 agy CLI，不經過 wrapper（`codeagent-wrapper` 已移除）。
- `agy -p` 本身不讀 stdin，直接用管道餵入會顯示說明並失敗。
- 先前的 exit 1 與 503 是 agy 服務暫時無法使用，不是本地設定問題。
