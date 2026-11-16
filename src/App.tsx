import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  ArrowRight,
  Activity,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Command,
  HeartPulse,
  Inbox,
  LayoutGrid,
  LockKeyhole,
  Menu,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sprout,
  Sun,
  TrendingUp,
  X,
  WifiOff,
  Clock3,
  CirclePause,
  PanelLeftClose,
} from 'lucide-react';
import { api, fetchStatus, setAuthenticatedToken } from './api';
import {
  type Task,
  type TaskInput,
  type Settings,
  type SessionState,
  taskInputSchema,
} from '../shared/schema';
import { demoTasks, type MarketInstrument, FIXTURE_AT } from '../shared/fixtures';
import type { FeedStatus, MarketAlert } from '../shared/feedSchema';
import { adjustmentFor, nextPriorities } from '../shared/taskViews';
import {
  Badge,
  Change,
  Empty,
  Modal,
  PrivateNote,
  Provenance,
  SectionHeader,
  Sparkline,
  TextLink,
} from './components';
import { TaskEditor, TaskRow, Tasks, type TaskActions } from './Tasks';
import { MarketDisclaimer, Markets, Watchlist, allLive } from './Markets';
import { MarketAlerts } from './MarketAlerts';
import { sourceSummary } from '../shared/feedViews';
import { Health } from './Health';
import { HealthImport } from './HealthImport';
import { HealthGlanceCard, HealthMovementCard } from './HealthToday';
import type { HealthData } from './HealthPreview';
import type { HealthSummary } from '../shared/healthSchema';
import { Review } from './Review';
import { Privacy } from './Privacy';
import { BackupDialog, VaultForm } from './VaultScreen';

