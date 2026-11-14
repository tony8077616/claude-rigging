#!/usr/bin/env node
// PreToolUse hook (matchers: Bash, PowerShell). Blocks recursive/repo-wide text search in shell
// commands; allows filtering other commands' output and single-file reads. Fails open on bad input.
'use strict';
const fs = require('fs');
const path = require('path');

// shortcut: `$(` inside double quotes is not split; quoting nested deeper than one level is not unwrapped;
// -EncodedCommand, -File, iex, awk/sed/python -c/node -e are not parsed; ag/ack reuse rg's flag list (approximate);
// PowerShell abbreviated params (-Pat) are not expanded; bash `ls -r` (reverse sort) is treated as recursive;
// the group rule false-denies `if (gci -r) { sls foo a.txt }`; `find "text" *.js` (find.exe) is not a search;
// ctx_execute is not covered by this hook.
const SEARCH = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'findstr', 'select-string', 'sls']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd']);
// rg flags that consume the next token as their value
const RG_VAL = /^(-[ABCEMTdefgjmrt]|--(type|type-not|glob|iglob|regexp|file|max-count|context|after-context|before-context|max-depth|encoding|replace|threads|sort|sortr|max-columns|max-filesize|pre|pre-glob|ignore-file))$/;
const gitSub = (w) => { for (let i = 1; i < w.length; i++) { if (/^(-C|-c|--git-dir|--work-tree|--namespace|--config-env)$/.test(w[i])) i++; else if (!w[i].startsWith('-')) return w[i]; } };
const LISTERS = new Set(['gci', 'get-childitem', 'dir', 'ls']);

const name = (w) => (w || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
const stat = (p, cwd, test) => { try { return fs.statSync(path.resolve(cwd, p))[test](); } catch { return false; } };
const isDir = (p, cwd) => stat(p, cwd, 'isDirectory');
const isFile = (p, cwd) => stat(p, cwd, 'isFile');

// Split into segments on operators outside quotes; afterPipe marks stdin-fed segments, head is the pipeline's first.
function segments(cmd) {
  const segs = [];
  let words = [], w = '', has = false, q = null, after = false, head = null, grp = 0, depth = 0;
  const endWord = () => { if (has) words.push(w); w = ''; has = false; };
  const endSeg = (pipe) => {
    endWord();
    if (words.length) {
      const s = { words, afterPipe: after, head: after ? head : null, grp };
      if (!after) head = s;
      segs.push(s);
    }
    words = [];
    after = pipe;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], two = cmd.substr(i, 2);
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === '\\' && cmd[i + 1] === '"') { w += '"'; i++; }
      else w += c;
    } else if (c === "'" || c === '"') { q = c; has = true; }
    else if (two === '&&' || two === '||') { endSeg(false); if (!depth) grp++; i++; }
    else if (c === '|') endSeg(true);
    else if (c === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>') { endSeg(false); if (!depth) grp++; }
    else if (c === ';' || c === '\n') { endSeg(false); if (!depth) grp++; }
    else if (c === '(' || c === '{') { endSeg(false); depth++; }
    else if (c === ')' || c === '}') { endSeg(false); if (depth) depth--; }
    else if (c === '`') endSeg(false);
    else if (c === '$' && cmd[i + 1] === '(') continue; // the '(' ends the segment next turn
    else if (/\s/.test(c)) endWord();
    else { w += c; has = true; }
  }
  endSeg(false);
  return segs;
}

const isLister = (w) => name(w[0]) === 'find' || (LISTERS.has(name(w[0])) && w.some((x) => /^(-r|-recurse|\/s)$/i.test(x) || /^-[a-z]*R[a-z]*$/.test(x)));

