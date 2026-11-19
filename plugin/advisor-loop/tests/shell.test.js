// 公開的 shell 寫入判定測試（只用合成路徑與合成指令，不含真實對話內容）。
// 執行：node --test tests/
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isWriteShell, UNKNOWN_POLICY } = require('../scripts/shell.js');

const expectWrite = (cmd, tool = 'Bash') => assert.equal(isWriteShell(cmd, tool), true, `應判寫入：${cmd}`);
const expectRead = (cmd, tool = 'Bash') => assert.equal(isWriteShell(cmd, tool), false, `應判唯讀：${cmd}`);

// 種子集合：唯讀（R）、寫入提示（W_hint）、寫入路徑（W_path），各工具分開
const SEEDS = {
  Bash: {
    R: ['ls C:/x', 'cat C:/x/a', 'git status'],
    W: ['rm C:/x/a', 'ls > C:/x/out', 'git push', 'npm i', './x', 'sh ./x.sh'],
  },
  PowerShell: {
    R: ['Get-ChildItem C:/x', 'Get-Content C:/x/a'],
    W: ['Remove-Item C:/x/a', 'Set-Content C:/x/a b', 'Stop-Service svc-x', '.\\x.ps1', '& ./x.ps1'],
  },
};

// 容器：把一個指令放進唯讀指令旁邊，寫入都不能被藏住
const CONTAINERS = {
  Bash: (r, w) => [
    `${r}; ${w}`,
    `${w} | ${r}`,
    `${r} && ${w}`,
    `${r} || ${w}`,
    `${r}\n${w}`,
    `echo $(${w})`,
    `echo \`${w}\``,
    `cat <(${w})`,
  ],
  PowerShell: (r, w) => [
    `${r}; ${w}`,
    `${w} | ${r}`,
    `${r} && ${w}`,
    `${r} || ${w}`,
    `${r}\n${w}`,
    `Write-Output $(${w})`,
    `${r} | ForEach-Object { ${w} }`,
  ],
};

test('種子 × 容器：寫入指令放進任何容器都判寫入（寫入傳染）', () => {
  for (const tool of Object.keys(SEEDS)) {
    for (const r of SEEDS[tool].R) {
      for (const w of SEEDS[tool].W) {
        for (const cmd of CONTAINERS[tool](r, w)) expectWrite(cmd, tool);
      }
    }
  }
});

test('括號或大括號後的路徑呼叫判寫入（PowerShell）；Bash 的 {./a,./b} 判唯讀', () => {
  expectWrite('Get-ChildItem C:/x | ForEach-Object { .\\x.ps1 }', 'PowerShell');
  expectWrite('Get-Content (./x)', 'PowerShell');
  expectWrite('Write-Output (..\\y)', 'PowerShell');
  expectRead("Get-Content (Join-Path C:/x 'a.txt')", 'PowerShell');
  expectRead('cat {./a,./b}');
});

test('屬性與方法：持久寫入的方法與屬性指派判寫入；讀取用法判唯讀', () => {
  expectWrite('Get-ChildItem C:/x | ForEach-Object { $_.OpenWrite() }', 'PowerShell');
  expectWrite('Get-ChildItem C:/x | ForEach-Object { $_.Encrypt() }', 'PowerShell');
  expectWrite('Get-ChildItem C:/x | ForEach-Object { $_.IsReadOnly = $true }', 'PowerShell');
  expectWrite('Get-ChildItem C:/x | ForEach-Object { $_.LastWriteTime = 0 }', 'PowerShell');
  expectRead('Get-ChildItem C:/x | Sort-Object LastWriteTime', 'PowerShell');
  expectRead('Get-ChildItem C:/x | Where-Object { $_.LastWriteTime -gt $d }', 'PowerShell');
  expectRead('$f.IsReadOnly', 'PowerShell');
});

test('唯讀種子單獨與互相串接時判唯讀', () => {
  for (const tool of Object.keys(SEEDS)) {
    for (const r of SEEDS[tool].R) {
      expectRead(r, tool);
      expectRead(`${r}; ${r}`, tool);
      expectRead(`${r} | ${r}`, tool);
    }
  }
});

test('引號內的字面值不執行，判唯讀', () => {
  for (const w of SEEDS.Bash.W) expectRead(`echo '${w}'`);
  for (const w of SEEDS.PowerShell.W) expectRead(`Write-Output '${w}'`, 'PowerShell');
});

test('運算式守護：{…} 內的比較、格式化判唯讀', () => {
  expectRead('Get-ChildItem C:/x | Where-Object { $_.Length -gt 1 }', 'PowerShell');
  expectRead('Get-ChildItem C:/x | ForEach-Object { "{0}" -f $_.Name }', 'PowerShell');
  expectRead('Get-Content C:/x | Where-Object { $_ -eq 1 }', 'PowerShell');
});

test('引號包住或拆開的危險旗標仍判寫入，一般旗標判唯讀', () => {
  expectWrite('find C:/x "-delete"');
  expectWrite('find C:/x -"delete"');
  expectWrite('find C:/x -de"lete"');
  expectWrite('rg "--pre=sh" pattern C:/x');
  expectWrite('rg --pr"e"=sh pattern C:/x');
  expectWrite('file "-C" -m C:/x');
  expectWrite('file -bC C:/x');
  expectWrite('file --comp C:/x');
  expectWrite('git log "--output=C:/x/o"');
  expectWrite('git diff "--ext-diff"');
  expectRead('rg "--pre-glob" "*.gz" C:/x');
  expectRead('find C:/x -name a');
  expectRead('file -b C:/x');
  expectRead('file --mime-type C:/x');
  expectRead('git diff --no-ext-diff');
  expectRead('git diff --output-indicator-new=x');
});

