#!/usr/bin/env node
// PreToolUse hook (matcher: Grep). Denies Grep except output_mode "count" and points to semble.
// To restore Grep, remove the "Grep" matcher entry from settings.json PreToolUse.
'use strict';

const reason = [
  '已禁用內建 Grep 工具，請改用 semble 搜尋：',
  '1. 先用 ToolSearch 載入 select:mcp__semble__search，再呼叫 mcp__semble__search。query 描述要找的程式碼意圖或識別字。',
  '   repo 傳子專案的絕對路徑（例如 <project-dir>），不要傳整個 <projects-root> 根目錄。',
  '2. 找到檔案與行號後直接讀取該位置，不要重複搜尋同一內容。',
  '3. 找相似實作可用 mcp__semble__find_related（file_path + line）。',
  '4. 文件或設定檔請在 search 時帶 content="docs" 或 "config"。',
  '5. 需要某字串的全部出現次數時，用 Grep 並設定 output_mode="count"。',
  '6. MCP 不可用時，CLI 備援：semble search "<query>" <子專案路徑>',
].join('\n');

// Missing output_mode defaults to files_with_matches (the grep+read path), so only strict "count" passes.
function decide(input) {
  try {
    return JSON.parse(input).tool_input.output_mode === 'count' ? 'allow' : 'deny';
  } catch {
    return 'deny';
  }
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    if (decide(input) === 'allow') return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  });
}

if (require.main === module) main();
module.exports = { decide };
