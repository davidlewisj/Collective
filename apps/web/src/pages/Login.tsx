import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, apiUrl, getAuthConfig } from "../api";
import { useAuth } from "../auth";

const SEED_USERS = [
  { email: "dana@collective.dev", label: "Dana · org admin" },
  { email: "omar@collective.dev", label: "Omar · member" },
  { email: "priya@collective.dev", label: "Priya · member" },
  { email: "casey@collective.dev", label: "Casey · auditor" },
];

const POST_LOGIN_KEY = "collective.postLogin";

/**
 * Where to land after signing in. Defaults to the meeting list, but a flow
 * that bounced through login (e.g. the Claude connector consent page) can
 * stash an in-app return path — only same-origin paths are honored.
 */
function takePostLoginTarget(): string {
  try {
    const target = sessionStorage.getItem(POST_LOGIN_KEY);
    sessionStorage.removeItem(POST_LOGIN_KEY);
    if (target && target.startsWith("/") && !target.startsWith("//")) return target;
  } catch {
    /* sessionStorage unavailable */
  }
  return "/";
}

export function LoginPage() {
  const { login, adoptToken } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [microsoft, setMicrosoft] = useState(false);
  // Hidden until the server confirms dev-login is allowed — locked-down by
  // default so the passwordless form never shows on a public deployment.
  const [devLogin, setDevLogin] = useState(false);

  useEffect(() => {
    getAuthConfig()
      .then((c) => {
        setMicrosoft(c.microsoft);
        setDevLogin(c.devLogin);
      })
      .catch(() => {
        setMicrosoft(false);
        setDevLogin(false);
      });
  }, []);

  // Returning from Microsoft sign-in: the server redirects here with the
  // session token (or an error) in the URL fragment.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const msToken = params.get("msToken");
    const msError = params.get("msError");
    if (msToken) {
      history.replaceState(null, "", window.location.pathname); // token never lingers in the URL
      setBusy(true);
      adoptToken(msToken)
        .then(() => navigate(takePostLoginTarget(), { replace: true }))
        .catch(() => setError("Microsoft sign-in didn't complete. Try again."))
        .finally(() => setBusy(false));
    } else if (msError) {
      history.replaceState(null, "", window.location.pathname);
      setError(`Microsoft sign-in failed: ${msError.replaceAll("_", " ")}`);
    }
  }, [adoptToken, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email);
      navigate(takePostLoginTarget(), { replace: true });
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
        {devLogin && (
          <>
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
          </>
        )}
        {microsoft && (
          <a className="btn-quiet btn-block login-ms" href={apiUrl("/auth/microsoft")}>
            Sign in with Microsoft
          </a>
        )}
        {!devLogin && !microsoft && (
          <p className="login-sub" role="status">
            Sign-in isn't configured for this deployment yet. Ask your administrator to enable Microsoft
            sign-in.
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {devLogin && (
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
        )}
      </form>
    </main>
  );
}