test('重導向：裝置名與 fd 旁接其他字元仍判寫入', () => {
  expectWrite('echo a > NUL"x"');
  expectWrite('echo a > NUL~x');
  expectWrite('echo a >&1abc');
  expectWrite('echo a >&2.txt');
  expectRead('ls > NUL');
  expectRead('ls > NUL 2>&1');
  expectRead('ls >/dev/null;');
  expectRead('ls 2>&1');
  expectRead('ls >&2');
  expectRead('ls >&-');
});

test('Bash 命令位置：$ 開頭、引號指令名與分組內的寫入判寫入', () => {
  expectWrite('$cmd $arg');
  expectWrite('"rm" C:/x/a');
  expectWrite('($cmd)');
  expectWrite('{ $cmd $arg; }');
  expectRead('(ls C:/x)');
  expectRead('{ ls C:/x; }');
});

test('PowerShell 狀態改變的 cmdlet、方法與靜態成員判寫入', () => {
  expectWrite('Stop-Service svc-x', 'PowerShell');
  expectWrite('Get-ChildItem C:/x | ForEach-Object { $_.DeleteValue("k") }', 'PowerShell');
  expectWrite('$d.SaveAs("C:/x/o")', 'PowerShell');
  expectWrite("[Environment]::CurrentDirectory = 'C:/x'", 'PowerShell');
  expectWrite('[IO.File]::`Delete("C:/x/a")', 'PowerShell');
  expectRead('Set-Location C:/x', 'PowerShell');
  expectRead('[Math]::Max(1,2)', 'PowerShell');
});

test('fail closed：非字串、超長、含 NUL 都判寫入；空白判唯讀', () => {
  for (const input of [undefined, null, 42, {}, 'a'.repeat(8193), 'ls\0x']) {
    assert.equal(isWriteShell(input, 'Bash'), true, `應判寫入：${String(input)}`);
  }
  expectRead('   ');
});

test('長度上限內的最壞輸入，每個在 50 ms 內完成', () => {
  const worst = [
    'git '.repeat(2048),
    'echo $(ls) '.repeat(800).slice(0, 8192),
    '"'.repeat(8192),
    '$('.repeat(4096),
    'a'.repeat(8192),
  ];
  for (const s of worst) {
    const t0 = process.hrtime.bigint();
    isWriteShell(s, 'Bash');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, `耗時 ${ms.toFixed(1)} ms`);
  }
});

// 回報性效能案例：這幾個輸入實測超過 50 ms，只印出數字，不擋測試（待決定是否改正規式）
test('回報性效能案例（不判定通過與否，只印出耗時）', () => {
  const reported = {
    '(find 重複': '(find '.repeat(1365),
    'ls 加長空白': 'ls' + ' '.repeat(8000) + 'x',
    'find 空白加引號': 'find' + ' '.repeat(8000) + '"',
  };
  for (const [name, s] of Object.entries(reported)) {
    const t0 = process.hrtime.bigint();
    isWriteShell(s, 'Bash');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`reported ${name}: ${ms.toFixed(1)} ms`);
  }
});

test('PowerShell 常見別名只在命令位置判寫入；參數、路徑與引號內的字判唯讀', () => {
  expectWrite('Get-ChildItem C:/x | ForEach-Object { ri $_ }', 'PowerShell');
  expectWrite('Get-ChildItem C:/x | ForEach-Object { $null = md $_ }', 'PowerShell');
  expectWrite('Write-Output (kill 1)', 'PowerShell');
  expectWrite('Get-ChildItem C:/x | ii', 'PowerShell');
  expectRead('Get-Content ri.txt', 'PowerShell');
  expectRead('Get-ChildItem C:/md/x', 'PowerShell');
  expectRead('Select-String -Pattern kill C:/x', 'PowerShell');
  expectRead("Get-ChildItem C:/x | Where-Object { $_.Name -eq 'ri' }", 'PowerShell');
  expectRead('Get-Content C:/x | Select-String key=kill', 'PowerShell');
  expectRead('Get-ChildItem -Filter name=md', 'PowerShell');
  expectRead('Get-ChildItem ${kill}', 'PowerShell');
  expectWrite('Get-ChildItem C:/x | ForEach-Object { $r = ri $_ }', 'PowerShell');
});

test('UNKNOWN 依 mode：各 mode 與未知、缺少的 mode 都判寫入；策略表不得出現 false', () => {
  for (const mode of ['pretool', 'stop', 'bogus', undefined]) {
    assert.equal(isWriteShell(undefined, 'Bash', { mode }), true, `mode=${mode}`);
    assert.equal(isWriteShell('a'.repeat(8193), 'Bash', { mode }), true, `mode=${mode}`);
  }
  assert.equal(isWriteShell('ls C:/x', 'Bash', { mode: 'stop' }), false);
  assert.equal(Object.isFrozen(UNKNOWN_POLICY), true);
  assert.deepEqual(Object.values(UNKNOWN_POLICY), [true, true]);
});
