import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The files a public repo is judged by: the licence, the notice, how to report a problem, how
// to contribute, and the front page.
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

test('LICENSE is the unmodified Apache 2.0 text', () => {
  // The hash of https://www.apache.org/licenses/LICENSE-2.0.txt, fetched on 2026-11-16.
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(repo, 'LICENSE')))
      .digest('hex'),
    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  );
});

test('package.json names the licence and stays private', () => {
  const pkg = JSON.parse(read('package.json')) as { license?: string; private?: boolean };
  assert.equal(pkg.license, 'Apache-2.0');
  // "private" only stops an accidental publish to the npm registry.
  assert.equal(pkg.private, true);
});

test('NOTICE names the project and the copyright holder', () => {
  const notice = read('NOTICE');
  assert.match(notice, /^AllIn\n/);
  assert.match(notice, /Copyright 2026 Vitzso/);
  assert.match(notice, /Apache License, Version 2\.0/);
});

test('SECURITY.md asks for private reports and gives no email address', () => {
  const page = read('SECURITY.md');
  assert.match(page, /Report a vulnerability/);
  assert.match(page, /do not open a public issue/i);
  assert.match(page, /\(docs\/THREAT_MODEL\.md\)/);
  assert.doesNotMatch(page, /[\w.+-]+@[\w-]+\.[\w.]+/);
});

test('CONTRIBUTING.md names the checks and the rules a change must keep', () => {
  const page = read('CONTRIBUTING.md');
  for (const command of [
    'npm ci',
    'npm run build',
    'npm test',
    'npm run test:build',
    'npm run test:browser',
    'npx prettier --check .',
  ])
    assert.ok(page.includes(command), command);
  assert.match(page, /api\.coinbase\.com/);
  assert.match(page, /data\.alpaca\.markets/);
  assert.match(page, /\(docs\/THREAT_MODEL\.md\)/);
  assert.doesNotMatch(page, /[\w.+-]+@[\w-]+\.[\w.]+/);
});

test('every page these files point to exists', () => {
  for (const page of ['SECURITY.md', 'CONTRIBUTING.md'])
    for (const [, target] of read(page).matchAll(/\]\((?!https?:)([^)#]+)[^)]*\)/g))
      assert.ok(existsSync(join(repo, target!)), `${page} links to ${target}`);
});

// The front page is what a stranger reads first, so it must not claim more than the guides do.
const readme = () => read('README.md');
const row = (name: string) => {
  const line = readme()
    .split('\n')
    .find((text) => text.startsWith(`| ${name}`));
  assert.ok(line, `no table row for ${name}`);
  return line;
};

test('the README platform table says what has and has not run', () => {
  assert.match(row('macOS'), /Verified/);
  assert.match(row('Linux, systemd'), /not run/i);
  assert.match(row('Linux, Docker'), /once, on one box/);
  assert.match(row('Linux, Docker'), /No vault has been created and nobody has signed in/);
  assert.match(row('Linux, Docker'), /default setup has never run/);
  assert.match(row('Windows'), /Not started/);
  assert.match(row('Android'), /Not started/);
  // The rows rest on the guides. If a guide stops saying this, the row has to be looked at again.
  assert.match(
    read('docs/INSTALL_LINUX.md'),
    /Nothing in this guide has run on a real Linux machine/,
  );
  assert.match(read('docs/INSTALL_DOCKER.md'), /\*\*Status: run once, in part\.\*\*/);
});

test('every image and page the README points to exists', () => {
  const text = readme();
  // Markdown links and images, and the pictures placed with HTML so they can be sized.
  const targets = [
    ...[...text.matchAll(/\]\((?!https?:|#)([^)#]+)[^)]*\)/g)].map((m) => m[1]!),
    ...[...text.matchAll(/\b(?:src|srcset)="(?!https?:)([^"]+)"/g)].map((m) => m[1]!),
  ];
  // Every picture says what it shows, for people who can't see it.
  for (const tag of text.match(/<img\b[^>]*>/g) ?? []) assert.match(tag, /\balt="[^"]{10,}"/, tag);
  assert.ok(targets.includes('docs/images/banner-dark.png'));
  assert.ok(targets.some((target) => target.endsWith('.png')));
  for (const target of targets) assert.ok(existsSync(join(repo, target)), target);
});

test('the README carries the no-advice line, the network rule and the licence', () => {
  const text = readme();
  assert.match(text, /not financial advice/i);
  assert.match(text, /never places an order/i);
  assert.match(text, /api\.coinbase\.com/);
  assert.match(text, /data\.alpaca\.markets/);
  assert.match(text, /Apache License 2\.0/);
  assert.match(text, /\(LICENSE\)/);
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/);
});
