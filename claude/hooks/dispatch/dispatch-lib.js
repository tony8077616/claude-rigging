#!/usr/bin/env node
// Subagent 派工比例：共用邏輯（全域，不依賴任何專案路徑）
// 計數來源是 transcript，不另建狀態檔。fork 忽略 model，不計入比例。
'use strict';

const QUOTA = { haiku: 5, sonnet: 3, opus: 2 };
const WINDOW = 10;
const TIERS = Object.keys(QUOTA);

function parseLines(raw) {
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function blocksOf(entry) {
  const content = entry.message?.content ?? entry.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

// 本 session 所有非 fork 的 Agent 派工，依時間順序；model 缺值以 null 表示
function agentDispatchModels(entries) {
  const models = [];
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    for (const b of blocksOf(e)) {
      if (b.type !== 'tool_use' || b.name !== 'Agent') continue;
      if (b.input?.subagent_type === 'fork') continue;
      models.push(b.input?.model ?? null);
    }
  }
  return models;
}

function recentCounts(entries) {
  const counts = { haiku: 0, sonnet: 0, opus: 0 };
  for (const m of agentDispatchModels(entries).slice(-WINDOW)) {
    if (m && counts[m] !== undefined) counts[m]++;
  }
  return counts;
}

// 回傳 { decision: 'allow' | 'warn' | 'deny', reason? }
// mode: 'warn'（預設，上線初期）或 'deny'
function evaluateAgentCall(toolInput, entries, mode) {
  const input = toolInput || {};
  if (input.subagent_type === 'fork') return { decision: 'allow' };

  const model = input.model;
  const problem = !model
    ? '派工必須指定 model：haiku / sonnet / opus。'
    : model === 'fable'
      ? '本計畫上限為 opus，fable 需使用者明示。'
      : null;
  if (problem) {
    return { decision: mode === 'deny' ? 'deny' : 'warn', reason: problem };
  }

  if (!TIERS.includes(model)) return { decision: 'allow' };
  const counts = recentCounts(entries);
  if (counts[model] >= QUOTA[model]) {
    return {
      decision: 'warn',
      reason: `近 ${WINDOW} 次派工中 ${model} 已達配額 ${QUOTA[model]}（目前 ${counts[model]}）。請確認此任務是否真的需要 ${model}，否則改派較低層級。`,
    };
  }
  return { decision: 'allow' };
}

function summaryLine(entries) {
  const c = recentCounts(entries);
  return `近 ${WINDOW} 次派工：haiku ${c.haiku}/${QUOTA.haiku}，sonnet ${c.sonnet}/${QUOTA.sonnet}，opus ${c.opus}/${QUOTA.opus}`;
}

module.exports = { QUOTA, WINDOW, parseLines, agentDispatchModels, recentCounts, evaluateAgentCall, summaryLine };
