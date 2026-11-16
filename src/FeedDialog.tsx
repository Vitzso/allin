import { useState } from 'react';
import { FEEDS, type FeedName } from '../shared/feedSchema';
import { api } from './api';
import { Modal } from './components';
import { keyStoreCopy } from '../shared/keyStoreCopy';

const SENT: Record<FeedName, { receives: string; often: string }> = {
  coinbase: { receives: 'BTC-USD, ETH-USD, your IP address', often: 'About once a minute' },
  alpaca: {
    receives: 'AAPL, NVDA, MSFT, your IP address, your account key',
    often: 'About once a minute, in market hours',
  },
};

/** The turn-on dialog: what is sent and where, then the confirmation. An Alpaca key lives only here. */
export function FeedDialog({
  feed,
  hasKey,
  keyStore,
  onClose,
  onChanged,
}: {
  feed: FeedName;
  hasKey: boolean;
  keyStore: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { host, provider, terms } = FEEDS[feed],
    [keyId, setKeyId] = useState(''),
    [secret, setSecret] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function turnOn() {
    setError('');
    if (feed === 'alpaca' && !keyId.trim() !== !secret.trim()) {
      setError('Enter both the key ID and the secret.');
      return;
    }
    setBusy(true);
    try {
      const withKey = feed === 'alpaca' && keyId.trim() && secret.trim();
      await api(
        `/feeds/${feed}`,
        'POST',
        withKey ? { enabled: true, keyId: keyId.trim(), secret: secret.trim() } : { enabled: true },
      );
      // The fields clear before anything else, so the key is gone whatever the refresh does.
      setKeyId('');
      setSecret('');
      onClose();
      await onChanged().catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={`Turn on ${provider} market data`} onClose={busy ? () => undefined : onClose}>
      <p className="muted">
        Nothing is sent until you turn this on. Prices stay in your vault, and AllIn places no
        orders.
      </p>
      <dl className="feed-facts">
        <dt>Connects to</dt>
        <dd>
          <code>{host}</code>
        </dd>
        <dt>Receives</dt>
        <dd>{SENT[feed].receives}</dd>
        <dt>How often</dt>
        <dd>{SENT[feed].often}</dd>
      </dl>
      {feed === 'alpaca' && (
        <div className="form-stack">
          <p className="field-hint">
            Keys for paper trading are a good fit: they can’t touch real money.{' '}
            {keyStoreCopy(keyStore).alpacaSaved}
            {hasKey && ' A key is saved. Leave these empty to use it, or enter a new one.'}
          </p>
          <label>
            <span>Key ID</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
            />
          </label>
          <label>
            <span>Secret</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
        </div>
      )}
      <p className="field-hint">
        <a href={terms} target="_blank" rel="noreferrer noopener">
          {provider} terms
        </a>
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={busy} onClick={() => void turnOn()}>
          {busy && feed === 'alpaca' ? 'Checking key' : 'Turn on'}
        </button>
      </div>
    </Modal>
  );
}
