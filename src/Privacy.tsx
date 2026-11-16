import { useEffect, useState } from 'react';
import {
  ShieldCheck,
  LockKeyhole,
  Database,
  HeartPulse,
  TrendingUp,
  BrainCircuit,
  Download,
  Globe2,
  ChevronRight,
  WifiOff,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import type { Settings } from '../shared/schema';
import { FEEDS, type FeedName, type FeedState, type FeedStatus } from '../shared/feedSchema';
import type { HealthSummary } from '../shared/healthSchema';
import { formatInstant } from '../shared/healthViews';
import { api } from './api';
import { Badge, SectionHeader, Empty, TextLink, Modal } from './components';
import { FeedDialog } from './FeedDialog';
import { Sessions } from './Sessions';
import { keyStoreCopy } from '../shared/keyStoreCopy';

const STATE_TEXT: Record<FeedState, string> = {
  off: 'Off',
  'catching-up': 'Catching up',
  live: 'Live',
  stale: 'Stale',
  closed: 'Market closed',
  paused: 'Paused',
  failing: 'Failing',
};
type Integration = {
  icon: LucideIcon;
  name: string;
  description: string;
  status: string;
  categories: string;
  destination: string;
  lastAccess: string;
  categoriesLabel?: string;
  accessLabel?: string;
  manage?: boolean;
  feed?: FeedStatus;
};
const FEED_ORDER: FeedName[] = ['coinbase', 'alpaca'];
const offStatus = (feed: FeedName): FeedStatus => ({
  feed,
  enabled: false,
  state: 'off',
  failure: null,
  hasKey: false,
  lastUpdate: null,
  lastBarAt: null,
});
export function Privacy({
  demo,
  onSetup,
  onBackup,
  onLock,
  settings,
  saveSettings,
  healthSummary,
  healthSummaryError,
  onOpenHealth,
  feeds,
  onFeedsChanged,
  keyStore,
}: {
  demo: boolean;
  onSetup: () => void;
  onBackup: () => void;
  onLock: () => void;
  settings: Settings;
  saveSettings: (s: Settings) => Promise<void>;
  healthSummary: HealthSummary | null;
  /** Set when the summary could not be read, so the status is unknown rather than empty. */
  healthSummaryError: string;
  onOpenHealth: () => void;
  feeds: FeedStatus[];
  onFeedsChanged: () => Promise<void>;
  /** The key store label from the status. */
  keyStore: string;
}) {
  const [events, setEvents] = useState<{ at: string; action: string; outcome: string }[]>([]),
    [error, setError] = useState(''),
    [feedDialog, setFeedDialog] = useState<FeedName | null>(null),
    [purging, setPurging] = useState(false),
    [feedBusy, setFeedBusy] = useState(false),
    [feedError, setFeedError] = useState('');
  useEffect(() => {
    if (!demo)
      void api<typeof events>('/events')
        .then(setEvents)
        .catch((e) => setError(e.message));
  }, [demo]);
  async function feedAction(path: string, body: unknown) {
    setFeedBusy(true);
    setFeedError('');
    try {
      await api(path, 'POST', body);
      await onFeedsChanged();
      return true;
    } catch (e) {
      setFeedError((e as Error).message);
      return false;
    } finally {
      setFeedBusy(false);
    }
  }
  const unknown = !demo && !!healthSummaryError;
  const imported = healthSummary?.state === 'imported';
  const keptCategories = ['workouts', 'weight']
    .filter((category) => healthSummary?.coverage.some((c) => c.category === category))
    .map((category) => (category === 'workouts' ? 'Workouts' : 'Weight'));
  const integrations: Integration[] = [
    ...FEED_ORDER.map((name) => {
      const status = feeds.find((f) => f.feed === name) ?? offStatus(name),
        { provider, host, symbols } = FEEDS[name],
        on = status.enabled;
      return {
        icon: TrendingUp,
        name: `${provider} market data`,
        description: `${symbols.join(', ')} · ${host}`,
        status: STATE_TEXT[status.state],
        categories: on
          ? [
              ...symbols,
              'your IP address',
              ...(name === 'alpaca' ? ['your account key'] : []),
            ].join(', ')
          : 'None',
        destination: on ? host : 'None',
        lastAccess: status.lastUpdate
          ? formatInstant(status.lastUpdate, settings.timezone)
          : 'Never',
        feed: status,
      };
    }),
    {
      icon: HeartPulse,
      name: 'OpenFit',
      description: 'Manual file import · no database access',
      status: unknown ? 'Status unavailable' : imported ? 'Imported' : 'Not imported',
      categories: unknown
        ? 'Unknown'
        : imported && keptCategories.length
          ? keptCategories.join(', ')
          : 'None',
      destination: 'Local file only',
      lastAccess: unknown
        ? 'Unknown'
        : imported && healthSummary.importedAt
          ? formatInstant(healthSummary.importedAt, settings.timezone)
          : 'Never',
      categoriesLabel: 'Kept',
      accessLabel: 'Last import',
      manage: true,
    },
    {
      icon: BrainCircuit,
      name: 'Local AI',
      description: 'No model running · no tools or prompt retention',
      status: 'Disabled',
      categories: 'None',
      destination: 'None enabled',
      lastAccess: 'Never',
    },
    {
      icon: Globe2,
      name: 'Analytics & cloud services',
      description: 'No tracking, telemetry, or cloud crash reporting',
      status: 'Off',
      categories: 'None',
      destination: 'None',
      lastAccess: 'Never',
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PRIVATE BY DEFAULT</div>
          <h1>Your data. Your boundaries.</h1>
          <p>See what’s connected, what’s shared, and what stays with you.</p>
        </div>
        <Badge tone="green" dot>
          Offline profile
        </Badge>
      </div>
      <div className="privacy-hero">
        <span className="privacy-large-icon">
          <ShieldCheck size={35} />
        </span>
        <div>
          <h2>
            {demo
              ? 'Explore first. Make it yours when you’re ready.'
              : 'Your vault is open on this device.'}
          </h2>
          <p>
            {demo
              ? 'The preview uses synthetic data. Creating a vault starts with an empty task inbox.'
              : keyStoreCopy(keyStore).privacy}
          </p>
        </div>
        <button className="button primary" onClick={demo ? onSetup : onLock}>
          {demo ? 'Create my vault' : 'Lock vault'}
          <LockKeyhole size={15} />
        </button>
      </div>
      <div className="card integrations">
        <SectionHeader
          title="Connections & permissions"
          action={
            <Badge>
              {feeds.some((f) => f.enabled) ? 'Market data feeds on' : 'No outbound app traffic'}
            </Badge>
          }
        />
        {feedError && (
          <p role="alert" className="form-error">
            {feedError}
          </p>
        )}
        {integrations.map((item) => {
          const feed = item.feed;
          return (
            <div className="integration-row" key={item.name}>
              <span className="icon-tile neutral">
                <item.icon size={21} />
              </span>
              <div className="integration-info">
                <strong>{item.name}</strong>
                <p>{item.description}</p>
                <div>
                  <span>
                    {item.categoriesLabel ?? 'Shared'}: <b>{item.categories}</b>
                  </span>
                  <span>
                    Destination: <b>{item.destination}</b>
                  </span>
                  <span>
                    {item.accessLabel ?? 'Last access'}: <b>{item.lastAccess}</b>
                  </span>
                </div>
                {item.manage && <TextLink onClick={onOpenHealth}>Manage in Health</TextLink>}
                {feed && (
                  <div className="feed-actions">
                    {feed.enabled ? (
                      <button
                        className="button secondary"
                        disabled={feedBusy}
                        onClick={() => void feedAction(`/feeds/${feed.feed}`, { enabled: false })}
                      >
                        Turn off
                      </button>
                    ) : (
                      <button
                        className="button secondary"
                        onClick={demo ? onSetup : () => setFeedDialog(feed.feed)}
                      >
                        Turn on
                      </button>
                    )}
                    {feed.feed === 'alpaca' && feed.hasKey && (
                      <button
                        className="button secondary"
                        disabled={feedBusy}
                        onClick={() => void feedAction('/feeds/alpaca/remove-key', {})}
                      >
                        Remove key
                      </button>
                    )}
                  </div>
                )}
              </div>
              <Badge>{item.status}</Badge>
            </div>
          );
        })}
      </div>
      {!demo && (
        <div className="feed-purge">
          <button
            className="button secondary"
            onClick={() => {
              setFeedError('');
              setPurging(true);
            }}
          >
            Delete saved market data
          </button>
          <p className="field-hint">
            Turning a feed off keeps the bars and alerts it saved. This removes them.
          </p>
        </div>
      )}
      {feedDialog && (
        <FeedDialog
          feed={feedDialog}
          hasKey={feeds.find((f) => f.feed === feedDialog)?.hasKey ?? false}
          keyStore={keyStore}
          onClose={() => setFeedDialog(null)}
          onChanged={onFeedsChanged}
        />
      )}
      {purging && (
        <Modal title="Delete saved market data?" onClose={() => setPurging(false)}>
          <p className="muted">
            This removes the market bars and alerts AllIn saved. Feeds that are on will fetch recent
            bars again. {keyStoreCopy(keyStore).alpacaKept}
          </p>
          {feedError && (
            <p role="alert" className="form-error">
              {feedError}
            </p>
          )}
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setPurging(false)}>
              Cancel
            </button>
            <button
              className="button danger"
              disabled={feedBusy}
              onClick={() =>
                void feedAction('/feeds/purge', {}).then((ok) => ok && setPurging(false))
              }
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
      {!demo && <Sessions timezone={settings.timezone} />}
      <div className="privacy-bottom">
        <div className="card padded">
          <SectionHeader title="Backup & recovery" />
          <div className="icon-tile lavender">
            <Database size={22} />
          </div>
          <h3>A safe copy, under your control.</h3>
          <p className="muted">
            Export tasks, Health summaries, and preferences as an authenticated, encrypted backup
            with a separate recovery phrase.
          </p>
          <button className="button secondary" onClick={demo ? onSetup : onBackup}>
            <Download size={16} />
            {demo ? 'Set up vault first' : 'Export encrypted backup'}
          </button>
          <p className="field-hint">
            Restore into a clean AllIn profile. A wrong phrase or damaged file is rejected before
            any data is written.
          </p>
        </div>
        <div className="card padded">
          <SectionHeader title="Make yourself at home" />
          <label className="form-stack">
            <span>Display timezone</span>
            <select
              value={settings.timezone}
              onChange={async (e) => {
                try {
                  await saveSettings({ ...settings, timezone: e.target.value });
                  setError('');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {[
                'Asia/Jerusalem',
                'America/New_York',
                'America/Los_Angeles',
                'Europe/London',
                'Europe/Paris',
                'Asia/Tokyo',
                'Australia/Sydney',
                'UTC',
              ].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <p className="field-hint">
            Market bars remain in UTC. This changes display times, not exchange sessions.
          </p>
          <label className="form-stack">
            <span>Week starts on</span>
            <select
              value={settings.weekStart}
              onChange={async (e) => {
                try {
                  await saveSettings({ ...settings, weekStart: Number(e.target.value) });
                  setError('');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                (name, value) => (
                  <option key={name} value={value}>
                    {name}
                  </option>
                ),
              )}
            </select>
          </label>
          <div className="setting-line">
            <span>Market currency</span>
            <Badge>{feeds.some((f) => f.enabled) ? 'USD' : 'USD · fixture'}</Badge>
          </div>
          <div className="setting-line">
            <span>Conversation retention</span>
            <Badge tone="green">Off</Badge>
          </div>
          <div className="setting-line">
            <span>Automatic locking</span>
            <Badge>15 minutes idle</Badge>
          </div>
        </div>
      </div>
      <div className="card padded">
        <SectionHeader title="Local activity" action={<Badge>Minimal history</Badge>} />
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {events.length ? (
          <div className="event-list">
            {events.map((e, i) => (
              <div key={i}>
                <ShieldCheck size={15} />
                <span>{e.action.replaceAll('.', ' · ')}</span>
                <Badge tone="green">{e.outcome}</Badge>
                <time>
                  {new Date(e.at).toLocaleString('en-US', { timeZone: settings.timezone })}
                </time>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">
            {demo ? 'A vault is needed to record local activity.' : 'No activity yet.'} Only action
            type, outcome, and time are retained. No task titles, prompts, or secrets.
          </p>
        )}
      </div>
      <div className="release-note">
        <InfoText />
      </div>
    </>
  );
}
function InfoText() {
  return (
    <>
      <LockKeyhole size={15} />
      <p>
        Foundation release: verified on this Mac. OS-enforced connector isolation, signed packaging,
        key rotation, and full disk/network audits remain release gates. An unlocked or compromised
        host can access data in memory.
      </p>
    </>
  );
}
