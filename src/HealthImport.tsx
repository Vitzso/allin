import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Modal } from './components';
import {
  MAX_EXPORT_BYTES,
  TOO_LARGE_MESSAGE,
  buildImportRequest,
  keptSummary,
  parseOpenFitExport,
  type ImportSelection,
  type KeptCategory,
  type OpenFitExport,
} from '../shared/openfit';
import { formatInstant } from '../shared/healthViews';
import type { ChangeCounts, HealthImportResult } from '../shared/healthSchema';

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Counts({ label, counts }: { label: string; counts: ChangeCounts }) {
  return (
    <p className="import-counts">
      <strong>{label}</strong>
      <span>
        {counts.added} added · {counts.changed} changed · {counts.removed} removed ·{' '}
        {counts.unchanged} unchanged
      </span>
    </p>
  );
}
function Kept({ item }: { item: KeptCategory }) {
  return (
    <li>
      <strong>{item.category === 'workouts' ? 'Workouts' : 'Weight'}</strong>
      <span>
        {plural(item.days, 'day')}
        {item.first && item.last && ` · ${item.first} to ${item.last}`}
      </span>
    </li>
  );
}
function Discarded({ label, count }: { label: string; count: number }) {
  return (
    <li>
      <strong>{label}</strong>
      <span>{count}</span>
    </li>
  );
}

