import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Finds private details in a folder that is about to become the public copy of this repo.
// Nothing private is written here: the text to look for is read from the commit history and
// from a list kept with the internal notes, which are themselves left out of the public copy.

// Every author and committer email in the history, and each line of the private list.
export function privateStrings(repo) {
  const emails = execFileSync('git', ['-C', repo, 'log', '--all', 'HEAD', '--format=%ae%n%ce'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split('\n')
    .map((line) => line.trim())
    // GitHub's no-reply addresses are public by design.
    .filter((email) => email && !/noreply/i.test(email));
  const list = join(repo, 'docs', 'superpowers', 'private-strings.txt');
  const listed = existsSync(list)
    ? readFileSync(list, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    : [];
  return [...new Set([...emails, ...listed])];
}

const privateFolders = ['docs/superpowers/', '.superpowers/', '.claude/'];
const privateEndings = ['.key', '.crt', '.pem', '.csr', '.srl', '.allin-backup'];

function privatePath(file) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (privateFolders.some((folder) => file.startsWith(folder))) return 'internal notes';
  // Examples such as docker.env.example are meant to be public.
  if (name.endsWith('.example')) return '';
  if (name.startsWith('.env') || name === 'docker.env') return 'environment file';
  if (privateEndings.some((ending) => name.endsWith(ending))) return 'key, certificate or backup';
  return '';
}

// Every entry under root, with no folder skipped. Anything that isn't a plain file or folder
// (a symbolic link, for one) is returned as "other", so it is reported and never followed.
function walk(root, folder = '') {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(root, path);
    return [{ path, plain: entry.isFile() }];
  });
}

// The file's bytes read four ways, lower-cased, so text is found whether the file is UTF-8,
// UTF-16 in either byte order, or binary. It does not undo other encodings (URL-encoding,
// compression) or join text split across lines.
function readings(bytes) {
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
  return [
    bytes.toString('latin1'),
    bytes.toString('utf8'),
    even.toString('utf16le'),
    Buffer.from(even).swap16().toString('utf16le'),
  ];
}

// Shows enough of a match to recognise it, without repeating it in a log.
const hint = (text) => `${text.slice(0, 3)}… (${text.length} characters)`;

// Returns one finding per file and reason: { file, kind, detail }.
export function findPrivate(folder, { strings, homeDir }) {
  const needles = strings.filter(Boolean).map((text) => ({ text, lower: text.toLowerCase() }));
  // One folder or several. A home folder of "/" or "/root" would match too much to mean anything.
  const homes = [homeDir].flat().filter((home) => home && home.length > 6);
  const findings = [];
  for (const { path: file, plain } of walk(folder)) {
    const reason = privatePath(file);
    if (reason) {
      findings.push({ file, kind: 'private file', detail: reason });
      continue;
    }
    if (!plain) {
      findings.push({ file, kind: 'private file', detail: 'a link or special file' });
      continue;
    }
    const texts = readings(readFileSync(join(folder, file)));
    // The file's own name is searched too.
    const lower = [...texts, file].map((text) => text.toLowerCase());
    const match = needles.find((needle) => lower.some((text) => text.includes(needle.lower)));
    if (match) findings.push({ file, kind: 'private text', detail: hint(match.text) });
    else if (homes.some((home) => [...texts, file].some((text) => text.includes(home))))
      findings.push({ file, kind: 'private text', detail: 'a path under your home folder' });
  }
  return findings;
}
