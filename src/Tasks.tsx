import { useState, type FormEvent } from 'react';
import {
  Plus,
  Clock3,
  Check,
  MoreHorizontal,
  CalendarDays,
  Repeat2,
  Search,
  Trash2,
  ArrowUpRight,
  Inbox,
  SlidersHorizontal,
} from 'lucide-react';
import type { Task, TaskInput } from '../shared/schema';
import { visibleTasks } from '../shared/taskViews';
import { zonedInputToISO, zonedInputValue } from '../shared/time';
import { Badge, Modal, Empty, SectionHeader } from './components';

export type TaskActions = {
  create: (input: Partial<TaskInput> & { title: string }) => Promise<void>;
  update: (task: Task, changes: Partial<TaskInput>) => Promise<void>;
  remove: (task: Task) => Promise<void>;
};
export function TaskRow({
  task,
  onToggle,
  onEdit,
  compact = false,
  timezone = 'Asia/Jerusalem',
}: {
  task: Task;
  onToggle: () => void;
  onEdit: () => void;
  compact?: boolean;
  timezone?: string;
}) {
  return (
    <div
      className={`task-row ${task.status === 'done' ? 'is-done' : ''} ${compact ? 'compact' : ''}`}
    >
      <button
        className={`task-check ${task.status === 'done' ? 'checked' : ''}`}
        onClick={onToggle}
        aria-label={`${task.status === 'done' ? 'Reopen' : 'Complete'} ${task.title}`}
      >
        {task.status === 'done' && <Check size={13} />}
      </button>
      <button className="task-copy" onClick={onEdit}>
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          <span className={`project-dot ${task.project.toLowerCase()}`} />
          {task.project}
          {task.estimate !== null && (
            <>
              <span className="meta-separator">·</span>
              <Clock3 size={11} />
              {task.estimate} min
            </>
          )}
          {task.scheduledAt && (
            <>
              <span className="meta-separator">·</span>
              <CalendarDays size={11} />
              {new Date(task.scheduledAt).toLocaleString('en-US', {
                timeZone: timezone,
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </>
          )}
          {task.dueDay && !task.scheduledAt && (
            <>
              <span className="meta-separator">·</span>Due {task.dueDay}
            </>
          )}
          {task.recurring !== 'none' && <Repeat2 size={11} />}
        </span>
      </button>
      <span className={`priority-indicator ${task.priority}`} title={`${task.priority} priority`} />
      <button className="icon-button task-more" aria-label={`Edit ${task.title}`} onClick={onEdit}>
        <MoreHorizontal size={17} />
      </button>
    </div>
  );
}
export function TaskEditor({
  task,
  actions,
  timezone,
  onClose,
}: {
  task: Task | null;
  actions: TaskActions;
  timezone: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? ''),
    [project, setProject] = useState<TaskInput['project']>(task?.project ?? 'Personal'),
    [priority, setPriority] = useState<TaskInput['priority']>(task?.priority ?? 'medium'),
    [estimate, setEstimate] = useState(task?.estimate?.toString() ?? ''),
    [due, setDue] = useState(task?.dueDay ?? ''),
    [recurring, setRecurring] = useState<TaskInput['recurring']>(task?.recurring ?? 'none'),
    [actual, setActual] = useState(task?.actual?.toString() ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false);
  const [schedule, setSchedule] = useState(
    task?.scheduledAt ? zonedInputValue(task.scheduledAt, timezone) : '',
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const changes = {
        title,
        project,
        priority,
        estimate: estimate ? Number(estimate) : null,
        dueDay: due || null,
        scheduledAt: schedule ? zonedInputToISO(schedule, timezone) : null,
        recurring,
        actual: actual ? Number(actual) : null,
      };
      if (task) await actions.update(task, changes);
      else await actions.create(changes);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={task ? 'A little room for the details' : 'What’s on your mind?'}
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-stack">
        <label>
          Task
          <input
            autoFocus
            required
            maxLength={240}
            placeholder="Just a title is enough"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            Project
            <select
              value={project}
              onChange={(e) => setProject(e.target.value as TaskInput['project'])}
            >
              {['Personal', 'Work', 'Wellbeing', 'Learning'].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskInput['priority'])}
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label>
            Estimated minutes
            <input
              type="number"
              min={5}
              max={480}
              step={5}
              value={estimate}
              placeholder="Optional"
              onChange={(e) => setEstimate(e.target.value)}
            />
          </label>
          <label>
            Due date
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label>
            Repeat
            <select
              value={recurring}
              onChange={(e) => setRecurring(e.target.value as TaskInput['recurring'])}
            >
              <option value="none">Doesn’t repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </select>
          </label>
          <label>
            Actual minutes
            <input
              type="number"
              min={0}
              max={1440}
              value={actual}
              placeholder="Not logged"
              onChange={(e) => setActual(e.target.value)}
            />
          </label>
        </div>
        <label>
          Reserve a time
          <input
            type="datetime-local"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          />
          <span className="field-hint">Entered in {timezone}. Saves to your local plan.</span>
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {deleting ? (
          <div className="delete-confirm">
            <p>Delete this task from your vault?</p>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await actions.remove(task!);
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              Delete task
            </button>
            <button type="button" className="button secondary" onClick={() => setDeleting(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <div className="modal-actions">
            {task && (
              <button
                type="button"
                className="icon-button danger-text"
                aria-label="Delete task"
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={18} />
              </button>
            )}
            <button type="button" className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? 'Saving…' : task ? 'Save changes' : 'Add to inbox'}
              <ArrowUpRight size={15} />
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
export function Tasks({
  tasks,
  actions,
  edit,
  filter,
  setFilter,
  search,
  setSearch,
  today,
  timezone,
  demo,
}: {
  tasks: Task[];
  actions: TaskActions;
  edit: (task: Task | null) => void;
  filter: string;
  setFilter: (f: string) => void;
  search: string;
  setSearch: (s: string) => void;
  today: string;
  timezone: string;
  demo: boolean;
}) {
  const [title, setTitle] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [project, setProject] = useState<string | null>(null);
  const filtered = visibleTasks(tasks, { view: filter, search, project, today, timezone });
  if (filter === 'Today') {
    filtered.sort((a, b) => {
      if (a.scheduledAt && b.scheduledAt) return a.scheduledAt.localeCompare(b.scheduledAt);
      return a.scheduledAt ? -1 : b.scheduledAt ? 1 : 0;
    });
  }
  const capture = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await actions.create({ title });
      setTitle('');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A LITTLE CLARITY GOES A LONG WAY</div>
          <h1>Make room for what matters.</h1>
          <p>Capture a thought. Choose a priority. Take the next step.</p>
        </div>
        <button className="button primary" onClick={() => edit(null)}>
          <Plus size={16} />
          New task
        </button>
      </div>
      <div className="tasks-layout">
        <div className="card tasks-main">
          <form className="quick-capture large" onSubmit={capture}>
            <Plus size={19} />
            <input
              aria-label="Capture a task"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={240}
              placeholder="Anything on your mind? Add it here…"
            />
            <button
              className="capture-submit"
              aria-label="Add task"
              disabled={busy || !title.trim()}
            >
              <span>Enter</span> ↵
            </button>
          </form>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="task-toolbar">
            <div className="tabs">
              {['Inbox', 'Today', 'Completed', 'All tasks'].map((tab) => (
                <button
                  key={tab}
                  className={filter === tab ? 'active' : ''}
                  onClick={() => setFilter(tab)}
                >
                  {tab}
                  {tab === 'Inbox' && (
                    <span>{tasks.filter((t) => t.status === 'open').length}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="task-search">
              <Search size={15} />
              <input
                aria-label="Search tasks"
                placeholder="Search tasks"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="task-table-label">
            <span>TASK</span>
            <span>PRIORITY</span>
          </div>
          {filtered.length ? (
            filtered.map((t) => (
              <TaskRow
                key={t.id}
                timezone={timezone}
                task={t}
                onEdit={() => edit(t)}
                onToggle={() =>
                  void actions
                    .update(t, { status: t.status === 'done' ? 'open' : 'done' })
                    .catch((e) => setError(e.message))
                }
              />
            ))
          ) : (
            <Empty
              title={
                search || project
                  ? 'No matching tasks'
                  : filter === 'Today'
                    ? 'Your day has room'
                    : 'A clear space to begin'
              }
            >
              {search || project
                ? 'Try a different word or project.'
                : filter === 'Today'
                  ? 'Open a task and reserve a time or set its due date to today.'
                  : 'Add a task above. A title is all you need.'}
            </Empty>
          )}
          <div className="card-footer">
            <Inbox size={13} />
            {demo
              ? 'Preview tasks stay in memory. Create a vault to keep your own.'
              : 'Your tasks are saved in your encrypted local vault.'}
          </div>
        </div>
        <aside className="task-aside">
          <div className="card padded">
            <div className="icon-tile mint">
              <CalendarDays size={21} />
            </div>
            <h3>A day with breathing room</h3>
            <p>Choose up to three priorities. Give them a time, and leave some space in between.</p>
            <button className="button secondary full-width" onClick={() => setFilter('Today')}>
              See today’s plan
              <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="card padded">
            <SectionHeader title="Your projects" />
            {['Work', 'Personal', 'Wellbeing', 'Learning'].map((p) => (
              <button
                className={`project-row ${project === p ? 'selected' : ''}`}
                key={p}
                aria-pressed={project === p}
                onClick={() => {
                  setProject(project === p ? null : p);
                  setSearch('');
                  setFilter('All tasks');
                }}
              >
                <span className={`project-dot ${p.toLowerCase()}`} />
                {p}
                <span>{tasks.filter((t) => t.project === p && t.status === 'open').length}</span>
              </button>
            ))}
          </div>
          <div className="subtle-note">
            <SlidersHorizontal size={16} />
            <p>Local planning works without an AI model. You decide what goes on your day.</p>
          </div>
        </aside>
      </div>
    </>
  );
}
