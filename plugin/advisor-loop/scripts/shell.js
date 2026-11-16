#!/usr/bin/env node
// 判斷 shell 指令（Bash / PowerShell）是否會寫入。預設視為寫入：只有每一段都是已知唯讀指令才放行。
// 供 pretool.js（是否要先問 advisor）與 stop.js（是否算動作、需要回報）共用。

'use strict';

// 命中任一即視為寫入：重導輸出（2>&1 除外）、呼叫運算子 &、寫入型 cmdlet/指令、git 寫入子命令、.NET 寫入方法
const WRITE_HINT = new RegExp([
  '>(?!&)(?!\\s*(?:\\/dev\\/null|NUL|\\$null)(?![\\w.\\-]))',
  // >&word 會把 stdout/stderr 寫到檔案；2>&1、>&- 是 fd 操作，不算寫檔
  '>&(?![\\d-])',
  '(?<![&>|<])&(?![&>])',
  '\\b(Remove-Item|Set-Content|Add-Content|Clear-Content|Set-ItemProperty|Set-Item|New-Item|Copy-Item|Move-Item|Rename-Item|Out-File|Export-\\w+|Tee-Object|Start-Process|Stop-Process|Invoke-\\w+|Expand-Archive|Compress-Archive)\\b',
  '\\b(rm|mv|cp|del|rmdir|mkdir|tee|sed|touch|chmod|npm|npx|bun|pip|node|python|dotnet|make|iex)\\b',
  '\\bgit\\s+(add|commit|push|reset|checkout|clean|stash|merge|rebase|apply|restore|tag|pull|fetch|cherry-pick|revert|rm|mv|switch|branch)\\b',
  // git diff/log 的寫檔旗標（--output 寫檔、--ext-diff 執行外部程式）；--no-ext-diff 不是
  '\\bgit\\b[^;|&]*\\s--(output(=|\\s|$)|ext\\w*)',
  // file -C／--compile 會寫出編譯檔；錨定在指令開頭，避免 grep -C 3 x file 誤判
  '(^|[;&|\\n(]\\s*)file\\s(?:[^;|&]*\\s)?-(?:C|-compile)(?=\\s|$)',
  // rg --pre 會執行外部預處理程式；--pre-glob 不是
  '\\brg\\b[^;|&]*\\s--pre(\\s|=|$)',
  '\\.(Delete|MoveTo|CopyTo|Create\\w*|Save|Write\\w*|Append\\w*|Kill|SetValue|Stop|Start|Restart|Terminate)\\(',
  '\\s-(delete|exec|execdir|ok|okdir|fls|fprint\\w*)\\b',
  '::(Write|Append|Delete|Move|Copy|Create|Start|Open)\\w*',
  '(?<!\\[Math\\])::(?:\\w+\\s*[=(.]|[\\x27\\x22\\x60$(\\s])',
].join('|'), 'i');

// 會改變狀態的 cmdlet 動詞；只在 PowerShell 比對（Bash 參數中的 add、update 等字不算）
const PS_WRITE_HINT = /\b(?!(?:Set-Location|Start-Sleep|Clear-Host|Format-(?:Table|List|Wide|Custom|Hex))(?![\w-]))(?:Stop|Restart|Suspend|Resume|Disable|Enable|Register|Unregister|Install|Uninstall|Format|Initialize|Clear|Reset|Grant|Revoke|Block|Unblock|Lock|Unlock|Add|Update|Publish|Unpublish|Save|Remove|New|Set|Start|Rename|Move|Copy|Restore|Repair|Resize|Mount|Dismount|Checkpoint|Backup|Sync|Optimize|Send|Undo|Complete)-\w+/i;

