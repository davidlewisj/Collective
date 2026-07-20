import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { ApiError, getOAuthAuthorizeInfo, postOAuthDecision, type OAuthAuthorizeInfo } from "../api";
import { useAuth } from "../auth";

const SCOPE_LABELS: Record<string, string> = {
  "meetings.search": "Search your meetings",
  "meetings.read": "Read meeting titles, summaries, and action items",
  "transcripts.read": "Read meeting transcripts",
};

/**
 * OAuth consent screen for the MCP connector (spec §6.4). Claude sends the
 * browser to the server's /oauth/authorize, which lands here with a request
 * id. The user confirms who they are and approves; we relay the decision and
 * the server hands the browser back to Claude with an authorization code.
 * Access is always the user's own — Claude can never see more than they can.
 */
export function ConnectConsentPage() {
  const { session, user } = useAuth();
  const [params] = useSearchParams();
  const rid = params.get("rid") ?? "";
  const [info, setInfo] = useState<OAuthAuthorizeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "approve" | "deny">(null);

  // Not signed in: remember where to come back to, then send to login.
  useEffect(() => {
    if (!session && rid) {
      try {
        sessionStorage.setItem("collective.postLogin", `/connect?rid=${encodeURIComponent(rid)}`);
      } catch {
        /* sessionStorage unavailable — the flow still works via re-navigation */
      }
    }
  }, [session, rid]);

  useEffect(() => {
    if (!session || !rid) return;
    let alive = true;
    getOAuthAuthorizeInfo(rid)
      .then((i) => alive && setInfo(i))
      .catch((err) =>
        alive &&
        setError(
          err instanceof ApiError && err.status === 404
            ? "This connection request has expired or was already used. Start again from Claude."
            : "Couldn't load this connection request.",
        ),
      );
    return () => {
      alive = false;
    };
  }, [session, rid]);

  if (!rid) return <Navigate to="/" replace />;
  if (!session) return <Navigate to="/login" replace />;

  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "deny");
    try {
      const { redirectTo } = await postOAuthDecision(rid, approve);
      window.location.assign(redirectTo); // leaves the SPA back to Claude
    } catch {
      setError("Couldn't complete this request. It may have expired — start again from Claude.");
      setBusy(null);
    }
  };

  return (
    <main className="login-page">
      <div className="login-card">
        <h1 className="login-wordmark">Collective</h1>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : !info ? (
          <p className="login-sub">Loading…</p>
        ) : (
          <>
            <p className="login-sub">
              <strong>{info.clientName}</strong> wants to connect to your Collective account.
            </p>
            <p className="detail-muted">It will be able to, on your behalf:</p>
            <ul className="consent-scopes">
              {info.scopes.map((s) => (
                <li key={s}>{SCOPE_LABELS[s] ?? s}</li>
              ))}
            </ul>
            <p className="detail-muted">
              It only ever sees what you can — never audio, never anyone else's private notes, and
              patient-info-flagged meetings stay hidden unless the workspace BAA allows them. Every request
              is permission-checked and audited. Signed in as {user?.displayName}.
            </p>
            <button
              type="button"
              className="btn btn-block"
              disabled={busy !== null}
              onClick={() => void decide(true)}
            >
              {busy === "approve" ? "Connecting…" : `Allow ${info.clientName}`}
            </button>
            <button
              type="button"
              className="btn-quiet btn-block"
              disabled={busy !== null}
              onClick={() => void decide(false)}
            >
              {busy === "deny" ? "Cancelling…" : "Deny"}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
