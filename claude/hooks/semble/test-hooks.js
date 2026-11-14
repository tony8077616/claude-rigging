'use strict';
// Run: node test-hooks.js  (exit 1 on any failure)
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const grep = require('./block-grep.js');
const shell = require('./block-shell-search.js');

const D = __dirname, F = __filename, N = path.join(D, 'no-such-file.txt');
let pass = 0, fail = 0;
function t(msg, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${msg}: ${e.message}`); }
}

const ALLOW = [
  'semble search "grep flow" ./x',
  'uvx --from "semble[mcp]==0.6.2" semble search "x" ./x',
  'git log | grep foo',
  'Get-Process | Select-String x',
  'type a.txt | findstr foo',
  'echo "rg foo"',
  'git commit -m "fix grep -r usage"',
  `grep foo ${N}`,
  `grep foo ${F}`,
  `rg foo ${F}`,
  `rg -C 3 foo ${F}`,
  'echo x | rg foo',
  `Select-String -Pattern 'a.*b' -Path ${F}`,
  `Select-String 'a.*b' ${F}`,
  'rg --version',
  'gci -r | % { $_.Name }',
  'git -C src log | grep foo',
  'npm run build 2>&1 | grep error',
  `gci -r > list.txt; Select-String foo ${F}`,
  'cmd /c "echo hi"',
  'grep --help',
  `rg -e foo ${F}`,
  `rg -t js foo ${F}`,
];
const DENY = [
  'rg foo',
  `rg.exe -n foo ${D}`,
  `grep -rn foo ${D}`,
  'grep -R foo .',
  'grep --recursive foo .',
  'git grep foo',
  'findstr /s foo *.js',
  'gci -r *.ps1 | sls foo',
  'Get-ChildItem -Recurse | Select-String x',
  'SELECT-STRING -Path .\\*.ps1 x',
  'cd src && rg foo',
  'a; grep -r x .',
  'find . | xargs grep foo',
  'find . -exec grep foo {} +',
  '$(rg foo)',
  'bash -c "grep -r x ."',
  'find . -name x | grep y',
  'rg -t js foo',
  'rg -n -C 3 foo',
  'rg -g "*.ps1" foo',
  'ag foo',
  'ack foo',
  `rg foo ${N}`,
  `rg foo ${D}`,
  'gci -Recurse | % { sls foo $_ }',
  'Get-ChildItem -Recurse | ForEach-Object { Select-String -Path $_ -Pattern foo }',
  'gci -r | Where-Object { $_ | Select-String foo }',
  'Select-String -Pattern foo -Path (gci -r)',
  'foreach ($f in (gci -r)) {\n  Select-String foo $f\n}',
  'git -C src grep foo',
  'git --no-pager grep foo',
  'git -c core.quotepath=off grep foo',
  '& rg foo',
  `& 'C:\\tools\\rg.exe' foo`,
  'echo hi & grep -r x .',
  'cmd /c "findstr /s foo *.js"',
  'cmd /c "dir /s /b | findstr foo"',
];
for (const c of ALLOW) t(`shell ALLOW ${c}`, () => assert.strictEqual(shell.decide(c), 'allow'));
for (const c of DENY) t(`shell DENY ${c}`, () => assert.strictEqual(shell.decide(c), 'deny'));

const gi = (mode) => JSON.stringify({ tool_name: 'Grep', tool_input: mode === undefined ? { pattern: 'x' } : { pattern: 'x', output_mode: mode } });
t('grep unit allow count', () => assert.strictEqual(grep.decide(gi('count')), 'allow'));
for (const m of ['files_with_matches', 'content', undefined]) {
  t(`grep unit deny ${m}`, () => assert.strictEqual(grep.decide(gi(m)), 'deny'));
}
t('grep unit deny malformed', () => assert.strictEqual(grep.decide('{bad'), 'deny'));

const run = (hook, input) => spawnSync('node', [path.join(D, hook)], { input, encoding: 'utf8' });
const isDeny = (r) => r.status === 0 && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny';
t('e2e grep count -> empty', () => { const r = run('block-grep.js', gi('count')); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); });
t('e2e grep content -> deny JSON', () => assert(isDeny(run('block-grep.js', gi('content')))));
t('e2e grep missing mode -> deny JSON', () => assert(isDeny(run('block-grep.js', gi(undefined)))));
t('e2e grep malformed -> deny JSON', () => assert(isDeny(run('block-grep.js', '{bad'))));

const si = (command, tool_name = 'Bash') => JSON.stringify({ tool_name, tool_input: { command } });
t('e2e shell deny Bash', () => assert(isDeny(run('block-shell-search.js', si('rg foo')))));
t('e2e shell deny PowerShell', () => assert(isDeny(run('block-shell-search.js', si('Get-ChildItem -Recurse | Select-String x', 'PowerShell')))));
t('e2e shell allow -> empty', () => { const r = run('block-shell-search.js', si('git log | grep foo')); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); });
t('e2e shell malformed -> fail-open', () => { const r = run('block-shell-search.js', '{bad'); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); });
t('e2e shell missing command -> fail-open', () => { const r = run('block-shell-search.js', JSON.stringify({ tool_input: {} })); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); });

t('shell relative file with cwd ALLOW', () => assert.strictEqual(shell.decide('rg foo test-hooks.js', D), 'allow'));
t('shell relative file with wrong cwd DENY', () => assert.strictEqual(shell.decide('rg foo test-hooks.js', 'C:/'), 'deny'));
t('shell pattern only DENY', () => assert.strictEqual(shell.decide('rg test-hooks.js', D), 'deny'));
// Process cwd is set apart from payload cwd, so a hook that ignores payload.cwd fails these two.
const runAt = (procCwd, input) => spawnSync('node', [path.join(D, 'block-shell-search.js')], { input, encoding: 'utf8', cwd: procCwd });
const cmdRel = (c) => JSON.stringify({ tool_input: { command: 'rg foo test-hooks.js' }, cwd: c });
t('e2e payload cwd overrides process cwd -> allow', () => { const r = runAt(path.parse(D).root, cmdRel(D)); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); });
t('e2e payload cwd wrong -> deny', () => assert(isDeny(runAt(D, cmdRel(path.parse(D).root)))));

t('shell rg -t flag value not a path DENY', () => assert.strictEqual(shell.decide('rg -t js test-hooks.js', D), 'deny'));

// block-ctx-execute.js: context-mode tools route shell commands through the same decide()
const ctx = require('./block-ctx-execute.js');
const CTX_EXEC = 'mcp__plugin_context-mode_context-mode__ctx_execute';
const CTX_BATCH = 'mcp__plugin_context-mode_context-mode__ctx_batch';
const ci = (tool_name, tool_input) => JSON.stringify({ tool_name, tool_input, cwd: D });
t('ctx shell deny', () => assert(isDeny(run('block-ctx-execute.js', ci(CTX_EXEC, { language: 'shell', code: 'rg foo .' })))));
t('ctx powershell deny', () => assert(isDeny(run('block-ctx-execute.js', ci(CTX_EXEC, { language: 'powershell', code: 'Get-ChildItem -Recurse | Select-String x' })))));
t('ctx batch deny', () => assert(isDeny(run('block-ctx-execute.js', ci(CTX_BATCH, { commands: ['git status', 'grep -r foo .'], queries: ['x'] })))));
t('ctx shell pipe allow -> empty', () => { const r = run('block-ctx-execute.js', ci(CTX_EXEC, { language: 'shell', code: 'git log | grep foo' })); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); });
t('ctx javascript code not parsed -> allow', () => { const r = run('block-ctx-execute.js', ci(CTX_EXEC, { language: 'javascript', code: "console.log('rg -r')" })); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); });
t('ctx malformed -> fail-open', () => { const r = run('block-ctx-execute.js', '{bad'); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); });
t('ctx commandsOf ctx_batch reads commands', () => assert.deepStrictEqual(ctx.commandsOf({ tool_name: CTX_BATCH, tool_input: { commands: ['a', 1, 'b'] } }), ['a', 'b']));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
