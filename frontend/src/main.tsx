import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Forbidden, Layout } from "./components/Layout";
import { UiProvider } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import { AuditLogs } from "./pages/AuditLogs";
import { Credentials } from "./pages/Credentials";
import { Dashboard } from "./pages/Dashboard";
import { GeneratorPage } from "./pages/GeneratorPage";
import { ImportPage } from "./pages/ImportPage";
import { ForcePasswordChange, Login } from "./pages/Login";
import { Profile } from "./pages/Profile";
import { Roles } from "./pages/Roles";
import { ServerDetail } from "./pages/ServerDetail";
import { Servers } from "./pages/Servers";
import { SettingsPage } from "./pages/Settings";
import { Users } from "./pages/Users";
import { Versions } from "./pages/Versions";
import "./styles.css";

// Apply the saved theme before first paint to avoid a light/dark flash
try {
  const t = localStorage.getItem("tagid.theme");
  const dark = t === "dark" || ((!t || t === "system") && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch {
  /* ignore */
}

function Guard({ perm, children }: { perm?: string; children: React.ReactNode }) {
  const { can } = useAuth();
  return <>{!perm || can(perm) ? children : <Forbidden />}</>;
}

function App() {
  const { me, loading, can } = useAuth();
  if (loading) return null;
  if (!me) return <Login />;
  if (me.must_change_password) return <ForcePasswordChange />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={can("dashboard.view") ? <Dashboard /> : <Profile />} />
        <Route path="credentials" element={<Guard perm="credentials.view"><Credentials /></Guard>} />
        <Route path="servers" element={<Guard perm="servers.view"><Servers /></Guard>} />
        <Route path="servers/:id" element={<Guard perm="servers.view"><ServerDetail /></Guard>} />
        <Route path="versions" element={<Guard perm="versions.view"><Versions /></Guard>} />
        <Route path="generator" element={<GeneratorPage />} />
        <Route path="users" element={<Guard perm="users.view"><Users /></Guard>} />
        <Route path="roles" element={<Guard perm="users.view"><Roles /></Guard>} />
        <Route path="audit" element={<Guard perm="audit.view"><AuditLogs /></Guard>} />
        <Route path="import" element={<Guard perm="import.run"><ImportPage /></Guard>} />
        <Route path="settings" element={<Guard perm="settings.manage"><SettingsPage /></Guard>} />
        <Route path="profile" element={<Profile />} />
        <Route path="*" element={<div className="empty">Page not found</div>} />
      </Route>
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <UiProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </UiProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