export function HealthImport({
  timezone,
  weekStart,
  onClose,
  onImported,
}: {
  timezone: string;
  weekStart: number;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  // Only the parsed, derived rows are kept. The file's name and text never reach state.
  const [parsed, setParsed] = useState<OpenFitExport | null>(null),
    [workouts, setWorkouts] = useState(true),
    [weight, setWeight] = useState(true),
    [dated, setDated] = useState(false),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [result, setResult] = useState<HealthImportResult | null>(null),
    [confirmOlder, setConfirmOlder] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  // The newest request wins. Closing the dialog also invalidates any answer still in flight.
  const latest = useRef(0);
  // The newest file wins, the same way. A file that reads slowly must not replace a later one.
  const chosen = useRef(0);
  useEffect(
    () => () => {
      latest.current++;
      chosen.current++;
    },
    [],
  );

  const lastCovered = parsed
    ? [parsed.exportDay, parsed.workoutSpan?.last, parsed.weightSpan?.last]
        .filter((day): day is string => !!day)
        .reduce((a, b) => (b > a ? b : a))
    : '';
  const hint =
    !workouts && !weight
      ? 'Choose workouts, weight, or both.'
      : dated && (!from || !to)
        ? 'Choose a From and a To date.'
        : dated && from > to
          ? 'From must be on or before To.'
          : '';
  const selection: ImportSelection | null =
    parsed && !hint ? { workouts, weight, range: dated ? { from, to } : 'all' } : null;
  const selectionKey = JSON.stringify(selection);

  useEffect(() => {
    setResult(null);
    // A confirmation covers only the selection it was given for.
    setConfirmOlder(false);
    // Counted even with no valid selection, so an answer for an earlier one is dropped.
    const attempt = ++latest.current;
    if (!parsed || !selection) return;
    setError('');
    void dryRun(parsed, selection, attempt, true);
    // The selection is read through its key, so an equal selection doesn't ask again.
  }, [parsed, selectionKey]);

  /** Asks what a save would change. Only the newest question's answer is used. */
  async function dryRun(
    file: OpenFitExport,
    chosenSelection: ImportSelection,
    attempt: number,
    showError: boolean,
  ) {
    try {
      const answer = await api<HealthImportResult>('/health/import', 'POST', {
        ...buildImportRequest(file, chosenSelection),
        dryRun: true,
        confirmOlder: false,
      });
      if (attempt === latest.current) setResult(answer);
    } catch (e) {
      if (attempt === latest.current && showError) setError((e as Error).message);
    }
  }

  async function choose(file: File | undefined) {
    latest.current++;
    const attempt = ++chosen.current;
    setParsed(null);
    setResult(null);
    setConfirmOlder(false);
    setError('');
    if (!file) return;
    if (file.size > MAX_EXPORT_BYTES) return setError(TOO_LARGE_MESSAGE);
    let read: ReturnType<typeof parseOpenFitExport>;
    try {
      // The text lives only in this call and is dropped once parsed.
      read = parseOpenFitExport(await file.text(), { timezone });
    } catch {
      if (attempt === chosen.current) setError('AllIn couldn’t read that file.');
      return;
    }
    if (attempt !== chosen.current) return;
    if (!read.ok) return setError(read.message);
    const firsts = [read.workoutSpan?.first, read.weightSpan?.first].filter(
      (day): day is string => !!day,
    );
    setFrom(firsts.length ? firsts.reduce((a, b) => (b < a ? b : a)) : read.exportDay);
    setTo(read.exportDay);
    setParsed(read);
  }

  async function save() {
    if (!parsed || !selection) return;
    setSaving(true);
    setError('');
    try {
      await api<HealthImportResult>('/health/import', 'POST', {
        ...buildImportRequest(parsed, selection),
        dryRun: false,
        confirmOlder,
      });
      await onImported();
    } catch (e) {
      // Whatever the refusal, the choices stay as they are and the message is the server's. The
      // preview is asked again, since the refusal may mean the vault changed. Whether the file is
      // older comes only from that answer, never from the refusal.
      setError((e as Error).message);
      setSaving(false);
      setResult(null);
      void dryRun(parsed, selection, ++latest.current, false);
    }
  }

  const removed = (result?.workouts?.removed ?? 0) + (result?.weight?.removed ?? 0);
  const older = !!result?.older;
  // A category with no rows and no coverage records nothing. With nothing removed either, a save
  // changes nothing, yet would log an import.
  const request = parsed && selection ? buildImportRequest(parsed, selection) : null;
  const nothingToSave =
    !!result &&
    removed === 0 &&
    !!request &&
    [request.workouts, request.weight]
      .filter((part) => part !== undefined)
      .every((part) => part.rows.length === 0 && part.coverageFrom === null);
  const canSave = !!result && !saving && !nothingToSave && (!older || confirmOlder);
  const fileWeek = parsed?.fileWeekStart ?? null;

  return (
    // While a save runs the import commits whatever the dialog does, so no way of closing is live.
    <Modal title="Import from OpenFit" onClose={saving ? () => {} : onClose} wide>
      <div className="form-stack import-form">
        <label>
          <span>OpenFit export file</span>
          <input
            type="file"
            accept=".json,application/json"
            disabled={saving}
            onChange={(e) => void choose(e.target.files?.[0])}
          />
        </label>
        {parsed && (
          <>
            <fieldset className="import-choices">
              <legend>What to import</legend>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={workouts}
                  disabled={saving}
                  onChange={(e) => setWorkouts(e.target.checked)}
                />
                Workouts
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={weight}
                  disabled={saving}
                  onChange={(e) => setWeight(e.target.checked)}
                />
                Weight
              </label>
            </fieldset>
            <fieldset className="import-choices">
              <legend>Which dates</legend>
              <label className="check-row">
                <input
                  type="radio"
                  name="import-range"
                  checked={!dated}
                  disabled={saving}
                  onChange={() => setDated(false)}
                />
                All dates
              </label>
              <label className="check-row">
                <input
                  type="radio"
                  name="import-range"
                  checked={dated}
                  disabled={saving}
                  onChange={() => setDated(true)}
                />
                A date range
              </label>
              {dated && (
                <div className="form-grid">
                  <label>
                    <span>From</span>
                    <input
                      type="date"
                      value={from}
                      max={lastCovered}
                      disabled={saving}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>To</span>
                    <input
                      type="date"
                      value={to}
                      max={lastCovered}
                      disabled={saving}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                </div>
              )}
            </fieldset>
            {hint && <p className="field-hint">{hint}</p>}
            <section className="import-summary" aria-label="What this import does">
              <p className="field-hint">
                Exported {formatInstant(parsed.source.exportedAt, timezone)}
              </p>
              <h3>Kept in your vault</h3>
              {selection && (
                <ul>
                  {keptSummary(parsed, selection).map((item) => (
                    <Kept key={item.category} item={item} />
                  ))}
                </ul>
              )}
              {parsed.skippedWorkouts > 0 && (
                <p className="field-hint">
                  {plural(parsed.skippedWorkouts, 'empty or warm-up-only workout')} skipped.
                </p>
              )}
              <h3>Not kept</h3>
              <ul>
                <Discarded label="Coach messages" count={parsed.discarded.coachMessages} />
                <Discarded label="Food entries" count={parsed.discarded.foodEntries} />
                <Discarded label="Food products" count={parsed.discarded.foodProducts} />
                <Discarded label="Exercises" count={parsed.discarded.exercises} />
                <Discarded label="Workout notes" count={parsed.discarded.workoutNotes} />
                <Discarded label="Workout sets" count={parsed.discarded.workoutSets} />
                <Discarded label="Profile settings" count={parsed.discarded.profileSettings} />
              </ul>
              {fileWeek !== null && fileWeek !== weekStart && (
                <p className="field-hint import-warning">
                  OpenFit starts its week on {dayNames[fileWeek]}. AllIn starts on{' '}
                  {dayNames[weekStart]}.
                </p>
              )}
              <p className="field-hint">Your export file stays wherever you saved it.</p>
              <h3>What saving changes</h3>
              {result ? (
                <>
                  {result.workouts && <Counts label="Workouts" counts={result.workouts} />}
                  {result.weight && <Counts label="Weight" counts={result.weight} />}
                  {nothingToSave && (
                    <p className="field-hint">Nothing to save in this selection.</p>
                  )}
                  {removed > 0 && (
                    <p className="import-warning">
                      {plural(removed, 'saved day')} will be removed.
                    </p>
                  )}
                </>
              ) : (
                selection && !error && <p className="field-hint">Checking what would change…</p>
              )}
              {older && (
                <>
                  <p className="field-hint">
                    This file was exported before data you already imported for these dates.
                  </p>
                  <label className="check-row import-warning">
                    <input
                      type="checkbox"
                      checked={confirmOlder}
                      disabled={saving}
                      onChange={(e) => setConfirmOlder(e.target.checked)}
                    />
                    Use this older file anyway
                  </label>
                </>
              )}
            </section>
          </>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button className="button secondary" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={!canSave} onClick={() => void save()}>
          Save to my vault
        </button>
      </div>
    </Modal>
  );
}
