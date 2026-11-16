import { BlockList, isIP } from 'node:net';
import { resolve } from 'node:path';

export class ConfigError extends Error {}
export type Config = {
  port: number;
  listen: string;
  origin: string; // normalised, no trailing slash
  network: boolean; // listen !== '127.0.0.1'
  tls?: { cert: string; key: string }; // file paths
  dataDir: string; // absolute
  keystoreDir?: string; // absolute
};
export type HostFacts = {
  platform: NodeJS.Platform;
  homedir: string;
  cwd: string;
  addresses: string[]; // every address on this host
  mode(path: string): number | null; // permission bits, null if missing
};

const LOOPBACK = '127.0.0.1';
const privateRanges = new BlockList();
for (const [net, bits] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
] as const)
  privateRanges.addSubnet(net, bits, 'ipv4');
privateRanges.addSubnet('fc00::', 7, 'ipv6');

const fail = (message: string): never => {
  throw new ConfigError(message);
};

export function readConfig(env: Record<string, string | undefined>, host: HostFacts): Config {
  // An empty variable counts as unset, except for the two folders below.
  const get = (name: string) => (env[name] === '' ? undefined : env[name]);
  if (host.platform !== 'darwin' && host.platform !== 'linux')
    fail('AllIn runs on macOS and Linux only.');
  const rawPort = get('ALLIN_PORT') ?? '4310';
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    fail('ALLIN_PORT must be between 1024 and 65535.');
  const listen = get('ALLIN_LISTEN') ?? LOOPBACK;
  const family = isIP(listen);
  if (
    !family ||
    listen.includes('%') ||
    /^::ffff:/i.test(listen) ||
    /^(0\.0\.0\.0|::|(0*:)+0*)$/.test(listen)
  )
    fail('ALLIN_LISTEN must be one address, not a wildcard.');
  const network = listen !== LOOPBACK;
  if (network && !privateRanges.check(listen, family === 6 ? 'ipv6' : 'ipv4'))
    fail('ALLIN_LISTEN must be 127.0.0.1 or a private address, such as your WireGuard address.');
  const lower = listen.toLowerCase();
  if (!host.addresses.some((a) => a.toLowerCase() === lower))
    fail('ALLIN_LISTEN is not an address on this machine.');
  const rawOrigin = get('ALLIN_ORIGIN'),
    cert = get('ALLIN_TLS_CERT'),
    key = get('ALLIN_TLS_KEY');
  let origin = `http://${LOOPBACK}:${port}`,
    tls: Config['tls'];
  if (!network) {
    if (rawOrigin || cert || key)
      fail('ALLIN_ORIGIN and the TLS settings apply only when ALLIN_LISTEN is a private address.');
  } else {
    if (!rawOrigin || !cert || !key)
      fail('Set ALLIN_ORIGIN, ALLIN_TLS_CERT and ALLIN_TLS_KEY to listen on a private address.');
    const shape = 'ALLIN_ORIGIN must look like https://host:port, with nothing after the port.';
    let url: URL;
    try {
      url = new URL(rawOrigin!);
    } catch {
      return fail(shape);
    }
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      /[?#]/.test(rawOrigin!) ||
      url.username ||
      url.password
    )
      fail(shape);
    // An implicit port means 443, which ALLIN_PORT can never be.
    if (Number(url.port || 443) !== port) fail('The port in ALLIN_ORIGIN must match ALLIN_PORT.');
    origin = url.origin;
    tls = { cert: resolve(host.cwd, cert!), key: resolve(host.cwd, key!) };
    const keyMode = host.mode(tls.key);
    if (host.mode(tls.cert) === null || keyMode === null)
      fail('The TLS certificate or key file was not found.');
    if ((keyMode! & 0o077) !== 0)
      fail('The TLS key file must be readable only by its owner (chmod 600).');
  }
  // Not counted as unset: an empty data folder would mean the default, the real profile on a Mac.
  if (env.ALLIN_DATA_DIR === '' || env.ALLIN_KEYSTORE_DIR === '')
    fail('ALLIN_DATA_DIR and ALLIN_KEYSTORE_DIR must not be empty when set.');
  const data = get('ALLIN_DATA_DIR'),
    keystore = get('ALLIN_KEYSTORE_DIR');
  if (host.platform === 'linux' && (!data || !keystore))
    fail('On Linux, set ALLIN_DATA_DIR and ALLIN_KEYSTORE_DIR.');
  return {
    port,
    listen,
    origin,
    network,
    tls,
    dataDir: resolve(host.cwd, data ?? resolve(host.homedir, 'Library/Application Support/AllIn')),
    keystoreDir: keystore ? resolve(host.cwd, keystore) : undefined,
  };
}
