import { useState, type FormEvent } from 'react';
import { ArrowRight, ShieldCheck, LockKeyhole, FolderLock, Download, KeyRound } from 'lucide-react';
import { Modal, PrivateNote } from './components';
import { api, fetchStatus, setAuthenticatedToken } from './api';
import { MAX_BACKUP_BYTES } from '../shared/schema';
import { keyStoreCopy } from '../shared/keyStoreCopy';

export function VaultForm({
  initialized,
  keyStore,
  onSuccess,
  onClose,
}: {
  initialized: boolean;
  /** The key store label from the status, which names where the device secret is kept. */
  keyStore: string;
  onSuccess: () => Promise<void>;
  onClose?: () => void;
}) {
  const [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(''),
    [secret, setSecret] = useState(''),
    [restore, setRestore] = useState(false),
    [backup, setBackup] = useState<unknown>(),
    [filename, setFilename] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!initialized && password !== confirm) {
      setError('The passphrases don’t match.');
      return;
    }
    setBusy(true);
    try {
      await fetchStatus();
      const result = await api<{ csrf: string }>(
        `/vault/${initialized ? 'unlock' : restore ? 'restore' : 'setup'}`,
        'POST',
        { password, ...(restore ? { backup, secret } : {}) },
      );
      setAuthenticatedToken(result.csrf);
      setPassword('');
      setConfirm('');
      setSecret('');
      setBackup(undefined);
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="vault-form">
      <div className="vault-emblem">
        <FolderLock size={30} />
      </div>
      <h2>
        {initialized
          ? 'Welcome back to your space.'
          : restore
            ? 'Bring your space with you.'
            : 'A private space. Yours alone.'}
      </h2>
      <p>
        {initialized
          ? 'Unlock your local vault to pick up where you left off.'
          : restore
            ? 'Restore an encrypted AllIn backup into this new profile.'
            : keyStoreCopy(keyStore).setup}
      </p>
      <form onSubmit={submit} className="form-stack">
        <label>
          {initialized ? 'Your passphrase' : 'Choose a passphrase'}
          <input
            autoFocus
            required
            type="password"
            autoComplete={initialized ? 'current-password' : 'new-password'}
            minLength={12}
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 12 characters"
          />
        </label>
        {!initialized && (
          <label>
            Confirm passphrase
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="One more time"
            />
          </label>
        )}
        {restore && (
          <>
            <label>
              Encrypted backup
              <input
                type="file"
                accept=".allin-backup,.json"
                required
                onChange={async (e) => {
                  setError('');
                  setBackup(undefined);
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > MAX_BACKUP_BYTES) {
                    setError('Choose a backup smaller than 24 MB.');
                    return;
                  }
                  try {
                    setBackup(JSON.parse(await file.text()));
                    setFilename(file.name);
                  } catch {
                    setError('That file is not a valid encrypted backup.');
                  }
                }}
              />
              {filename && <span className="field-hint">{filename}</span>}
            </label>
            <label>
              Backup recovery phrase
              <input
                type="password"
                autoComplete="off"
                required
                minLength={16}
                maxLength={256}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full-width" disabled={busy || (restore && !backup)}>
          {busy
            ? 'Opening your space…'
            : initialized
              ? 'Unlock vault'
              : restore
                ? 'Restore my vault'
                : 'Create my vault'}
          <ArrowRight size={16} />
        </button>
        {!initialized && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setRestore(!restore);
              setError('');
            }}
          >
            {restore ? 'Start with an empty vault' : 'I have an encrypted backup'}
          </button>
        )}
        {onClose && (
          <button type="button" className="text-button muted" onClick={onClose}>
            Keep exploring the preview
          </button>
        )}
      </form>
      <PrivateNote />
      <div className="vault-caveat">
        <ShieldCheck size={15} />
        <span>
          Foundation release · market feeds stay off until you turn them on, and AI connections are
          disabled. OpenFit import is by hand, from a file you choose. Keep your passphrase safe;
          there is no cloud recovery.
        </span>
      </div>
    </div>
  );
}
export function BackupDialog({ onClose }: { onClose: () => void }) {
  const [secret, setSecret] = useState(''),
    [confirm, setConfirm] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (secret !== confirm) {
      setError('The recovery phrases don’t match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const encrypted = await api('/vault/backup', 'POST', { secret });
      const blob = new Blob([JSON.stringify(encrypted)], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `allin-${new Date().toISOString().slice(0, 10)}.allin-backup`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSecret('');
      setConfirm('');
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="A safe copy of your space" onClose={onClose}>
      <div className="icon-tile mint">
        <KeyRound size={22} />
      </div>
      {done ? (
        <div className="form-stack">
          <h3>Your encrypted backup is ready.</h3>
          <p className="muted">
            Keep the recovery phrase separately. Restore uses both the file and phrase, and creates
            a new device key on the new Mac.
          </p>
          <button className="button primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          <p className="muted">
            Your tasks, Health summaries, and preferences are encrypted before download. Choose a
            separate recovery phrase; it will never be saved by AllIn.
          </p>
          <label>
            Recovery phrase
            <input
              autoFocus
              type="password"
              autoComplete="new-password"
              required
              minLength={16}
              maxLength={256}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="At least 16 characters"
            />
          </label>
          <label>
            Confirm recovery phrase
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <p className="field-hint">
            Store this phrase somewhere safe. A lost phrase cannot be reset. Deleting a task or
            purging Health data later does not remove it from older backups.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy}>
            <Download size={16} />
            {busy ? 'Encrypting…' : 'Download encrypted backup'}
          </button>
        </form>
      )}
    </Modal>
  );
}
