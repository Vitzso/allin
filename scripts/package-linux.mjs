import { cpSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Builds <outDir>/allin-linux-<version>/ from an existing build and returns its path. It holds
// the compiled app, the install files and the guides, and never a key, data or certificate.
export function packageLinux(outDir) {
  for (const folder of ['build', 'dist'])
    if (!existsSync(join(repo, folder)))
      throw new Error(`${folder}/ is missing. Run npm run build first.`);
  const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const release = join(resolve(outDir), `allin-linux-${version}`);
  rmSync(release, { recursive: true, force: true });
  mkdirSync(release, { recursive: true });
  const entries = [
    ['build', 'build'],
    ['dist', 'dist'],
    ['package.json', 'package.json'],
    ['package-lock.json', 'package-lock.json'],
    ['scripts/install-linux.sh', 'install-linux.sh'],
    ['scripts/allin.service', 'allin.service'],
    ['scripts/allin.env.example', 'allin.env.example'],
    ['docs/INSTALL_LINUX.md', 'INSTALL_LINUX.md'],
    // The Docker install builds from this same folder, which later also holds tls/ and
    // docker.env. The .dockerignore keeps the build context to what the image copies.
    ['scripts/Dockerfile', 'Dockerfile'],
    ['scripts/dockerignore', '.dockerignore'],
    ['scripts/compose.yaml', 'compose.yaml'],
    // For a box where WireGuard runs in a container: an override and the settings that load it.
    ['scripts/compose.wireguard.yaml', 'compose.wireguard.yaml'],
    ['scripts/compose.env.example', 'compose.env.example'],
    ['scripts/docker.env.example', 'docker.env.example'],
    ['docs/INSTALL_DOCKER.md', 'INSTALL_DOCKER.md'],
  ];
  for (const [from, to] of entries)
    cpSync(join(repo, from), join(release, to), { recursive: true });
  return release;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(packageLinux(join(repo, 'release')));
