import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { auditSource } from '../scripts/audit-source.mjs';
import { checkDocs } from '../scripts/check-docs.mjs';
import { checkChangelog } from '../scripts/check-changelog.mjs';
import { validateArt, validatePicks, validateCredits } from '../src/library/config.ts';

test('library formats reject unknown formats for every library section', () => {
  for (const validate of [validateArt, validatePicks, validateCredits]) {
    assert.equal(validate({ dir: 'library', format: 'alba' }, 'alba.yaml', '.', '.', 'demo').format, 'alba');
    assert.throws(() => validate({ dir: 'library', format: 'other' }, 'alba.yaml', '.', '.', 'demo'), /must be "alba"/);
  }
});

test('release scan covers new files and each prohibited class without reading ignored state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'alba-release-'));
  try {
    execFileSync('git', ['init', root], { stdio: 'ignore', windowsHide: true });
    writeFileSync(path.join(root, '.gitignore'), '.alba/\n.pnpm-store/\n');
    mkdirSync(path.join(root, '.alba')); writeFileSync(path.join(root, '.alba', 'private.txt'), '\u4e2d');
    mkdirSync(path.join(root, '.pnpm-store')); writeFileSync(path.join(root, '.pnpm-store', 'cache'), Buffer.from([255, 254, 0]));
    const cases = [
      ['old product', ['game', 'studio', 'factory'].join('-')],
      ['Chinese', '\u4e2d'], ['BOM', '\ufefftext'],
      ['drive path', '"' + path.win32.join('Z:' + path.win32.sep, 'private', 'file') + '"'],
      ['POSIX path', '"/' + 'home/person/project"'],
      ['rooted path', '"/' + 'tmp/private/project"'],
      ['macOS path', '"/' + 'private/var/project"'],
      ['username', ['Tju', 'So'].join('')],
      ['ticket', ['A', 'L', '2'].join('')],
      ['credential', ['ghp', '_', 'a'.repeat(30)].join('')],
      ['service credential', ['xoxb', '-', 'a'.repeat(30)].join('')],
      ['assignment', 'token = "' + 'b'.repeat(30) + '"'],
    ];
    for (const [label, value] of cases) {
      writeFileSync(path.join(root, 'new.txt'), value);
      assert.ok(auditSource(root).problems.length, label);
    }
    writeFileSync(path.join(root, 'new.txt'), 'public text\n');
    writeFileSync(path.join(root, 'invalid.txt'), Buffer.from([255, 254]));
    assert.ok(auditSource(root).problems.some(p => p.includes('invalid.txt: invalid UTF-8 text')));
    rmSync(path.join(root, 'invalid.txt'));
    writeFileSync(path.join(root, '.pnpm-store', 'tracked.txt'), '\u4e2d');
    execFileSync('git', ['-C', root, 'add', '-f', '.pnpm-store/tracked.txt'], { windowsHide: true });
    assert.ok(auditSource(root).problems.some(p => p.includes('.pnpm-store/tracked.txt')), 'tracked files are scanned even inside ignored folders');
    execFileSync('git', ['-C', root, 'rm', '-f', '.pnpm-store/tracked.txt'], { stdio: 'ignore', windowsHide: true });
    mkdirSync(path.join(root, 'ui/src/i18n'), { recursive: true });
    writeFileSync(path.join(root, 'ui/src/i18n/zh.ts'), '\u4e2d');
    writeFileSync(path.join(root, 'README.zh-CN.md'), '# Alba \u4e2d\u6587\n');
    writeFileSync(path.join(root, 'README.md'), '**English** | [\u7b80\u4f53\u4e2d\u6587](README.zh-CN.md)\n');
    assert.deepEqual(auditSource(root).problems, []);
    writeFileSync(path.join(root, 'README.md'), '# Alba \u4e2d\u6587\n');
    assert.ok(auditSource(root).problems.some(p => p.includes('README.md: translation outside its catalog')));
    writeFileSync(path.join(root, 'README.md'), '**English** | [\u7b80\u4f53\u4e2d\u6587](README.zh-CN.md)\n');
    writeFileSync(path.join(root, 'ui/src/i18n/index.ts'), '\u4e2d');
    assert.ok(auditSource(root).problems.length, 'non-catalog files in the translation directory are scanned');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('document and changelog checks reject missing files, anchors, references and versions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'alba-doc-check-'));
  try {
    execFileSync('git', ['init', root], { stdio: 'ignore', windowsHide: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0\n');
    writeFileSync(path.join(root, 'README.md'), '# Read me\n\n[valid](CHANGELOG.md#010)\n');
    assert.equal(checkChangelog(root), '0.1.0'); assert.deepEqual(checkDocs(root).problems, []);
    for (const bad of ['[missing](absent.md)', '[anchor](CHANGELOG.md#absent)', '[ref][undefined]', '![image](missing.png)']) {
      writeFileSync(path.join(root, 'README.md'), bad);
      assert.ok(checkDocs(root).problems.length, bad);
    }
    writeFileSync(path.join(root, 'CHANGELOG.md'), '## 0.1.01\n');
    assert.throws(() => checkChangelog(root), /0.1.0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
