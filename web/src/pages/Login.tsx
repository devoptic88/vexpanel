import { useState } from 'react';
import { post } from '../api';
import { ErrorBox, Field } from '../components/ui';

const UNITS: Array<[string, number]> = [
  ['nginx', 7],
  ['php-fpm', 5],
  ['mariadb', 4],
  ['postfix', 3],
  ['bind9', 2],
];

export default function Login({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/login', { username, password });
      await onSignedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-art">
        <div className="brand">
          <div className="brand-mark" aria-hidden><span /><span /><span /></div>
          VEXPANEL
        </div>
        <div>
          <h1>Your server, every site on it.</h1>
          <p>Domains, files, databases, mail, DNS and certificates for each hosting account, from one place.</p>
        </div>
        <div className="rack" aria-hidden>
          {UNITS.map(([name, n]) => (
            <div className="unit" key={name}>
              <span>{name}</span>
              <div className="leds">
                {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < n ? 'on' : ''} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <form className="login-form" onSubmit={submit}>
        <div>
          <h2>Sign in</h2>
          <p className="muted">Use your hosting account or administrator login.</p>
        </div>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
