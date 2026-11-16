import { useCallback, useEffect, useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { api, setAuthenticatedToken } from './api';
import { Badge, SectionHeader } from './components';

type Device = {
  key: string;
  device: string;
  startedAt: string;
  lastActiveAt: string;
  current: boolean;
};
export function Sessions({ timezone }: { timezone: string }) {
  const [devices, setDevices] = useState<Device[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  const load = useCallback(
    () =>
      api<{ sessions: Device[] }>('/sessions')
        .then((r) => {
          setDevices(r.sessions);
        })
        .catch((e) => setError((e as Error).message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const time = (iso: string) =>
    new Date(iso).toLocaleString('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  async function signOut(device: Device) {
    setBusy(device.key);
    setError('');
    try {
      await api('/sessions/sign-out', 'POST', { key: device.key });
      if (device.current) {
        // This tab's session is gone, so go to the lock screen as a lock would.
        setAuthenticatedToken('');
        window.dispatchEvent(new Event('allin-locked'));
        return;
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
      // A device that signed itself out meanwhile is gone either way.
      await load();
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="card padded">
      <SectionHeader title="Signed-in devices" />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="event-list">
        {devices.map((d) => (
          <div key={d.key}>
            <MonitorSmartphone size={15} />
            <span>
              {d.device} · signed in {time(d.startedAt)} · last active {time(d.lastActiveAt)}
            </span>
            {d.current && <Badge tone="green">This device</Badge>}
            <button
              className="button secondary"
              disabled={busy === d.key}
              aria-label={d.current ? 'Sign out this device' : `Sign out ${d.device}`}
              onClick={() => void signOut(d)}
            >
              Sign out
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
