#!/usr/bin/env node
'use strict';
const fs = require('fs');

// Scan from the '(' at index open to its matching ')', skipping string literals.
function callBody(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

function main() {
  if (process.env.DISPATCH_WORKFLOW === 'off') return;
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (!input || input.tool_name !== 'Workflow') return;

  const ti = input.tool_input || {};
  let src = '';
  if (typeof ti.script === 'string') src = ti.script;
  else if (typeof ti.scriptPath === 'string') {
    try {
      src = fs.readFileSync(ti.scriptPath, 'utf8');
    } catch {
      return;
    }
  }
  if (!src) return;

  const calls = [];
  const re = /(^|[^\w.$])agent\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const line = src.slice(0, m.index).split('\n').length;
    calls.push({ line, body: callBody(src, open) });
  }

  const missing = calls.filter((c) => !/\bmodel\s*:/.test(c.body));
  if (!missing.length) return;

  const reason = `[dispatch-workflow] ${missing.length}/${calls.length} agent() call(s) lack model: at line(s) ${missing.map((c) => c.line).join(', ')}. Set model: 'haiku' | 'sonnet' | 'opus' on every agent() call.`;
  const out = process.env.DISPATCH_WORKFLOW_MODE === 'deny'
    ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }
    : { hookEventName: 'PreToolUse', additionalContext: reason };
  console.log(JSON.stringify({ hookSpecificOutput: out }));
}

main();
