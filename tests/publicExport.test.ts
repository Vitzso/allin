import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The public copy of this repo is made by scripts/export-public.mjs and scanned by
// scripts/public-check.mjs. Nothing private is written in this file: the planted details below
// are made up, and the real ones are read from git and from the internal notes at run time.
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
type Finding = { file: string; kind: string; detail: string };
// Loaded by variable so the type checker doesn't need declarations for the .mjs files.
const load = (name: string) => import(pathToFileURL(join(repo, 'scripts', name)).href);
const { findPrivate, privateStrings } = (await load('public-check.mjs')) as {
  findPrivate: (
    folder: string,
    options: { strings: string[]; homeDir: string | string[] },
  ) => Finding[];
  privateStrings: (repo: string) => string[];
};
const { exportPublic } = (await load('export-public.mjs')) as {
  exportPublic: (outDir: string, options?: { commit?: string }) => string;
};

const made: string[] = [];
after(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })));
function folder(files: Record<string, string | Buffer> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'allin-public-'));
  made.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}
const planted = { strings: ['Someone@Example.test', 'made-up-host'], homeDir: '/Users/someone' };
const files = (found: Finding[]) => found.map((item) => item.file).sort();

test('a planted email, home path and listed string are each found, in text and in a binary file', () => {
  const root = folder({
    'a.md': 'write to someone@example.TEST please',
    'deep/b.ts': `const dir = '/Users/someone/Library';`,
    'c.json': JSON.stringify({ host: 'MADE-UP-HOST' }),
    'd.bin': Buffer.concat([
      Buffer.alloc(4096, 0xff),
      Buffer.from('made-up-host'),
      Buffer.alloc(9),
    ]),
    'long.txt': 'x'.repeat(200_000) + 'someone@example.test',
    'clean.md': 'nothing here, and /Users/o is a made-up test path',
  });
  const found = findPrivate(root, planted);
  assert.deepEqual(files(found), ['a.md', 'c.json', 'd.bin', 'deep/b.ts', 'long.txt']);
  assert.ok(found.every((item) => item.kind === 'private text'));
  // The report says which entry matched without repeating it in full.
  assert.ok(found.every((item) => !/someone@example\.test|made-up-host/i.test(item.detail)));
});

test('files are reported by path: internal notes, environment, key and certificate files', () => {
  const root = folder({
    'docs/superpowers/specs/x.md': 'x',
    '.superpowers/ledger.md': 'x',
    '.claude/settings.json': '{}',
    '.env': 'A=1',
    '.env.local': 'A=1',
    'docker.env': 'A=1',
    'tls/server.key': 'x',
    'tls/server.crt': 'x',
    'ca.pem': 'x',
    'old.allin-backup': 'x',
    'docker.env.example': 'A=',
    'compose.env.example': 'A=',
    'docs/guide.md': 'x',
  });
  const found = findPrivate(root, { strings: [], homeDir: '/Users/someone' });
  assert.deepEqual(files(found), [
    '.claude/settings.json',
    '.env',
    '.env.local',
    '.superpowers/ledger.md',
    'ca.pem',
    'docker.env',
    'docs/superpowers/specs/x.md',
    'old.allin-backup',
    'tls/server.crt',
    'tls/server.key',
  ]);
  assert.ok(found.every((item) => item.kind === 'private file'));
});

test('private text is found in UTF-16 files, in file names and under a second home folder', () => {
  const root = folder({
    'le.txt': Buffer.from('\ufeffhost: Made-Up-Host', 'utf16le'),
    'be.txt': Buffer.from('xhost: made-up-host', 'utf16le').swap16(),
    'notes-for-made-up-host.md': 'nothing inside',
    'other-home.txt': 'see /home/someone-else/file',
    'clean.txt': Buffer.from('nothing here', 'utf16le'),
  });
  const found = findPrivate(root, {
    strings: planted.strings,
    homeDir: ['/Users/someone', '/home/someone-else'],
  });
  assert.deepEqual(files(found), [
    'be.txt',
    'le.txt',
    'notes-for-made-up-host.md',
    'other-home.txt',
  ]);
});

