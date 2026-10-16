import { useState } from 'react';
import { post } from '../api';
import { ErrorBox, Field, Module, PageHead, PasswordInput, useToast } from '../components/ui';

export default function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/api/auth/password', { current, next });
      setCurrent('');
      setNext('');
      setError(null);
      toast('Password changed. Other sessions were signed out.');
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHead title="Password" sub="Changing it signs out every other session. For hosting accounts this is also the SFTP password." />
      <Module>
        <form className="form" onSubmit={submit} style={{ maxWidth: 460 }}>
          <Field label="Current password">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <PasswordInput value={next} onChange={setNext} />
          </Field>
          <ErrorBox error={error} />
          <div><button className="primary">Change password</button></div>
        </form>
      </Module>
    </>
  );
}
