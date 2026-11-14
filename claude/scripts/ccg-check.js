#!/usr/bin/env node
// Checks whether CCG (ccg init / reinstall) restored settings we removed on purpose.
// Read-only: reports PASS/FAIL with a fix hint, never edits files. Usage: node ccg-check.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const rulesDir = path.join(claudeDir, 'rules');
const backupDir = path.join(claudeDir, 'backups');
const results = [];

function record(ok, name, fix) {
  results.push({ ok, name, fix: ok ? '' : fix });
}

function readJson(file) {
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf-8')) };
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'file not found' : `parse failed: ${err.message}` };
  }
}

function latestBackup(prefix) {
  try {
    const names = fs.readdirSync(backupDir).filter((n) => n.startsWith(prefix)).sort();
    return names.length ? path.join(backupDir, names[names.length - 1]) : '(no backup found)';
  } catch {
    return '(no backup dir)';
  }
}

// 1-2. Rules we removed must not come back.
for (const [rule, label] of [['ccg-codegraph.md', 'codegraph rule'], ['ccg-fast-context.md', 'fast-context rule']]) {
  const file = path.join(rulesDir, rule);
  const exists = fs.existsSync(file);
  record(!exists, `${label} absent`,
    `re-created by CCG. Delete: ${file} (backup: ${latestBackup(rule)})`);
}

// 3. MCP servers: fast-context and codegraph should be absent, semble present.
const claudeJsonPath = path.join(home, '.claude.json');
const claudeJson = readJson(claudeJsonPath);
if (claudeJson.error) {
  record(false, '~/.claude.json readable', `${claudeJsonPath}: ${claudeJson.error}`);
} else {
  const servers = claudeJson.data.mcpServers || {};
  record(!('fast-context' in servers), 'fast-context MCP absent',
    'run: claude mcp remove fast-context -s user');
  record(!('codegraph' in servers), 'codegraph MCP absent',
    'run: claude mcp remove codegraph -s user');
  record('semble' in servers, 'semble MCP present',
    'restore: claude mcp add-json semble \'{"type":"stdio","command":"uvx","args":["--from","semble[mcp]==0.6.2","semble"]}\' -s user');
}

// 4. Grep block hook must stay registered and its script must exist.
const settingsPath = path.join(claudeDir, 'settings.json');
const settings = readJson(settingsPath);
const hookScript = path.join(claudeDir, 'hooks', 'semble', 'block-grep.js');
if (settings.error) {
  record(false, 'settings.json readable', `${settingsPath}: ${settings.error}`);
} else {
  const commands = ((settings.data.hooks || {}).PreToolUse || [])
    .flatMap((entry) => entry.hooks || [])
    .map((hook) => hook.command || '');
  record(commands.some((c) => c.includes('hooks/semble/block-grep.js')), 'Grep block hook registered',
    're-add to settings.json PreToolUse: matcher "Grep", command "node <home>/.claude/hooks/semble/block-grep.js"');
}
record(fs.existsSync(hookScript), 'Grep block script exists', `missing: ${hookScript}`);

// 5. Codex / Gemini instruction files must not carry the fast-context marker.
for (const file of [path.join(home, '.codex', 'AGENTS.md'), path.join(home, '.gemini', 'GEMINI.md')]) {
  if (!fs.existsSync(file)) {
    continue;
  }
  const hasMarker = fs.readFileSync(file, 'utf-8').includes('CCG-FAST-CONTEXT-START');
  record(!hasMarker, `no fast-context marker in ${path.basename(file)}`,
    `remove the CCG-FAST-CONTEXT block from ${file}`);
}

let failures = 0;
for (const r of results) {
  console.log(`${r.ok ? '[PASS]' : '[FAIL]'} ${r.name}`);
  if (!r.ok) {
    failures += 1;
    console.log(`       -> ${r.fix}`);
  }
}
console.log(`\nresult: ${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
