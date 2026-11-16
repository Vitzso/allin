import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A throwaway self-signed certificate for tests only. It is valid for one day, never leaves the
// temp folder it is given, and protects nothing.
export function makeCertificate(dir: string, name: string): { cert: Buffer; key: Buffer } {
  const cert = join(dir, `${name}.crt`),
    key = join(dir, `${name}.key`);
  // A config file works on every OpenSSL and LibreSSL; older ones lack -addext.
  const conf = join(dir, `${name}.cnf`);
  writeFileSync(
    conf,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${name}\n[ext]\nsubjectAltName=DNS:${name}\n`,
  );
  execFileSync(
    'openssl',
    [
      ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'],
      ...['-keyout', key, '-out', cert, '-days', '1', '-config', conf],
    ],
    { stdio: 'pipe' },
  );
  return { cert: readFileSync(cert), key: readFileSync(key) };
}
