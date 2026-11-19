#!/usr/bin/env node
// Advisor loop — PreToolUse（Edit / Write / MultiEdit / NotebookEdit，以及會寫入的 Bash / PowerShell）
// 本輪尚未呼叫 advisor 時擋下寫入；本輪有 advisor 就放行。派出 Agent 不算（子代理自己的寫入由 isSubagent 豁免）。
// 例外：session 從未用過 advisor（工具不可用）時，本輪擋過一次後放行，避免空轉。
// Sonnet 本輪已用過 advisor、但連續執行失敗超過 3 次時，寫入也會被擋，直到再呼叫一次 advisor 為止（見 streakDeny）。
// 唯讀 shell 指令（見 shell.js）不擋。動作後是否回報，仍由 Stop hook 檢查。
// 關閉：ADVISOR_LOOP=off

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseLines, turnUsedAdvisor, sessionUsedAdvisor, sessionModel, failureStreak, sessionFile } = require('./stop.js');
const { isWriteShell } = require('./shell.js');

const STATE_DIR = path.join(os.tmpdir(), 'advisor-loop');
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// 實測（2026-10-21）：看得到 advisor 的情況都是第一次讀取就命中，延遲不是主要問題；成本在讀取與解析整份 transcript
// 同回應內剛呼叫的 advisor 紀錄若讀不到，解法是單獨一次唯讀工具往返，故不延長等待
const RETRIES = 4;
const WAIT_MS = 250;
const PRE_STREAK_REASON = [
  '[advisor-loop] 連續執行失敗超過 3 次，先呼叫 advisor 確認方向。',
  '之後單獨做一次唯讀工具（如 Read），再重送寫入。',
].join('\n');
const REASON = [
  '[advisor-loop] 本輪尚未呼叫 advisor，先暫停寫入。',
  '寫入前二擇一：① 先呼叫 advisor 確認方向（必要的定位與讀取可以先做）；② 把寫入交給 haiku 子代理（Agent）做，主 session 不自己寫。',
  '本則回應剛呼叫過 advisor：先單獨做一次唯讀工具（如 Read），等結果回來後再重送同一筆寫入。',
  '寫完後依 advisor 規則回報，直到修正完畢。',
].join('\n');

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    // 寫不進狀態檔：本次仍依判斷結果處理
  }
}

// 子代理的呼叫不受本輪 advisor 規則約束：子代理沒有 advisor 可呼叫，判斷欄位與 ECC GateGuard 相同
function isSubagent(input) {
  return [input.agent_id, input.agentId, input.parent_tool_use_id, input.parentToolUseId]
    .some((v) => typeof v === 'string' && v.trim());
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 回傳 true 表示應該擋下
function shouldDeny(transcriptPath, file) {
  let entries = [];
  for (let i = 0; i < RETRIES; i++) {
    try { entries = parseLines(fs.readFileSync(transcriptPath, 'utf8')); } catch { return false; }
    if (turnUsedAdvisor(entries)) return false;
    if (i < RETRIES - 1) sleep(WAIT_MS);
  }
  // session 從未用過 advisor 且本輪已擋過一次：工具可能不可用，放行避免空轉
  if (readState(file).preDenies && !sessionUsedAdvisor(entries)) return false;
  return true;
}

// Sonnet 本輪已用過 advisor 但連續執行失敗超過 3 次：寫入也要擋。成功的 Read/Edit 不會解除，只有再呼叫一次 advisor 才能解除
function streakDeny(transcriptPath) {
  try {
    const entries = parseLines(fs.readFileSync(transcriptPath, 'utf8'));
    return sessionModel(entries) === 'sonnet' && turnUsedAdvisor(entries) && failureStreak(entries) > 3;
  } catch { return false; }
}

function main() {
  if (process.env.ADVISOR_LOOP === 'off') return;

  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const isWrite = WRITE_TOOLS.has(input.tool_name)
    || (SHELL_TOOLS.has(input.tool_name) && isWriteShell(input.tool_input?.command, input.tool_name, { mode: 'pretool' }));
  if (!isWrite) return;
  if (isSubagent(input)) return;

  if (streakDeny(input.transcript_path)) {
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PRE_STREAK_REASON },
    }));
    return;
  }

  const file = sessionFile(input.session_id);
  if (!shouldDeny(input.transcript_path, file)) return;

  writeState(file, { ...readState(file), preDenies: 1 });
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASON,
    },
  }));
}

if (require.main === module) main();

module.exports = { shouldDeny };
