#!/usr/bin/env node
// 自測：node dispatch-test.js
// 只用合成 transcript，不讀取任何真實對話內容。
'use strict';

const assert = require('assert');
const { recentCounts, agentDispatchModels, evaluateAgentCall, summaryLine, WINDOW } = require('./dispatch-lib.js');

const agent = (input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input }] } });
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const hist = [
  agent({ model: 'haiku' }),
  agent({ model: 'haiku' }),
  agent({ subagent_type: 'fork' }),                 // fork 不計入
  agent({ model: 'sonnet' }),
  say('plain text'),
  agent({ model: 'opus' }),
];

const cases = [
  ['fork 不列入派工紀錄', () => assert.deepStrictEqual(agentDispatchModels(hist), ['haiku', 'haiku', 'sonnet', 'opus'])],
  ['計數 haiku/sonnet/opus', () => assert.deepStrictEqual(recentCounts(hist), { haiku: 2, sonnet: 1, opus: 1 })],
  ['滑動視窗只看最近 10 次', () => {
    const many = Array.from({ length: 12 }, () => agent({ model: 'haiku' }));
    assert.strictEqual(recentCounts(many).haiku, WINDOW);
  }],
  ['缺 model → warn（warn 模式）', () => assert.strictEqual(evaluateAgentCall({ prompt: 'x' }, [], 'warn').decision, 'warn')],
  ['缺 model → deny（deny 模式）', () => assert.strictEqual(evaluateAgentCall({ prompt: 'x' }, [], 'deny').decision, 'deny')],
  ['fable → warn（warn 模式）', () => assert.strictEqual(evaluateAgentCall({ model: 'fable' }, [], 'warn').decision, 'warn')],
  ['fable → deny（deny 模式）', () => assert.strictEqual(evaluateAgentCall({ model: 'fable' }, [], 'deny').decision, 'deny')],
  ['fork 不論 model 一律放行', () => assert.strictEqual(evaluateAgentCall({ subagent_type: 'fork' }, [], 'deny').decision, 'allow')],
  ['haiku 未達配額 → 放行', () => assert.strictEqual(evaluateAgentCall({ model: 'haiku' }, hist, 'deny').decision, 'allow')],
  ['opus 已達配額 2 → warn（即使 deny 模式也只警告）', () => {
    const h = [agent({ model: 'opus' }), agent({ model: 'opus' })];
    assert.strictEqual(evaluateAgentCall({ model: 'opus' }, h, 'deny').decision, 'warn');
  }],
  ['摘要列出三層級計數', () => assert.ok(summaryLine(hist).includes('haiku 2/5'))],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}：${err.message.split('\n')[0]}`);
  }
}
console.log(failed === 0 ? '\n全部通過' : `\n失敗 ${failed} 項`);
process.exit(failed === 0 ? 0 : 1);
