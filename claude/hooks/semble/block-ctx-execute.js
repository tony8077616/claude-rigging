#!/usr/bin/env node
// PreToolUse hook (matchers: context-mode ctx_execute, ctx_batch). Runs the same decide() as
// block-shell-search.js on shell commands that go through context-mode instead of Bash.
// ctx_batch always runs shell commands. ctx_execute is checked only when language is a shell.
// Code in other languages (javascript, python, ...) is not parsed. Fails open on bad input.
'use strict';
const { decide } = require('./block-shell-search.js');

const SHELL_LANGS = new Set(['shell', 'bash', 'sh', 'zsh', 'powershell', 'pwsh']);

function commandsOf(input) {
  const ti = (input && input.tool_input) || {};
  if (/ctx_batch$/.test(input.tool_name || '')) {
    return Array.isArray(ti.commands) ? ti.commands.filter((c) => typeof c === 'string') : [];
  }
  const lang = typeof ti.language === 'string' ? ti.language.toLowerCase() : '';
  return SHELL_LANGS.has(lang) && typeof ti.code === 'string' ? [ti.code] : [];
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    let p;
    try { p = JSON.parse(input); } catch { return; }
    const cwd = p.cwd || process.cwd();
    if (!commandsOf(p).some((c) => decide(c, cwd) === 'deny')) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          '已禁止 context-mode shell 指令中的遞迴/全 repo 文字搜尋（rg、grep -r、findstr /s、遞迴 Select-String 等），請改用 semble：',
          '1. 用 mcp__semble__search（先以 ToolSearch 載入 select:mcp__semble__search）依意圖或識別字搜尋。',
          '2. 找相似實作用 mcp__semble__find_related（file_path + line）。',
          '3. 需要某字串的全部出現次數時，用 Grep 並設定 output_mode="count"。',
        ].join('\n'),
      },
    }));
  });
}

if (require.main === module) main();
module.exports = { commandsOf };
