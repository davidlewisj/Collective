import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth";
import { LoginPage } from "./pages/Login";
import { MeetingListPage } from "./pages/MeetingList";
import { CapturePage } from "./pages/Capture";
import { MeetingDetailPage } from "./pages/MeetingDetail";
import { AdminPage } from "./pages/Admin";

function AppRoutes() {
  const location = useLocation();
  return (
    // Keyed wrapper gives each screen a quiet fade + 4px rise on entry.
    <div className="page-enter" key={location.pathname}>
      <Routes location={location}>
        <Route path="/login" element={<LoginPage />} />
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
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
