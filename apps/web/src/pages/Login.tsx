import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api";
import { useAuth } from "../auth";

const SEED_USERS = [
  { email: "dana@collective.dev", label: "Dana · org admin" },
  { email: "omar@collective.dev", label: "Omar · member" },
  { email: "priya@collective.dev", label: "Priya · member" },
  { email: "casey@collective.dev", label: "Casey · auditor" },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email);
      navigate("/", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? "No account with that email in this dev org."
          : "Sign-in failed. Is the dev server running on port 4000?",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1 className="login-wordmark">Collective</h1>
        <p className="login-sub">Meeting notes your whole practice can trust.</p>
        <label htmlFor="login-email">Work email</label>
        <input
          id="login-email"
          type="email"
          autoComplete="email"
          placeholder="you@collective.dev"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <button type="submit" className="btn btn-block" disabled={busy || !email.trim()}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="login-seeds">
          <span className="section-label">Dev sign-in</span>
          <div className="login-seed-chips">
            {SEED_USERS.map((s) => (
              <button
                key={s.email}
                type="button"
                className="chip chip-tappable"
                onClick={() => setEmail(s.email)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </form>
    </main>
  );
}
