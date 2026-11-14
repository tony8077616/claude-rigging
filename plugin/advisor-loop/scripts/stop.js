#!/usr/bin/env node
// Advisor loop — Stop
// 模型想結束時檢查：最後一次動作之後是否已回報 advisor。
// 動作 = Edit / Write / MultiEdit / NotebookEdit / Workflow / Agent，以及會寫入的 Bash / PowerShell（見 shell.js）。
// 例外：Agent 的 subagent_type 為 Explore、semble-search 或 claude-code-guide 時不算動作（唯讀子代理）。
// 未回報就擋下（decision: block），reason 會被當成下一則指令餵回模型。
// 放行條件：needs input / failed、純對話（無工具）、只讀取無動作、已回報、超過上限。
// 上限：主 session 為 Haiku 時不設上限；其餘（含偵測不到模型）為 ADVISOR_LOOP_MAX（預設 5）。
// Sonnet：本輪連續執行失敗（會寫入的 shell）超過 3 次，即使沒有寫入也要求先呼叫 advisor（見 failureStreak）。
// 關閉：ADVISOR_LOOP=off

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isWriteShell } = require('./shell.js');

const STATE_DIR = path.join(os.tmpdir(), 'advisor-loop');
const MARKER = '[advisor-loop]';
const ACTION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Workflow', 'Agent']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const ADVISOR_TOOL = 'advisor';
const ASK_TOOL = 'AskUserQuestion';
// 唯讀型子代理：派出後不算動作（使用者於 2026-10-21 同意的名單，不要擅自擴充）
const READ_AGENTS = new Set(['Explore', 'semble-search', 'claude-code-guide']);
const REASON = [
  `${MARKER} 最後一次動作之後尚未回報 advisor。`,
  '修正完畢前，每次寫入後都要向 advisor 備查（呼叫 advisor 回報進度），直到修正完畢為止。',
  '最後一次 advisor 之後只用文字結束。要問使用者的問題，等本批完成後一起用 "needs input:" 開頭提出；需要使用者選擇時改用 AskUserQuestion 工具詢問。',
  '若 advisor 建議再寫入，先單獨做一次唯讀工具再寫，寫完再呼叫一次 advisor。',
].join('\n');

// 把一則 transcript 訊息的 content 正規化成 blocks 陣列
function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

// 只認頂層 type 為 user / assistant 的紀錄；api-request-blob 等會重複內容，必須忽略
function roleOf(entry) {
  return entry.type === 'user' || entry.type === 'assistant' ? entry.type : null;
}

// 真正的使用者輸入：有文字、非 isMeta（skill 載入等）、沒有 tool_result，且不是本 hook 餵回的 reason
function isUserPrompt(entry) {
  if (roleOf(entry) !== 'user' || entry.isMeta) return false;
  const blocks = blocksOf(entry.message?.content ?? entry.content);
  if (blocks.some((b) => b.type === 'tool_result')) return false;
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return !text.includes(MARKER);
}

// 回傳「本輪」(最後一則真正使用者輸入之後) 的 assistant 訊息
function currentTurn(entries) {
  let start = 0;
  entries.forEach((e, i) => { if (isUserPrompt(e)) start = i + 1; });
  return entries.slice(start).filter((e) => roleOf(e) === 'assistant');
}

// advisor 是伺服器端工具，紀錄型別為 server_tool_use（name: "advisor"）
function isAdvisorBlock(b) {
  return (b.type === 'tool_use' || b.type === 'server_tool_use') && b.name === ADVISOR_TOOL;
}

// 本輪是否已呼叫過 advisor（供 PreToolUse 使用）
function turnUsedAdvisor(entries) {
  return currentTurn(entries).some((e) => blocksOf(e.message?.content ?? e.content).some(isAdvisorBlock));
}

// 整個 session 是否曾經呼叫過 advisor
function sessionUsedAdvisor(entries) {
  return entries.some((e) => blocksOf(e.message?.content ?? e.content).some(isAdvisorBlock));
}

// 主 session 的模型家族：取最後一筆真實模型的 assistant 紀錄（略過 <synthetic>）
function sessionModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (roleOf(e) !== 'assistant') continue;
    const m = String(e.message?.model || '').toLowerCase();
    if (!m || m === '<synthetic>') continue;
    if (m.includes('haiku')) return 'haiku';
    if (m.includes('sonnet')) return 'sonnet';
    if (m.includes('opus')) return 'opus';
    return 'unknown';
  }
  return 'unknown';
}

// gate 拒絕（advisor-loop / delegation-gate / GateGuard / 自動模式）不算真正的失敗
const GATE_RE = /\[advisor-loop\]|\[delegation-gate\]|Fact-Forcing Gate|Permission for this action was denied|hook error:/i;
const STREAK_REASON = [
  `${MARKER} 連續失敗超過 3 次（gate 拒絕不計）。`,
  '請先呼叫 advisor 確認方向，再繼續嘗試。',
  '若 advisor 建議再寫入，先單獨做一次唯讀工具再寫，寫完再呼叫一次 advisor。',
].join('\n');

function toolResultText(b) {
  return typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
}

