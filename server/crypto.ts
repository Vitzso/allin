import { createCipheriv, createDecipheriv, randomBytes, scryptSync, hkdfSync } from 'node:crypto';
import { z } from 'zod';
import { MAX_BACKUP_BYTES } from '../shared/schema.ts';

const b64 = (size: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((s) => Buffer.from(s, 'base64').length === size);
export const envelopeSchema = z
  .object({
    nonce: b64(12),
    tag: b64(16),
    ciphertext: z
      .string()
      .min(1)
      .max(MAX_BACKUP_BYTES)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export type Kdf = { N: number; r: number; p: number };
export const KDF_V1: Kdf = { N: 32768, r: 8, p: 1 };
export const KDF_V2: Kdf = { N: 131072, r: 8, p: 1 };
// Parameters come from files on disk, so only known costs are accepted: a damaged or hostile file
// cannot make scrypt run for minutes or ask for gigabytes.
export const kdfSchema = z
  .object({
    N: z.union([z.literal(32768), z.literal(65536), z.literal(131072), z.literal(262144)]),
    r: z.literal(8),
    p: z.literal(1),
  })
  .strict();
export function derivePassword(password: string, salt: Buffer, kdf: Kdf = KDF_V1) {
  const { N, r, p } = kdfSchema.parse(kdf);
  return scryptSync(password, salt, 32, { N, r, p, maxmem: 256 * N * r });
}
export function domainKey(master: Buffer, domain: string) {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `allin-v1:${domain}`, 32));
}
export function seal(value: Buffer, key: Buffer, context: string): Envelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return {
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
export function unseal(value: Envelope, key: Buffer, context: string) {
  const parsed = envelopeSchema.parse(value);
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.nonce, 'base64'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(parsed.ciphertext, 'base64')), cipher.final()]);
}
const backupSchema = z.discriminatedUnion('version', [
  z
    .object({
      format: z.literal('allin-backup'),
      version: z.literal(1),
      salt: b64(16),
      payload: envelopeSchema,
    })
    .strict(),
  z
    .object({
      format: z.literal('allin-backup'),
      version: z.literal(2),
      salt: b64(16),
      kdf: kdfSchema,
      payload: envelopeSchema,
    })
    .strict(),
]);
export function encryptBackup(data: unknown, secret: string, kdf: Kdf = KDF_V2) {
  if (secret.length < 16 || secret.length > 256)
    throw new Error('Use a recovery phrase of 16–256 characters.');
  const salt = randomBytes(16);
  const key = derivePassword(secret, salt, kdf);
  try {
    return {
      format: 'allin-backup',
      version: 2,
      salt: salt.toString('base64'),
      kdf: { N: kdf.N, r: kdf.r, p: kdf.p },
      payload: seal(Buffer.from(JSON.stringify(data)), key, 'allin-backup:v2'),
    };
  } finally {
    key.fill(0);
  }
}
export function decryptBackup(value: unknown, secret: string) {
  if (secret.length < 16 || secret.length > 256) throw new Error('Invalid recovery phrase.');
  const backup = backupSchema.parse(value);
  // Version 1 backups predate recorded parameters and always used KDF_V1.
  const [kdf, context] =
    backup.version === 1 ? [KDF_V1, 'allin-backup:v1'] : [backup.kdf, 'allin-backup:v2'];
  const key = derivePassword(secret, Buffer.from(backup.salt, 'base64'), kdf);
  let clear: Buffer | undefined;
  try {
    clear = unseal(backup.payload, key, context);
    return JSON.parse(clear.toString('utf8'));
  } finally {
    key.fill(0);
    clear?.fill(0);
  }
}
