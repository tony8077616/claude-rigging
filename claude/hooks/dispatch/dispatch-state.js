#!/usr/bin/env node
// 派工配額狀態 — UserPromptSubmit（獨立於 workflow-state.js）
// 獨立於 CCG workflow-state.js（已移除），自行讀取 transcript。
// 關閉：DISPATCH_RATIO=off
'use strict';

const fs = require('fs');
const { parseLines, summaryLine } = require('./dispatch-lib.js');

function main() {
  if (process.env.DISPATCH_RATIO === 'off') return;

  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }

  let entries = [];
  try {
    entries = parseLines(fs.readFileSync(input.transcript_path, 'utf8'));
  } catch { /* 新 session 尚無 transcript：顯示零計數 */ }

  const context = [
    '<dispatch-state>',
    summaryLine(entries),
    '分級：haiku＝搜尋/摘要/測試回報；sonnet＝範圍明確的實作與測試；opus＝架構/安全/驗收。',
    '</dispatch-state>',
  ].join('\n');

  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
}

main();
