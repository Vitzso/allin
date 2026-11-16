import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  X,
  ArrowUpRight,
  ArrowDownRight,
  ShieldCheck,
  ArrowRight,
  LockKeyhole,
} from 'lucide-react';

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode;
  tone?: string;
  dot?: boolean;
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <i />}
      {children}
    </span>
  );
}
export function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="change">—</span>;
  return (
    <span className={`change ${value < 0 ? 'negative' : 'positive'}`}>
      {value < 0 ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />} {value > 0 ? '+' : ''}
      {value.toFixed(2)}%
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const element = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={id}>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <ShieldCheck size={25} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function SectionHeader({
  title,
  eyebrow,
  action,
}: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowRight size={14} />
    </button>
  );
}
export function Provenance({ children }: { children: ReactNode }) {
  return (
    <div className="provenance">
      <span className="source-dot" />
      {children}
    </div>
  );
}
export function Sparkline({
  values,
  color = '#348266',
  area = false,
  height = 42,
  label = 'Price trend',
  positions,
  markers = false,
}: {
  values: number[];
  color?: string;
  area?: boolean;
  height?: number;
  label?: string;
  /** Where each value sits along the width, 0 to 1, in place of even spacing. */
  positions?: number[];
  /** Marks each value with a dot that preserveAspectRatio="none" can't stretch. */
  markers?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1;
  const coordinates = values.map((v, i) => [
    (positions?.[i] ?? i / Math.max(1, values.length - 1)) * 400,
    height - 5 - ((v - min) / range) * (height - 10),
  ]);
  const points = coordinates.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <svg
      role="img"
      aria-label={label}
      className="sparkline"
      viewBox={`0 0 400 ${height}`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".14" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && (
        <polygon
          points={`${coordinates[0]?.[0] ?? 0},${height} ${points} ${coordinates.at(-1)?.[0] ?? 400},${height}`}
          fill={`url(#${id})`}
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={area ? 2.1 : 1.7}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {markers && (
        <path
          d={coordinates.map(([x, y]) => `M${x},${y}h0`).join('')}
          fill="none"
          stroke={color}
          strokeWidth={6}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
export function PrivateNote() {
  return (
    <div className="private-note">
      <LockKeyhole size={13} />
      <span>On your device. On your terms.</span>
    </div>
  );
}