// 已知唯讀的指令開頭（每一段都要符合才算唯讀）；指令名稱後面可接空白、右括號或字串結尾
const READ_CMD = /^(ls|dir|cat|head|tail|pwd|echo|cd|Set-Location|Get-ChildItem|Get-Content|Get-Item|Get-Date|Test-Path|Select-String|Select-Object|Where-Object|ForEach-Object|Measure-Object|Sort-Object|Group-Object|Format-(Table|List|Wide|Custom|Hex)|Write-Output|Resolve-Path|grep|rg|wc|which|stat|file|find|git\s+(status|diff|log|show|rev-parse|ls-files))([\s)]|$)/i;
// 允許的唯讀運算式，逐 token 比對：$var 與屬性、僅限 IndexOf / Substring / [Math]::Max / [Math]::Min 三種呼叫、數字與運算子
// 其他方法呼叫（例如 $x.Remove()）因為 (?![\w(]) 而配不上，會被判成寫入
const READ_EXPR = /^(?:\$\w+(?:\.\w+(?![\w(]))*|\.(?:IndexOf|Substring)\(|\[Math\]::(?:Max|Min)\(|""|\d+|[\s+\-*\/(),{}])+$/i;

const SEGMENT_SPLIT = /\s*(?:;|\|\||&&|\||\r?\n)\s*/;

function isReadSegment(segment, tool) {
  // Bash 只看命令位置：去掉開頭的 ( 與 {；$ 開頭（變數、賦值、$cmd $arg）與引號指令名一律寫入，其餘只認 READ_CMD
  if (tool === 'Bash') {
    const head = segment.trim().replace(/^[({]+\s*/, '');
    return head === '' || head === '}' || head === ')' || (!head.startsWith('$') && READ_CMD.test(head));
  }
  // 去掉前置賦值（$f = ...）、字串接續（"" + (...)）與開頭的左括號
  const s = segment.trim()
    .replace(/^\$\w+\s*=\s*/, '')
    .replace(/^(?:""\s*\+\s*)?\(*/, '');
  if (s === '' || s === '""') return true; // 純字串段落
  if (/^\$[\w.[\]]+$/.test(s)) return true;
  if (READ_EXPR.test(s)) return true;
  return READ_CMD.test(s);
}

// 引號內容不參與指令判斷，但會展開的雙引號內容要保留：
// - 單引號在 PowerShell 與 Bash 都是純文字，可清空
// - 雙引號若含會展開的寫法（PowerShell 的 $(、Bash 的 $ 與反引號），整段保留，逐段檢查
// - 引號前有 \ 或反引號（跳脫引號）時無法可靠配對，整條不清空（保守判定）
function stripQuotes(command, tool) {
  if (/[\\`]["']/.test(command)) return command;
  const unsafe = tool === 'PowerShell' ? /\$\(/ : /[$`]/;
  return command.replace(/'[^']*'|"[^"]*"/g, (m) => {
    if (m[0] === "'") return '""';
    return unsafe.test(m) ? m : '""';
  });
}

// Bash 命令替換：$(…)、<(…)、反引號由最內層開始展開，最多 10 次。
// 內容含引號或反斜線（stripQuotes 留下的 "" 佔位不算），或內容本身判為寫入，整條判寫入；其餘換成 _S_（非唯讀 token）。
// 回傳展開後的字串；null 代表判寫入（含殘留未展開的替換）。
const SUBST = /\$\(([^()]*)\)|<\(([^()]*)\)|`([^`]*)`/;
function expandSubst(text) {
  let s = text;
  for (let i = 0; i < 10; i++) {
    const m = SUBST.exec(s);
    if (!m) break;
    const body = m[1] ?? m[2] ?? m[3];
    if (/["'\\]/.test(body.replace(/""/g, '')) || isWriteShell(body, 'Bash')) return null;
    s = s.slice(0, m.index) + '_S_' + s.slice(m.index + m[0].length);
  }
  return /\$\(|`|<\(/.test(s) ? null : s;
}

// PowerShell 的 $(…)：由最內層開始遞迴判斷，最多 10 次。內容含 ' 或反引號、或本身判為寫入即判寫入。
// 不處理 (…) 與 {…}：裡面多半是運算式（-gt、-f、Join-Path），用指令白名單判會誤判（見 test.js 已知缺口）。
const PS_SUBST = /\$\(([^(){}]+)\)/;
function expandPs(text) {
  let s = text;
  for (let i = 0; i < 10; i++) {
    const m = PS_SUBST.exec(s);
    if (!m) break;
    if (/['`]/.test(m[1]) || isWriteShell(m[1], 'PowerShell')) return null;
    s = s.slice(0, m.index) + '$()' + s.slice(m.index + m[0].length);
  }
  return /\$\((?!\))/.test(s) ? null : s;
}

// tool 為 'Bash' 或 'PowerShell'，預設 Bash（較嚴格）
function isWriteShell(command, tool = 'Bash') {
  if (typeof command !== 'string' || !command.trim()) return false;
  const bare = stripQuotes(command, tool);
  if (WRITE_HINT.test(bare)) return true;
  if (tool === 'PowerShell' && PS_WRITE_HINT.test(bare)) return true;
  // 命令替換只用來多判寫入；分段仍用原始 bare，展開不會讓寫入變唯讀
  if (tool === 'Bash' && expandSubst(bare) === null) return true;
  if (tool === 'PowerShell' && expandPs(bare) === null) return true;
  return bare.split(SEGMENT_SPLIT).filter(Boolean).some((seg) => !isReadSegment(seg, tool));
}

module.exports = { isWriteShell };
