import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ApiError } from '../api';

// ---------- Router ----------
export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, '', to);
  window.dispatchEvent(new Event('vex:navigate'));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    window.addEventListener('vex:navigate', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('vex:navigate', on);
    };
  }, []);
  return path;
}

export function Link({ to, children, className, current }: { to: string; children: ReactNode; className?: string; current?: boolean }) {
  return (
    <a
      href={to}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ---------- Data loading ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

// ---------- Toasts ----------
interface ToastItem { id: number; text: string; err?: boolean }
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, err }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), err ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.err ? ' err' : ''}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wrap an async action: shows a success toast, or an error toast with the server's message. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      setBusy(true);
      try {
        await fn();
        if (success) toast(success);
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Something went wrong.', true);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

// ---------- Layout bits ----------
export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function Module({ title, sub, actions, children, flush }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="module">
      {(title || actions) && (
        <div className="module-head">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <p>{sub}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`module-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const detail = error instanceof ApiError ? error.detail : undefined;
  return (
    <div className="error-box" role="alert">
      {msg}
      {detail && <pre>{detail}</pre>}
    </div>
  );
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}

/** The LED usage rail: 20 segments, lit in proportion to use against a limit. */
export function Rail({ label, used, max, format = (n: number) => String(n), bytes }: { label: string; used: number; max: number; format?: (n: number) => string; bytes?: boolean }) {
  const ratio = max > 0 ? Math.min(used / max, 1) : 0;
  const lit = used > 0 ? Math.max(1, Math.round(ratio * 20)) : 0;
  const tone = ratio >= 1 ? ' full' : ratio >= 0.8 ? ' hot' : '';
  const unlimited = !bytes && max >= 1000;
  return (
    <div className="rail">
      <div className="rail-top">
        <span>{label}</span>
        <span>
          {format(used)} of {unlimited ? 'unlimited' : format(max)}
        </span>
      </div>
      <div className={`leds${tone}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used} aria-label={label}>
        {Array.from({ length: 20 }, (_, i) => (
          <i key={i} className={i < lit ? 'on' : ''} />
        ))}
      </div>
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="ghost small" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** A modal form: renders fields, submits, closes on success. */
export function FormModal({
  title,
  submitLabel,
  onClose,
  onSubmit,
  children,
  danger,
}: {
  title: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: () => Promise<unknown>;
  children: ReactNode;
  danger?: boolean;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} type="button">Cancel</button>
          <button className={danger ? 'danger solid' : 'primary'} disabled={busy} onClick={() => void submit()}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        {children}
        <ErrorBox error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function randomPassword(len = 18): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+=?@';
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => chars[n % chars.length]).join('');
}

/** Password input with a generate button. */
export function PasswordInput({ value, onChange, autoComplete = 'new-password' }: { value: string; onChange: (v: string) => void; autoComplete?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} />
      <button type="button" className="small" onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>
      <button
        type="button"
        className="small"
        onClick={() => {
          onChange(randomPassword());
          setShow(true);
        }}
      >
        Generate
      </button>
    </div>
  );
}
