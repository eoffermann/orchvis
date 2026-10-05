import { useState, type FormEvent } from 'react';
import { login } from '../net/login';

/** Props for {@link LoginScreen}. */
export interface LoginScreenProps {
  /** Called after the broker accepted the token and set the session cookie. */
  onLoggedIn: () => void;
  /** Retries the feed with the existing cookie, without logging in again. */
  onRetry: () => void;
}

const MESSAGES = {
  bad_token: 'The broker did not accept that token.',
  unreachable: 'Cannot reach the broker. Check that it is running and reachable on the LAN.',
  error: 'The broker returned an error. Try again.',
} as const;

/**
 * The Owner login. Shown when the feed refuses the cookie or cannot connect
 * since page load. The token goes to `POST /api/login` once and is not kept.
 */
export function LoginScreen({ onLoggedIn, onRetry }: LoginScreenProps) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await login(token.trim());
    setBusy(false);
    if (result.ok) {
      setToken('');
      onLoggedIn();
    } else {
      setError(MESSAGES[result.reason]);
    }
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>orchvis</h1>
        <p>Sign in with the Owner token from the broker's config file.</p>
        <label className="login-label" htmlFor="owner-token">
          Owner token
        </label>
        <input
          id="owner-token"
          className="login-input"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <div className="login-actions">
          <button type="submit" className="button button--primary" disabled={busy || !token.trim()}>
            {busy ? 'Signing in' : 'Sign in'}
          </button>
          <button type="button" className="button" onClick={onRetry}>
            Retry connection
          </button>
        </div>
      </form>
    </main>
  );
}
