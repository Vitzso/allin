import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPrivate, privateStrings } from './public-check.mjs';

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

// The real location of a path whose last parts may not exist yet.
function real(path) {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync(full);
  const parent = dirname(full);
  return parent === full ? full : resolve(real(parent), full.slice(parent.length + 1));
}

// This checkout, the main checkout and every other worktree of the same repository.
function checkouts() {
  const listed = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => real(line.slice('worktree '.length)));
  return [...new Set([repo, ...listed])];
}

// macOS and Windows file systems usually ignore case, so the comparison does too there.
const fold = (path) => (process.platform === 'linux' ? path : path.toLowerCase());
const inside = (path, root) => fold(path) === fold(root) || fold(path).startsWith(fold(root) + sep);

// The home folder as the environment gives it and as the account database gives it.
export const homes = () => [...new Set([homedir(), userInfo().homedir])];

// Writes the public copy of one commit into outDir and returns its path. The copy holds the
// tracked files except those marked export-ignore in .gitattributes, and no history. It throws,
// naming each file, if the copy holds anything private. It never pushes or publishes.
export function exportPublic(outDir, { commit = 'HEAD' } = {}) {
  const out = real(outDir);
  if (checkouts().some((root) => inside(out, root)))
    throw new Error('Choose a folder outside this repo for the public copy.');
  if (existsSync(out) && readdirSync(out).length)
    throw new Error(`${out} is not empty. Choose a new or empty folder.`);
  mkdirSync(out, { recursive: true });
  // export-ignore comes from the commit's own .gitattributes. A commit from before that file
  // existed exports the internal notes too, and the check below then refuses it.
  const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', commit], {
    maxBuffer: 1 << 30,
  });
  execFileSync('tar', ['-x', '-C', out], { input: archive });
  const findings = findPrivate(out, { strings: privateStrings(repo), homeDir: homes() });
  if (findings.length)
    throw new Error(
      `The public copy at ${out} holds private details. Do not publish it.\n` +
        findings.map((item) => `  ${item.file}: ${item.kind} (${item.detail})`).join('\n'),
    );
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outDir, commit] = process.argv.slice(2);
  if (!outDir) {
    console.error('Usage: npm run export:public -- <new folder outside this repo> [commit]');
    process.exit(2);
  }
  try {
    const out = exportPublic(outDir, commit ? { commit } : {});
    console.log(`Public copy written to ${out}. Nothing was pushed or published.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