type Page = 'Today' | 'Markets' | 'Health' | 'Tasks' | 'Weekly review' | 'Connections & privacy';
const nav = [
  { name: 'Today', icon: LayoutGrid },
  { name: 'Markets', icon: ChartNoAxesCombined },
  { name: 'Health', icon: HeartPulse },
  { name: 'Tasks', icon: CheckCheck },
  { name: 'Weekly review', icon: CalendarDays },
] as const;
type MarketData = { instruments: MarketInstrument[]; feeds: FeedStatus[]; alerts: MarketAlert[] };
const noMarkets: MarketData = { instruments: [], feeds: [], alerts: [] };
const defaultSettings: Settings = {
  timezone: 'Asia/Jerusalem',
  weekAdjustment: '',
  adjustmentWeek: null,
  weekStart: 1,
};
export default function App() {
  const [page, setPage] = useState<Page>('Today'),
    [session, setSession] = useState<SessionState | null>(null),
    [tasks, setTasks] = useState<Task[]>([]),
    [settings, setSettings] = useState<Settings>(defaultSettings),
    [marketData, setMarketData] = useState(noMarkets),
    [health, setHealth] = useState<HealthData | null>(null),
    [marketError, setMarketError] = useState(''),
    [healthError, setHealthError] = useState(''),
    [healthSummary, setHealthSummary] = useState<HealthSummary | null>(null),
    [healthSummaryError, setHealthSummaryError] = useState(''),
    [importOpen, setImportOpen] = useState(false),
    [taskError, setTaskError] = useState(''),
    [appError, setAppError] = useState(''),
    [toast, setToast] = useState(''),
    [editor, setEditor] = useState<Task | null | undefined>(),
    [vaultModal, setVaultModal] = useState(false),
    [backup, setBackup] = useState(false),
    [help, setHelp] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [selected, setSelected] = useState('AAPL'),
    [taskFilter, setTaskFilter] = useState('Inbox'),
    [search, setSearch] = useState('');
  const markets = marketData.instruments,
    anyLive = markets.some((m) => m.source.kind === 'live'),
    // With mixed rows, Today's setup count is for live rows only, so replay setups don't add in.
    counted = anyLive ? markets.filter((m) => m.source.kind === 'live') : markets,
    summary = sourceSummary(markets.map((m) => m.source));
  const demo = !!session && !session.initialized;
  const healthProps = {
    demo,
    preview: health,
    previewError: healthError,
    summary: healthSummary,
    summaryError: healthSummaryError,
    timezone: settings.timezone,
    onOpen: () => go('Health'),
  };
  const privateGeneration = useRef(0);
  const [tasksReadAt, setTasksReadAt] = useState<string | null>(null);
  const captureAttempt = useRef<{ payload: string; id: string } | null>(null);
  const go = (next: Page) => {
    setPage(next);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const notify = (message: string) => {
    setToast(message);
  };
  async function refreshTasks() {
    const generation = privateGeneration.current;
    const loaded = await api<Task[]>('/tasks');
    if (generation === privateGeneration.current) {
      setTasks(loaded);
      setTasksReadAt(new Date().toISOString());
    }
  }
  // The latest read wins, and a read that started before a lock is dropped.
  const marketRead = useRef(0);
  async function refreshMarkets() {
    const generation = privateGeneration.current,
      read = ++marketRead.current;
    const settled = () => generation === privateGeneration.current && read === marketRead.current;
    try {
      const loaded = session?.unlocked
        ? await api<MarketData>('/markets')
        : { ...noMarkets, instruments: await api<MarketInstrument[]>('/demo/markets') };
      if (!settled()) return;
      setMarketData(loaded);
      setMarketError('');
    } catch (e) {
      if (!settled()) return;
      // Rows from before the failure would keep saying how fresh they were.
      setMarketData(noMarkets);
      setMarketError((e as Error).message);
    }
  }
  async function dismissAlerts(input: { id: string } | { ids: string[] }) {
    try {
      await api('/alerts/dismiss', 'POST', input);
      await refreshMarkets();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function refreshHealth() {
    const generation = privateGeneration.current;
    try {
      const loaded = await api<HealthSummary>('/health/summary');
      if (generation !== privateGeneration.current) return;
      setHealthSummary(loaded);
      setHealthSummaryError('');
    } catch (e) {
      if (generation !== privateGeneration.current) return;
      setHealthSummary(null);
      setHealthSummaryError((e as Error).message);
    }
  }
  async function loadSession() {
    const status = await fetchStatus();
    setSession(status);
    setAppError('');
    if (status.unlocked) {
      const generation = privateGeneration.current;
      await Promise.allSettled([
        refreshTasks().catch((e) => setTaskError(e.message)),
        api<Settings>('/settings')
          .then((s) => {
            if (generation === privateGeneration.current) setSettings(s);
          })
          .catch((e) => setTaskError(e.message)),
      ]);
    } else if (!status.initialized) {
      setTasks(structuredClone(demoTasks));
      setSettings(defaultSettings);
    } else {
      setTasks([]);
      setSettings(defaultSettings);
    }
  }
  useEffect(() => {
    void loadSession().catch((e) => setAppError(e.message));
    void api<HealthData>('/demo/health')
      .then(setHealth)
      .catch((e) => setHealthError(e.message));
  }, []);
  // Today and Markets read on arrival and every 30 seconds, from the vault once unlocked.
  // Connections & privacy reads too, so a feed's status there follows it, quickly while one catches up.
  const marketsVisible =
      page === 'Today' || page === 'Markets' || (page === 'Connections & privacy' && !demo),
    settling =
      page === 'Connections & privacy' &&
      marketData.feeds.some((f) => f.enabled && f.state === 'catching-up'),
    sessionKnown = session !== null;
  useEffect(() => {
    if (!sessionKnown || !marketsVisible) return;
    void refreshMarkets();
    const timer = setInterval(() => void refreshMarkets(), settling ? 2000 : 30000);
    return () => clearInterval(timer);
  }, [page, sessionKnown, session?.unlocked, settling]);
  useEffect(() => {
    if (session?.unlocked) void refreshHealth();
  }, [page, session?.unlocked]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4200);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const clearPrivate = () => {
      privateGeneration.current++;
      setTasks([]);
      setSettings(defaultSettings);
      setEditor(undefined);
      setBackup(false);
      setHealthSummary(null);
      setHealthSummaryError('');
      setMarketData(noMarkets);
      setMarketError('');
      setImportOpen(false);
      setToast('');
      setSearch('');
      setSession((s) => (s ? { ...s, unlocked: false } : s));
    };
    const check = () => {
      void fetchStatus()
        .then((s) => {
          if (!s.unlocked && s.initialized) clearPrivate();
          setSession(s);
        })
        .catch(() => {
          if (session?.unlocked) {
            clearPrivate();
            setAppError('The local service is unavailable. Your on-screen vault has been locked.');
          }
        });
    };
    const interval = setInterval(check, 15000);
    window.addEventListener('allin-locked', clearPrivate);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener('allin-locked', clearPrivate);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session?.unlocked]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (demo || session?.unlocked) setEditor(null);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [demo, session?.unlocked]);
  const actions: TaskActions = {
    create: async (input) => {
      setTaskError('');
      const data = taskInputSchema.parse(input);
      if (demo) {
        const task: Task = {
          ...data,
          id: crypto.randomUUID(),
          version: 1,
          createdAt: new Date().toISOString(),
          completedAt: null,
        };
        setTasks((current) => [task, ...current]);
        notify('Added to the preview inbox');
      } else {
        const payload = JSON.stringify(data);
        if (captureAttempt.current?.payload !== payload)
          captureAttempt.current = { payload, id: crypto.randomUUID() };
        await api('/tasks', 'POST', { task: data, id: captureAttempt.current.id });
        captureAttempt.current = null;
        await refreshTasks();
        notify('Saved to your inbox');
      }
    },
    update: async (task, changes) => {
      setTaskError('');
      if (demo) {
        setTasks((current) =>
          current.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  ...changes,
                  version: t.version + 1,
                  completedAt:
                    changes.status === 'done'
                      ? new Date().toISOString()
                      : changes.status === 'open'
                        ? null
                        : t.completedAt,
                }
              : t,
          ),
        );
        notify(
          changes.status === 'done' ? 'One step forward. Nicely done.' : 'Preview task updated',
        );
      } else {
        try {
          await api(`/tasks/${task.id}`, 'PATCH', { version: task.version, changes });
          await refreshTasks();
          notify(changes.status === 'done' ? 'One step forward. Nicely done.' : 'Task updated');
        } catch (e) {
          await refreshTasks().catch(() => {});
          throw e;
        }
      }
    },
    remove: async (task) => {
      if (demo) setTasks((current) => current.filter((t) => t.id !== task.id));
      else {
        await api(`/tasks/${task.id}`, 'DELETE', { version: task.version });
        await refreshTasks();
      }
      notify('Task deleted');
    },
  };
  const saveSettings = async (value: Settings) => {
    if (!demo) await api('/settings', 'POST', value);
    setSettings(value);
  };
  async function lock() {
    privateGeneration.current++;
    setTasks([]);
    setEditor(undefined);
    setBackup(false);
    setHealthSummary(null);
    setHealthSummaryError('');
    setMarketData(noMarkets);
    setMarketError('');
    setImportOpen(false);
    setSettings(defaultSettings);
    try {
      await api('/vault/lock', 'POST', {});
      setAuthenticatedToken('');
      await loadSession();
    } catch (e) {
      setSession((s) => (s ? { ...s, unlocked: false } : s));
      setAppError((e as Error).message);
    }
  }
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
  const timeLabel = tasksReadAt
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: settings.timezone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(tasksReadAt))
    : 'not loaded';
  const openTasks = tasks.filter((t) => t.status === 'open');
  const adjustment = adjustmentFor(settings, today);
  if (!session)
    return (
      <div className="loading-screen">
        <Logo />
        <div className="loading-orbit" />
        <h2>{appError ? 'Let’s reconnect.' : 'Opening your space…'}</h2>
        <p>{appError || 'Private. Local. A little more intentional.'}</p>
        {appError && (
          <button
            className="button primary"
            onClick={() => void loadSession().catch((e) => setAppError(e.message))}
          >
            Try again
          </button>
        )}
      </div>
    );
  if (session.initialized && !session.unlocked)
    return (
      <div className="lock-screen">
        <div className="lock-brand">
          <Logo />
          <Badge tone="green">
            <WifiOff size={12} />
            Offline
          </Badge>
        </div>
        <div className="lock-panel">
          <VaultForm
            initialized
            keyStore={session.keyStore}
            onSuccess={async () => {
              await loadSession();
              go('Today');
            }}
          />
          {appError && <p className="form-error">{appError}</p>}
        </div>
        <p className="lock-footer">ALLIN · A LITTLE MORE INTENTION, EVERY DAY.</p>
      </div>
    );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <button className="logo-button" onClick={() => go('Today')} aria-label="AllIn home">
          <Logo />
        </button>
        <div className="workspace-label">YOUR PERSONAL SPACE</div>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <button
              key={item.name}
              className={`nav-item ${page === item.name ? 'active' : ''}`}
              onClick={() => go(item.name)}
              aria-current={page === item.name ? 'page' : undefined}
            >
              <item.icon size={19} />
              <span>{item.name}</span>
              {item.name === 'Tasks' && <span className="nav-count">{openTasks.length}</span>}
              {page === item.name && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <div className="local-card-title">
              <span className="local-status-dot" />A quieter kind of connected
            </div>
            <p>
              Your space runs on this device.
              <br />
              No cloud account required.
            </p>
            <button onClick={() => go('Connections & privacy')}>
              Local & private
              <ShieldCheck size={13} />
            </button>
          </div>
          <button
            className={`nav-item secondary-nav ${page === 'Connections & privacy' ? 'active' : ''}`}
            onClick={() => go('Connections & privacy')}
          >
            <Settings2 size={18} />
            <span>Connections & privacy</span>
          </button>
          <button className="nav-item secondary-nav" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            <span>Around AllIn</span>
            <ArrowUpRight size={14} />
          </button>
          <div className="profile">
            <span className="avatar">Y</span>
            <div>
              <strong>Your space</strong>
              <span>Personal · this Mac</span>
            </div>
            <button
              className="icon-button"
              aria-label={demo ? 'Set up vault' : 'Lock vault'}
              onClick={demo ? () => setVaultModal(true) : () => void lock()}
            >
              <LockKeyhole size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb-home">My workspace</span>
            <ChevronRight size={13} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-actions">
            <Badge tone="green" dot>
              Local & private
            </Badge>
            <span className="topbar-divider" />
            <button className="topbar-quick" onClick={() => setEditor(null)}>
              <Plus size={16} />
              <span>Quick capture</span>
              <kbd>⌘ K</kbd>
            </button>
            <button
              className="icon-button"
              aria-label={demo ? 'Create vault' : 'Lock vault'}
              onClick={demo ? () => setVaultModal(true) : () => void lock()}
            >
              <LockKeyhole size={17} />
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="workspace-status">
            <span>
              <span className="preview-dot" />
              {demo ? 'PREVIEW SPACE' : 'YOUR LOCAL VAULT'}
              <span className="workspace-status-divider">/</span>
              {demo ? 'Explore with synthetic data' : 'Tasks saved securely on this device'}
            </span>
            {demo ? (
              <button onClick={() => setVaultModal(true)}>
                Make it yours
                <ArrowRight size={13} />
              </button>
            ) : (
              <span>
                <ShieldCheck size={13} />
                Unlocked
              </span>
            )}
          </div>
          {page === 'Today' && (
            <>
              <div className="page-heading today-heading">
                <div>
                  <div className="eyebrow">
                    <Sun size={15} /> {dateLabel.toUpperCase()}
                  </div>
                  <h1>
                    Your day, in perspective<span className="heading-dot">.</span>
                  </h1>
                  <p>A little clarity for your markets, your health, and what comes next.</p>
                </div>
                <button className="button primary" onClick={() => setEditor(null)}>
                  <Plus size={16} />
                  Add a task
                </button>
              </div>
              <div className="summary-grid">
                <button className="card summary-card" onClick={() => go('Markets')}>
                  <div className="summary-top">
                    <span className="icon-tile mint">
                      <TrendingUp size={20} />
                    </span>
                    <span className="summary-label">Markets at a glance</span>
                    <ArrowUpRight className="summary-arrow" size={17} />
                  </div>
                  <div className="summary-main">
                    <strong>
                      {markets.length
                        ? counted.reduce(
                            (sum, m) =>
                              sum +
                              m.decisions.filter(
                                (d) => d.state === 'Buy setup' || d.state === 'Sell setup',
                              ).length,
                            0,
                          )
                        : '—'}
                    </strong>
                    <span>
                      {!anyLive
                        ? 'rule setups in replay'
                        : allLive(markets)
                          ? 'rule setups, latest 80 bars'
                          : 'rule setups on live rows, latest 80 bars'}
                    </span>
                  </div>
                  <div className="summary-bottom">
                    <Badge tone={allLive(markets) ? 'green' : 'amber'} dot>
                      {anyLive ? summary : 'Synthetic replay'}
                    </Badge>
                    {!anyLive && <span>Oct 30 · 20h fixture</span>}
                  </div>
                </button>
                <HealthGlanceCard {...healthProps} />
                <button className="card summary-card" onClick={() => go('Tasks')}>
                  <div className="summary-top">
                    <span className="icon-tile lavender">
                      <CheckCheck size={20} />
                    </span>
                    <span className="summary-label">One step at a time</span>
                    <ArrowUpRight className="summary-arrow" size={17} />
                  </div>
                  <div className="summary-main">
                    <strong>{openTasks.length}</strong>
                    <span>tasks on your radar</span>
                    <span className="summary-task-icon">
                      <Check size={19} />
                    </span>
                  </div>
                  <div className="summary-bottom">
                    <Badge tone="lavender">
                      {tasks.filter((t) => t.status === 'done').length} completed
                    </Badge>
                    <span>{demo ? 'Example · Oct 30' : `Last read · ${timeLabel}`}</span>
                  </div>
                </button>
              </div>
              <MarketAlerts
                alerts={marketData.alerts}
                limit={3}
                timezone={settings.timezone}
                onDismiss={(id) => void dismissAlerts({ id })}
                onDismissAll={(ids) => void dismissAlerts({ ids })}
              />
              <div className="today-middle">
                <section className="card watchlist-card">
                  <SectionHeader
                    title="Keep an eye on the bigger picture"
                    eyebrow="YOUR WATCHLIST"
                    action={<TextLink onClick={() => go('Markets')}>View markets</TextLink>}
                  />
                  {marketError ? (
                    <Empty title="Market data is unavailable">{marketError}</Empty>
                  ) : (
                    <Watchlist
                      compact
                      markets={markets}
                      select={(s) => {
                        setSelected(s);
                        go('Markets');
                      }}
                    />
                  )}
                  <div className="watchlist-bottom">
                    {anyLive ? <Activity size={13} /> : <CirclePause size={13} />}
                    <span>
                      {anyLive
                        ? `${summary} · refreshes about once a minute`
                        : 'Simulation only · Live monitoring is paused'}
                    </span>
                    <Badge>USD</Badge>
                  </div>
                  <MarketDisclaimer live={allLive(markets)} />
                </section>
                <section className="card priorities-card">
                  <SectionHeader
                    title="A little focus for today"
                    eyebrow="YOUR NEXT STEPS"
                    action={<span className="soft-counter">{Math.min(openTasks.length, 3)}</span>}
                  />
                  {taskError && (
                    <p role="alert" className="form-error">
                      {taskError}
                    </p>
                  )}
                  <div className="priority-list">
                    {openTasks.length ? (
                      nextPriorities(tasks, today, settings.timezone).map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          timezone={settings.timezone}
                          compact
                          onEdit={() => setEditor(task)}
                          onToggle={() =>
                            void actions
                              .update(task, { status: 'done' })
                              .catch((e) => setTaskError(e.message))
                          }
                        />
                      ))
                    ) : (
                      <div className="quiet-empty">
                        <Sprout size={25} />
                        <h3>A fresh start.</h3>
                        <p>Capture one thing you’d like to do.</p>
                      </div>
                    )}
                  </div>
                  <QuickCapture onCreate={actions.create} />
                  <div className="plan-action">
                    <div>
                      <CalendarDays size={15} />
                      <span>Make a little room for your priorities.</span>
                    </div>
                    <button
                      onClick={() => {
                        setTaskFilter('Today');
                        go('Tasks');
                      }}
                    >
                      Plan my day
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </section>
              </div>
              <div className="today-bottom">
                <HealthMovementCard {...healthProps} />
                <section className="intention-card">
                  <div className="intention-art" aria-hidden="true">
                    <div className="sun-orbit orbit-one" />
                    <div className="sun-orbit orbit-two" />
                    <div className="sun-orbit orbit-three" />
                    <span className="sun-center" />
                    <span className="orbit-dot" />
                  </div>
                  <span className="eyebrow">A MOMENT OF INTENTION</span>
                  <h2>
                    You don’t have to do it all.
                    <br />
                    Just the next right thing.
                  </h2>
                  <p>
                    Give your attention to what matters today.
                    <br />
                    The rest can wait its turn.
                  </p>
                  {adjustment && (
                    <p className="week-intention">
                      {adjustment.label}: {adjustment.text}
                    </p>
                  )}
                  <button
                    onClick={() => {
                      go('Tasks');
                      setTaskFilter('Inbox');
                    }}
                  >
                    Choose your next step
                    <ArrowUpRight size={15} />
                  </button>
                </section>
              </div>
              <div className="dashboard-footer">
                <PrivateNote />
                <span>Three parts of your life. One clearer picture.</span>
                <span className="footer-leaf">
                  <Sprout size={16} />
                </span>
              </div>
            </>
          )}
          {page === 'Markets' && (
            <Markets
              markets={markets}
              alerts={marketData.alerts}
              error={marketError}
              selected={selected}
              setSelected={setSelected}
              timezone={settings.timezone}
              onDismiss={(id) => void dismissAlerts({ id })}
              onDismissAll={(ids) => void dismissAlerts({ ids })}
            />
          )}
          {page === 'Health' && (
            <Health
              demo={demo}
              preview={health}
              previewError={healthError}
              summary={healthSummary}
              summaryError={healthSummaryError}
              timezone={settings.timezone}
              onImport={() => (demo ? setVaultModal(true) : setImportOpen(true))}
              onChanged={refreshHealth}
              notify={notify}
            />
          )}
          {page === 'Tasks' && taskError && (
            <p role="alert" className="form-error">
              {taskError}
            </p>
          )}
          {page === 'Tasks' && (
            <Tasks
              tasks={tasks}
              actions={actions}
              edit={setEditor}
              filter={taskFilter}
              setFilter={setTaskFilter}
              search={search}
              setSearch={setSearch}
              today={today}
              timezone={settings.timezone}
              demo={demo}
            />
          )}
          {page === 'Weekly review' && (
            <Review tasks={tasks} settings={settings} saveSettings={saveSettings} demo={demo} />
          )}
          {page === 'Connections & privacy' && (
            <Privacy
              demo={demo}
              onSetup={() => setVaultModal(true)}
              onBackup={() => setBackup(true)}
              onLock={() => void lock()}
              settings={settings}
              saveSettings={saveSettings}
              healthSummary={healthSummary}
              healthSummaryError={healthSummaryError}
              onOpenHealth={() => go('Health')}
              feeds={marketData.feeds}
              onFeedsChanged={refreshMarkets}
              keyStore={session.keyStore}
            />
          )}
        </main>
      </div>
      {editor !== undefined && (
        <TaskEditor
          task={editor}
          actions={actions}
          timezone={settings.timezone}
          onClose={() => setEditor(undefined)}
        />
      )}
      {importOpen && (
        <HealthImport
          timezone={settings.timezone}
          weekStart={settings.weekStart}
          onClose={() => setImportOpen(false)}
          onImported={async () => {
            await refreshHealth();
            notify('OpenFit export imported');
            setImportOpen(false);
          }}
        />
      )}
      {vaultModal && (
        <Modal title="Your local vault" onClose={() => setVaultModal(false)}>
          <VaultForm
            initialized={session.initialized}
            keyStore={session.keyStore}
            onClose={() => setVaultModal(false)}
            onSuccess={async () => {
              setVaultModal(false);
              await loadSession();
              notify('Your private space is ready');
            }}
          />
        </Modal>
      )}
      {backup && <BackupDialog onClose={() => setBackup(false)} />}
      {help && (
        <Modal title="A little more intention, every day" onClose={() => setHelp(false)}>
          <div className="about-logo">
            <Logo />
          </div>
          <p className="muted">
            AllIn brings your markets, health, and everyday tasks into one private space on your
            computer.
          </p>
          <div className="step-list">
            <div>
              <span>
                <TrendingUp size={16} />
              </span>
              <p>
                <strong>Markets, with context</strong>Explore synthetic replay and inspect the
                rules. Markets stay offline until you turn on a feed.
              </p>
            </div>
            <div>
              <span>
                <HeartPulse size={16} />
              </span>
              <p>
                <strong>Progress, at your pace</strong>Import an OpenFit export and see your workout
                days and weight, with honest data coverage.
              </p>
            </div>
            <div>
              <span>
                <CheckCheck size={16} />
              </span>
              <p>
                <strong>Less in your head</strong>Capture, schedule, and complete tasks in your
                encrypted vault.
              </p>
            </div>
          </div>
          <div className="keyboard-hint">
            <kbd>⌘</kbd>
            <kbd>K</kbd>
            <span>Capture a thought, from anywhere</span>
          </div>
          <p className="field-hint">
            M4 · Live market feeds · macOS. Markets stay offline until you turn on a feed. No
            external actions or model downloads.
          </p>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
function Logo() {
  return (
    <span className="logo">
      <span className="logo-mark">
        <svg width="23" height="23" viewBox="0 0 32 32" aria-hidden="true">
          <path d="m5 25 9-19h4l9 19h-6L16 14l-5 11Z" fill="currentColor" />
          <circle cx="16" cy="24" r="2.1" fill="#bcedc8" />
        </svg>
      </span>
      <span>
        all<span className="logo-in">in</span>
        <span className="logo-period">.</span>
      </span>
    </span>
  );
}
function QuickCapture({ onCreate }: { onCreate: TaskActions['create'] }) {
  const [title, setTitle] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onCreate({ title });
      setTitle('');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form className="quick-capture" onSubmit={submit}>
        <Plus size={16} />
        <input
          aria-label="Quick capture task"
          value={title}
          maxLength={240}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Get it out of your head…"
        />
        <button
          className="capture-submit"
          aria-label="Capture task"
          disabled={busy || !title.trim()}
        >
          ↵
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