test('a symbolic link is reported and never followed, and no folder is skipped', () => {
  const secret = folder({ 'outside.txt': 'made-up-host' });
  const root = folder({
    'node_modules/pkg/index.js': 'made-up-host',
    '.git/config': 'made-up-host',
  });
  symlinkSync(join(secret, 'outside.txt'), join(root, 'link.txt'));
  symlinkSync(secret, join(root, 'linked-folder'));
  const found = findPrivate(root, planted);
  assert.deepEqual(files(found), [
    '.git/config',
    'link.txt',
    'linked-folder',
    'node_modules/pkg/index.js',
  ]);
  assert.equal(found.find((item) => item.file === 'link.txt')?.detail, 'a link or special file');
});

test('a clean folder has no findings', () => {
  const root = folder({ 'README.md': '# Hello', 'src/a.ts': 'export const a = 1;' });
  assert.deepEqual(findPrivate(root, planted), []);
});

test('the export refuses a folder inside the repo and a folder that is not empty', () => {
  assert.throws(() => exportPublic(join(repo, 'release', 'public')), /outside this repo/);
  assert.throws(() => exportPublic(repo), /outside this repo/);
  // The same folder reached by a relative path, through "..", and through a symbolic link.
  assert.throws(() => exportPublic('release/public'), /outside this repo/);
  assert.throws(() => exportPublic(join(repo, 'tests', '..', 'release', 'x')), /outside this repo/);
  const link = join(folder(), 'link');
  symlinkSync(repo, link);
  assert.throws(() => exportPublic(join(link, 'release', 'x')), /outside this repo/);
  if (process.platform !== 'linux')
    assert.throws(() => exportPublic(join(repo.toUpperCase(), 'x')), /outside this repo/);
  // Every checkout of this repository is refused, not only the one the script runs from.
  const checkouts = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  for (const root of checkouts)
    assert.throws(() => exportPublic(join(root, 'public-copy')), /outside this repo/, root);
  assert.throws(() => exportPublic(folder({ 'kept.txt': 'mine' })), /not empty/);
});

test('the export of HEAD leaves out docs/superpowers and passes the check', () => {
  const out = exportPublic(join(folder(), 'out'));
  assert.ok(existsSync(join(out, 'README.md')));
  assert.ok(existsSync(join(out, 'server', 'app.ts')));
  assert.ok(existsSync(join(out, 'docs', 'THREAT_MODEL.md')));
  assert.ok(!existsSync(join(out, 'docs', 'superpowers')));
  assert.ok(!existsSync(join(out, '.git')));
  assert.ok(!existsSync(join(out, 'node_modules')));
  // The check ran inside exportPublic. Run it again here so a silent skip can't pass.
  assert.deepEqual(findPrivate(out, { strings: privateStrings(repo), homeDir: homedir() }), []);
});

test('the list of private text comes from the commit history and the internal notes', () => {
  const strings = privateStrings(repo);
  const authors = execFileSync('git', ['-C', repo, 'log', '--all', '--format=%ae'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((email) => email && !/noreply/i.test(email));
  for (const email of new Set(authors)) assert.ok(strings.includes(email));
  // Where the internal notes exist (the working repo, not the public copy), their list is read.
  const list = join(repo, 'docs', 'superpowers', 'private-strings.txt');
  if (existsSync(list))
    for (const line of readFileSync(list, 'utf8').split('\n'))
      if (line.trim() && !line.startsWith('#')) assert.ok(strings.includes(line.trim()));
});

test('no tracked page outside docs/superpowers links into it', () => {
  const pages = execFileSync('git', ['-C', repo, 'ls-files', '*.md'], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (path) => path && !path.startsWith('docs/superpowers/') && existsSync(join(repo, path)),
    );
  assert.ok(pages.includes('README.md'));
  for (const page of pages)
    assert.doesNotMatch(readFileSync(join(repo, page), 'utf8'), /\]\([^)]*superpowers\//, page);
});