// 本輪連續「執行」失敗次數（只計會寫入的 Bash/PowerShell，例如測試、建置）：從最後一則使用者輸入往回算。
// 以 tool_use_id 對回原本的 tool_use；遇到 advisor 即停；寫入型執行成功即中斷；其他工具與 gate 拒絕跳過。
function failureStreak(entries) {
  const uses = new Map();
  for (const e of entries) {
    for (const b of blocksOf(e.message?.content ?? e.content)) {
      if (b.type === 'tool_use' && b.id) uses.set(b.id, { name: b.name, command: b.input?.command });
    }
  }
  let start = 0;
  entries.forEach((e, i) => { if (isUserPrompt(e)) start = i + 1; });
  let streak = 0;
  for (let i = entries.length - 1; i >= start; i--) {
    const blocks = blocksOf(entries[i].message?.content ?? entries[i].content);
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (isAdvisorBlock(b)) return streak;
      if (b.type !== 'tool_result') continue;
      const use = uses.get(b.tool_use_id);
      if (!use || !SHELL_TOOLS.has(use.name) || !isWriteShell(use.command, use.name)) continue;
      if (GATE_RE.test(toolResultText(b))) continue;
      if (b.is_error === true) streak++;
      else return streak;
    }
  }
  return streak;
}

function parseLines(raw) {
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// 核心判斷：回傳 { block: boolean, why: string, reason?: string }
function decide(entries, blocks, maxBlocks, model = 'unknown') {
  if (blocks >= maxBlocks) return { block: false, why: 'max-blocks' };

  // 整個 session 從未用過 advisor（工具不可用）：擋一次就好，不要空轉到上限
  if (blocks >= 1 && !sessionUsedAdvisor(entries)) return { block: false, why: 'advisor-absent' };

  let lastText = '';
  const tools = [];
  for (const entry of currentTurn(entries)) {
    for (const b of blocksOf(entry.message?.content ?? entry.content)) {
      if (b.type === 'text' && b.text) lastText = b.text;
      if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        tools.push({ name: b.name, command: b.input?.command, subagentType: b.input?.subagent_type });
      }
    }
  }

  if (/^\s*needs input:/im.test(lastText)) return { block: false, why: 'needs-input' };
  if (/^\s*failed:/im.test(lastText)) return { block: false, why: 'failed' };
  // Sonnet：連續失敗超過 3 次，要求先呼叫 advisor（最後一個工具是 AskUserQuestion 時不擋）
  const lastToolName = currentTurn(entries).flatMap((e) => blocksOf(e.message?.content ?? e.content))
    .filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use').pop()?.name;
  if (model === 'sonnet' && failureStreak(entries) > 3 && lastToolName !== ASK_TOOL) {
    return { block: true, why: 'failure-streak', reason: STREAK_REASON };
  }
  if (tools.length === 0) return { block: false, why: 'no-tools' };
  if (tools[tools.length - 1].name === ASK_TOOL) return { block: false, why: 'asked-user' };

  const isAction = (t) => (ACTION_TOOLS.has(t.name) && !(t.name === 'Agent' && READ_AGENTS.has(t.subagentType)))
    || (SHELL_TOOLS.has(t.name) && isWriteShell(t.command, t.name));
  let lastAction = -1;
  let lastAdvisor = -1;
  tools.forEach((t, i) => {
    if (isAction(t)) lastAction = i;
    if (t.name === ADVISOR_TOOL) lastAdvisor = i;
  });
  if (lastAction === -1) return { block: false, why: 'read-only' };
  if (lastAdvisor > lastAction) return { block: false, why: 'reported' };
  return { block: true, why: 'unreported', reason: REASON };
}

function sessionFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(STATE_DIR, `${safe}.json`);
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function readBlocks(file) {
  return readState(file).blocks || 0;
}

// 最後一則有文字的 assistant 紀錄內容
function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (roleOf(e) !== 'assistant') continue;
    const texts = blocksOf(e.message?.content ?? e.content).filter((b) => b.type === 'text').map((b) => b.text || '');
    if (texts.length) return texts.join('\n');
  }
  return '';
}

// Stop 觸發時 transcript 可能還沒寫入最後的 assistant 紀錄（時序問題）。
// 以 stdin 的 last_assistant_message 為準：對不上就短暫等待後重讀，最多約 2 秒。
function readSettled(transcriptPath, expected) {
  const exp = typeof expected === 'string' ? expected.trim() : '';
  const TAIL = 30;
  const MAX_TRIES = 8;
  let entries = null;
  for (let tries = 1; tries <= MAX_TRIES; tries++) {
    try {
      entries = parseLines(fs.readFileSync(transcriptPath, 'utf8'));
    } catch {
      return { entries: null };
    }
    if (!exp) return { entries, settled: null, tries };
    // 比結尾：最後一段文字的末尾，必須是 last_assistant_message 的結尾（不論它是整則合併或只有最後一段）
    const lastText = lastAssistantText(entries).trim();
    if (lastText && exp.endsWith(lastText.slice(-TAIL))) return { entries, settled: true, tries };
    if (tries < MAX_TRIES) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return { entries, settled: false, tries: MAX_TRIES };
}

function main() {
  if (process.env.ADVISOR_LOOP === 'off') return;

  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }

  const { entries } = readSettled(input.transcript_path, input.last_assistant_message);
  if (!entries) return;

  const model = sessionModel(entries);
  const maxBlocks = model === 'haiku' ? Infinity : (Number(process.env.ADVISOR_LOOP_MAX) || 5);

  const file = sessionFile(input.session_id);
  const blocks = readBlocks(file);
  const result = decide(entries, blocks, maxBlocks, model);
  if (!result.block) return;

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...readState(file), blocks: blocks + 1 }));
  } catch {
    // 寫不進狀態檔：仍擋下本次，計數無法累加時上限失效，故以 ADVISOR_LOOP=off 作為後備關閉
  }
  console.log(JSON.stringify({ decision: 'block', reason: result.reason }));
}

if (require.main === module) main();

module.exports = { decide, isUserPrompt, currentTurn, turnUsedAdvisor, sessionUsedAdvisor, sessionModel, failureStreak, STREAK_REASON, parseLines, readSettled, sessionFile, MARKER };
