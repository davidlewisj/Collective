import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { User } from "@collective/shared";
import {
  apiUrl,
  devLogin,
  loadSession,
  resetCaches,
  saveSession,
  setUnauthorizedHandler,
  type AuthSession,
} from "./api";

interface AuthContextValue {
  session: AuthSession | null;
  user: User | null;
  login: (email: string) => Promise<void>;
  /** Adopt a server-issued session token (Microsoft sign-in redirect). */
  adoptToken: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());

  const logout = useCallback(() => {
    saveSession(null);
    resetCaches();
    setSession(null);
  }, []);

  const login = useCallback(async (email: string) => {
    const next = await devLogin(email.trim());
    saveSession(next);
    resetCaches();
    setSession(next);
  }, []);

  const adoptToken = useCallback(async (token: string) => {
    const res = await fetch(apiUrl("/me"), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("token rejected");
    const { user } = (await res.json()) as { user: User };
    const next: AuthSession = { token, user };
    saveSession(next);
    resetCaches();
    setSession(next);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const value = useMemo(
    () => ({ session, user: session?.user ?? null, login, adoptToken, logout }),
    [session, login, adoptToken, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

function PendingApproval({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  return (
    <main className="login-page">
      <div className="login-card">
        <h1 className="login-wordmark">Collective</h1>
        <p className="login-sub">
          Thanks, {name.split(" ")[0] || "there"} — your request to join is waiting for an administrator to
          approve it. You'll have access as soon as they do; try signing in again then.
        </p>
        <button type="button" className="btn-quiet btn-block" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </main>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, user, logout } = useAuth();
  const location = useLocation();
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user?.status === "pending") return <PendingApproval name={user.displayName} onSignOut={logout} />;
  return <>{children}</>;
}
