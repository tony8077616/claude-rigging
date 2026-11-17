// 公開的 shell 寫入判定測試（只用合成路徑與合成指令，不含真實對話內容）。
// 執行：node --test tests/
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isWriteShell } = require('../scripts/shell.js');

const expectWrite = (cmd, tool = 'Bash') => assert.equal(isWriteShell(cmd, tool), true, `應判寫入：${cmd}`);
const expectRead = (cmd, tool = 'Bash') => assert.equal(isWriteShell(cmd, tool), false, `應判唯讀：${cmd}`);

test('寫入指令放進唯讀容器後仍判寫入（寫入傳染）', () => {
  const bashWrite = 'rm C:/x/a';
  for (const cmd of [
    `ls C:/x; ${bashWrite}`,
    `${bashWrite} | ls`,
    `ls C:/x && ${bashWrite}`,
    `ls C:/x || ${bashWrite}`,
    `ls C:/x\n${bashWrite}`,
    `echo $(${bashWrite})`,
    `echo \`${bashWrite}\``,
    `cat <(${bashWrite})`,
  ]) expectWrite(cmd);

  const psWrite = 'Remove-Item C:/x/a';
  for (const cmd of [
    `Write-Output $(${psWrite})`,
    `Get-ChildItem C:/x | ForEach-Object { ${psWrite} }`,
  ]) expectWrite(cmd, 'PowerShell');
});

test('引號內的字面值不執行，判唯讀', () => {
  expectRead("echo 'rm C:/x/a'");
  expectRead("Write-Output 'Remove-Item C:/x/a'", 'PowerShell');
});

test('運算式守護：{…} 內的比較、格式化判唯讀', () => {
  expectRead('Get-ChildItem C:/x | Where-Object { $_.Length -gt 1 }', 'PowerShell');
  expectRead('Get-ChildItem C:/x | ForEach-Object { "{0}" -f $_.Name }', 'PowerShell');
  expectRead('Get-Content C:/x | Where-Object { $_ -eq 1 }', 'PowerShell');
});

test('引號包住的危險旗標與裝置名仍判寫入', () => {
  expectWrite('find C:/x "-delete"');
  expectWrite('rg "--pre=sh" pattern C:/x');
  expectWrite('file "-C" -m C:/x');
  expectWrite('echo a > NUL"out.txt"');
  expectRead('rg "--pre-glob" "*.gz" C:/x');
  expectRead('ls C:/x > NUL');
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

test('fail closed：非字串、超長、含 NUL 或例外都判寫入；空白判唯讀', () => {
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
