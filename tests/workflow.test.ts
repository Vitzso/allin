import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Text checks on the GitHub Actions workflow. It cannot run here: its first real run happens on
// GitHub, after the repo is published.
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const text = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
const lines = text.split('\n').map((line) => line.trim());

test('every action is pinned to a full commit ID', () => {
  const uses = lines.filter((line) => /^(- )?uses:/.test(line));
  assert.ok(uses.length >= 2);
  // A tag such as @v7 can be moved to other code later. A commit ID cannot.
  for (const line of uses)
    assert.match(line, /^(- )?uses: [\w./-]+@[0-9a-f]{40}( # v[\d.]+)?$/, line);
  // Only GitHub's own actions are used.
  for (const line of uses) assert.match(line, /uses: actions\//, line);
});

test('the workflow has read-only permissions and uses no secrets', () => {
  const top = text.split('\njobs:')[0]!;
  assert.match(top, /\npermissions:\n {2}contents: read\n/);
  assert.doesNotMatch(text, /:\s*write\b/);
  assert.doesNotMatch(text, /secrets\.|pull_request_target|GITHUB_TOKEN/);
  // Each checkout drops its token, so later steps can't use it.
  const checkouts = lines.filter((line) => line.includes('uses: actions/checkout@')).length;
  assert.equal(lines.filter((line) => line === 'persist-credentials: false').length, checkouts);
});

test('the workflow runs the checks the docs name, on Linux and on a Mac', () => {
  for (const command of [
    'npm ci',
    'npm run build',
    'npm test',
    'npm run test:build',
    'npx prettier --check .',
    'npm audit --omit=dev',
    'npm run test:browser',
    'npm run package:linux',
  ])
    assert.ok(
      lines.some((line) => line === `- run: ${command}` || line === `run: ${command}`),
      command,
    );
  assert.match(text, /os: \[ubuntu-24\.04, macos-latest\]/);
  // A moving Linux version could change the sandbox setting under the tests.
  assert.doesNotMatch(text, /ubuntu-latest/);
});

test('the Linux leg prepares the feed sandbox, and the browser and Docker jobs run on Linux', () => {
  const step = text.slice(text.indexOf('Allow the feed sandbox on this runner'));
  assert.match(step, /^.*\n\s+if: runner\.os == 'Linux'\n/);
  assert.match(step, /sudo apt-get install -y bubblewrap\n/);
  assert.match(step, /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0\n/);
  for (const job of ['browser', 'docker']) {
    const body = text.slice(text.indexOf(`\n  ${job}:\n`));
    assert.match(body.split('\n    steps:')[0]!, /runs-on: ubuntu-24\.04/, job);
  }
  // The wait loop must not hide a failed request behind a pipe: the default shell has no pipefail.
  assert.doesNotMatch(text, /curl[^\n]*\|/);
});

test('the Docker job starts the container with the hardening the compose file uses', () => {
  const run = lines.find((line) => line.startsWith('docker run '));
  assert.ok(run);
  for (const flag of [
    '--network host',
    '--read-only',
    '--cap-drop ALL',
    '--security-opt no-new-privileges:true',
    '--tmpfs /tmp',
  ])
    assert.ok(run.includes(flag), flag);
  assert.doesNotMatch(text, /--privileged|--cap-add/);
});