function searchDeny(n, w, cwd) {
  const args = w.slice(1);
  if (n === 'findstr') {
    const ops = args.filter((a) => !/^[/-]/.test(a));
    const patInFlag = args.some((a) => /^\/[cg]:/i.test(a));
    return args.some((a) => /^\/s(:|$)/i.test(a)) || (patInFlag ? ops : ops.slice(1)).some((o) => /[*?]/.test(o));
  }
  const ops = args.filter((a) => !a.startsWith('-'));
  if (!ops.length && args.some((a) => /^(--version|-V|--help)$/.test(a))) return false;
  // rg/ag/ack recurse by default: allow only pattern + an existing file as last path, no directories
  if (n === 'rg' || n === 'ag' || n === 'ack') {
    const vals = new Set();
    args.forEach((a, i) => { if (RG_VAL.test(a)) vals.add(i + 1); });
    const o = args.filter((a, i) => !a.startsWith('-') && !vals.has(i));
    const paths = o.slice(args.some((a) => /^(-e|-f|--regexp|--file)$/.test(a)) ? 0 : 1);
    return !args.includes('-') && !(paths.length && isFile(paths[paths.length - 1], cwd) && !paths.some((p) => isDir(p, cwd)));
  }
  if (n === 'select-string' || n === 'sls') {
    if (args.some((a) => /^-recurse$/i.test(a))) return true;
    const paths = [];
    let pat = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-(path|literalpath)$/i.test(a)) paths.push(args[++i] || '');
      else if (/^-pattern$/i.test(a)) { pat = true; i++; }
      else if (/^-(include|exclude|encoding|context|culture)$/i.test(a)) i++;
      else if (a.startsWith('-')) continue;
      else if (!pat) pat = true;
      else paths.push(a);
    }
    return paths.some((p) => /[*?]/.test(p) || isDir(p, cwd));
  }
  return args.some((a) => /^-[^-]*[rR]/.test(a) || /^--(dereference-)?recursive$/.test(a)) || ops.slice(1).some((o) => isDir(o, cwd));
}

function decide(command, cwd = process.cwd()) {
  const segs = segments(command);
  // any search in a group that also lists recursively is denied, regardless of order
  const lgrp = new Set(segs.filter((s) => isLister(s.words)).map((s) => s.grp));
  for (const s of segs) {
    const w = s.words, n = name(w[0]);
    if (n === 'git' && gitSub(w) === 'grep') return 'deny';
    if (n === 'xargs' && w.slice(1).some((x) => SEARCH.has(name(x)))) return 'deny';
    if (n === 'find') {
      const i = w.findIndex((x) => /^-(exec|execdir|ok)$/.test(x));
      if (i >= 0 && SEARCH.has(name(w[i + 1]))) return 'deny';
    }
    if (SHELLS.has(n)) {
      const i = w.findIndex((x) => /^(-c|-command|\/c|\/k)$/i.test(x));
      if (i > 0 && w[i + 1] && decide(w.slice(i + 1).join(' '), cwd) === 'deny') return 'deny';
    }
    if (!SEARCH.has(n)) continue;
    if (lgrp.has(s.grp)) return 'deny';
    if (s.afterPipe) { if (s.head && isLister(s.head.words)) return 'deny'; continue; }
    if (searchDeny(n, w, cwd)) return 'deny';
  }
  return 'allow';
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    let p;
    try { p = JSON.parse(input); } catch { return; }
    const cmd = p && p.tool_input && p.tool_input.command;
    if (typeof cmd !== 'string' || decide(cmd, p.cwd || process.cwd()) === 'allow') return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          '已禁止 shell 遞迴/全 repo 文字搜尋（rg、grep -r、findstr /s、遞迴 Select-String 等），請改用 semble：',
          '1. 用 mcp__semble__search（先以 ToolSearch 載入 select:mcp__semble__search）依意圖或識別字搜尋。',
          '2. 找相似實作用 mcp__semble__find_related（file_path + line）。',
          '3. 需要某字串的全部出現次數時，用 Grep 並設定 output_mode="count"。',
          '4. 過濾其他指令的輸出（例如 git log | grep foo）或讀取單一檔案不受限。',
          '5. 遞迴列舉（find、gci -r、dir /s）後再搜尋也會被擋；只依檔名篩選請用 Glob。',
        ].join('\n'),
      },
    }));
  });
}

if (require.main === module) main();
module.exports = { decide };
