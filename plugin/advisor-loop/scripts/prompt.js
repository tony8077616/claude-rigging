#!/usr/bin/env node
// Advisor loop — UserPromptSubmit
// 每輪使用者輸入：重設本輪的 stop 計數，並注入「先問 advisor、執行中回報、需判斷才停」的指示。
// Ultracode：settings.json 的 "ultracode": true、使用者 prompt 含 ultracode 字樣、或 ADVISOR_ULTRACODE=on 時，
//   另外注入 <ultracode-mode>（第一次 advisor 之後改用 Workflow 分發）。ADVISOR_ULTRACODE=off 一律關閉。
// 關閉：環境變數 ADVISOR_LOOP=off

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.tmpdir(), 'advisor-loop');

const CONTEXT = [
  '<advisor-loop>',
  '1. 唯讀（讀檔、搜尋、唯讀 shell 指令）不必先問 advisor，可以直接做。',
  '2. 任何寫入（含會改檔的 shell 指令）動手前，先呼叫 advisor 確認方向，或改派給 haiku 子代理（Agent）執行；唯讀的搜尋或統計可交給 Explore、semble-search 或 claude-code-guide 子代理（可加 model: haiku），派出後收尾不必再回報，其他子代理仍算動作。呼叫 advisor 後若要寫入，先單獨送出一次唯讀工具（如 Read），等結果回來再寫入；不要把唯讀工具和寫入放在同一批。',
  '3. 寫入後到修正完畢為止，每次修正都要向 advisor 備查（呼叫 advisor 回報進度與可改善之處）；修正完畢後才能結束。主 session 為 Sonnet 時，連續執行失敗超過 3 次（測試、建置等會寫入的指令；gate 拒絕不算）要先呼叫 advisor 再繼續。',
  '4. 最後一次 advisor 之後只用文字結束；唯一例外是需要使用者選擇時，改用 AskUserQuestion 工具：每個問題 2–4 個選項，description 寫一句用途備註，建議的選項放第一個並在 label 結尾加「（建議）」，header 不超過 12 字。工具會自動提供「Other」自訂回覆，不要自己加「其他」選項。呼叫前先寫一行 "needs input:" 摘要問題。完成時以 "result:" 開頭回報。不需要選擇的問題，或 AskUserQuestion 不可用、被拒時，才用 "needs input:" 加文字選單。"needs input:"／"result:" 必須是該行開頭的純文字，不加粗、不加清單符號。',
  '5. 執行 advisor 建議時，可用動態工作流（Workflow）或子代理平行處理，以求最佳化結果；需要為重複或複雜任務設計臨時 harness 時，可載入 ecc:dynamic-workflow-mode。',
  '</advisor-loop>',
].join('\n');

const ULTRACODE_CONTEXT = [
  '<ultracode-mode>',
  '1. 第一次呼叫 advisor 之後，任務分發改用 Workflow：把可平行的子任務寫成 workflow 腳本，每個 agent() 明確指定 model（haiku／sonnet／opus），依 dispatch-state 的分級。',
  '2. 寫入仍只由主 session 執行，或交給檔案互不重疊的 agent；寫入前照第 2 條先呼叫 advisor 並單獨讀取。沒有 git worktree 隔離時，不要讓兩個 agent 平行寫同一批檔案。',
  '3. 使用者已開啟 Ultracode 並授權子代理啟動動態工作流（Workflow），但只限一層：子代理啟動的 workflow 裡不能再啟動 Workflow。每個 agent() 明確指定 model；若子代理的工具清單沒有 Workflow，改用 Agent 或直接處理。',
  '4. 子代理的 prompt 要明寫：徹底完成、自我驗證，結論附證據（檔案:行號或指令輸出）。',
  '5. 純對話、回答問題或瑣碎的機械性修改（例如改一個字串）不必用 Workflow，直接做即可。',
  '</ultracode-mode>',
].join('\n');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function sessionFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(STATE_DIR, `${safe}.json`);
}

// 使用者的 settings.json 是否設定了 "ultracode": true；讀不到或格式錯誤一律視為 false
function settingsUltracode() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).ultracode === true;
  } catch {
    return false;
  }
}

// 每輪即時判斷，不寫入狀態檔（prompt.js 每輪會覆寫整個狀態檔）
function ultracodeOn(input) {
  const flag = (process.env.ADVISOR_ULTRACODE || '').toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  const text = String(input.prompt ?? input.message ?? '');
  if (/ultracode/i.test(text)) return true;
  return settingsUltracode();
}

function main() {
  if (process.env.ADVISOR_LOOP === 'off') return;

  const input = readStdin();
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(sessionFile(input.session_id), JSON.stringify({ blocks: 0, preDenies: 0 }));
  } catch {
    // 狀態檔寫失敗就放棄計數，不影響注入
  }

  const context = ultracodeOn(input) ? `${CONTEXT}\n${ULTRACODE_CONTEXT}` : CONTEXT;
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
}

if (require.main === module) main();

module.exports = { ultracodeOn, CONTEXT, ULTRACODE_CONTEXT };
