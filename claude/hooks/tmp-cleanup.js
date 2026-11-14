#!/usr/bin/env node
// SessionStart：刪除 ~/.claude/tmp 中超過 3 天的一般檔案；不跟隨 symlink、不輸出、錯誤一律吞掉
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function cleanup(root, maxAgeMs, now) {
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      removed += cleanup(p, maxAgeMs, now);
      if (!fs.readdirSync(p).length) fs.rmdirSync(p);
    } else if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
      fs.unlinkSync(p);
      removed++;
    }
  }
  return removed;
}

module.exports = { cleanup };
if (require.main === module) {
  try { cleanup(path.join(os.homedir(), '.claude', 'tmp'), 3 * 86400000, Date.now()); } catch (e) { /* 清理失敗不影響啟動 */ }
  process.exit(0);
}
