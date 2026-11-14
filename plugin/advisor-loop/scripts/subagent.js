#!/usr/bin/env node
// Advisor loop — SubagentStart
// Ultracode 開啟時，子代理啟動就注入一段完成標準；未開啟時不輸出任何東西。
// 判斷與 prompt.js 共用同一套規則（settings.json 的 ultracode、ADVISOR_ULTRACODE）。
// 關閉：環境變數 ADVISOR_ULTRACODE=off

'use strict';

const fs = require('fs');
const { ultracodeOn } = require('./prompt.js');

const SUBAGENT_CONTEXT = [
  '<ultracode-subagent>',
  '徹底完成，完成前自我驗證；結論附證據（檔案:行號或指令輸出）。',
  '使用者已開啟 Ultracode，並允許子代理啟動動態工作流（Workflow），只限一層；每個 agent() 明確指定 model。',
  '</ultracode-subagent>',
].join('\n');

function main() {
  try { fs.readFileSync(0, 'utf8'); } catch {
    // 讀不到 stdin 不影響判斷，子代理的 schema 不依賴任何欄位
  }
  if (!ultracodeOn({})) return;
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: SUBAGENT_CONTEXT },
  }));
}

main();
