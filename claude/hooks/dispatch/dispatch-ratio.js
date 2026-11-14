#!/usr/bin/env node
// Subagent 派工比例閘 — PreToolUse（matcher: Agent）
// 預設 warn：只以 additionalContext 提示模型，不擋。DISPATCH_RATIO_MODE=deny 時，
// 缺 model / fable 會 deny；配額超出永遠只警告（設計如此，見計畫 §2）。
// 關閉：DISPATCH_RATIO=off
// 注意：Workflow 內的 agent() 不會觸發此 hook（已於 2026-10-16 實測確認），此閘只管直接 Agent 呼叫。
'use strict';

const fs = require('fs');
const { parseLines, evaluateAgentCall, summaryLine } = require('./dispatch-lib.js');

function main() {
  if (process.env.DISPATCH_RATIO === 'off') return;

  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
  if (input.tool_name !== 'Agent') return;

  let entries = [];
  try {
    entries = parseLines(fs.readFileSync(input.transcript_path, 'utf8'));
  } catch { /* 讀不到 transcript：以空紀錄判斷，配額檢查視為未達 */ }

  const mode = process.env.DISPATCH_RATIO_MODE === 'deny' ? 'deny' : 'warn';
  const result = evaluateAgentCall(input.tool_input, entries, mode);
  if (result.decision === 'allow') return;

  if (result.decision === 'deny') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[dispatch-ratio] ${result.reason}\n${summaryLine(entries)}`,
      },
    }));
    return;
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `[dispatch-ratio] ${result.reason}\n${summaryLine(entries)}`,
    },
  }));
}

main();
