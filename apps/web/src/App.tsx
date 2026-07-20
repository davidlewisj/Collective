import { Component, type ReactNode } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth";
import { LoginPage } from "./pages/Login";
import { MeetingListPage } from "./pages/MeetingList";
import { CapturePage } from "./pages/Capture";
import { MeetingDetailPage } from "./pages/MeetingDetail";
import { AdminPage } from "./pages/Admin";
import { SettingsPage } from "./pages/Settings";
import { ConnectConsentPage } from "./pages/ConnectConsent";

/**
 * Last-resort error boundary: a render crash on one screen must never blank
 * the whole app. Shows a plain-language recovery screen instead.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="crash-screen" role="alert">
        <h1 className="crash-headline">Something went wrong</h1>
        <p className="crash-copy">
          This screen hit an error. Your recordings and notes are safe on the server.
        </p>
        <p className="crash-detail mono">{this.state.error.message}</p>
        <div className="crash-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              this.setState({ error: null });
              window.location.assign("/");
            }}
          >
            Back to meetings
          </button>
        </div>
      </main>
    );
  }
}

function AppRoutes() {
  const location = useLocation();
  return (
    // Keyed wrapper gives each screen a quiet fade + 4px rise on entry.
    <div className="page-enter" key={location.pathname}>
      <Routes location={location}>
        <Route path="/login" element={<LoginPage />} />
        {/* Consent handles its own auth (bounces through /login and back). */}
        <Route path="/connect" element={<ConnectConsentPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <MeetingListPage />
            </RequireAuth>
          }
        />
        <Route
          path="/capture"
          element={
            <RequireAuth>
              <CapturePage />
            </RequireAuth>
          }
        />
        <Route
          path="/m/:id"
          element={
            <RequireAuth>
              <MeetingDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <AdminPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          }
        />
        <Route
          path="*"
          element={
            <RequireAuth>
              <MeetingListPage />
            </RequireAuth>
          }
        />
      </Routes>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
