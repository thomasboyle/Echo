import React, { useEffect } from "react";
import Login from "./components/Login";
import MainApp from "./components/MainApp";
import { useAuth } from "./hooks/useAuth";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

function App() {
  const { token, serverUrl, user, loading, login, logout, refreshUser } = useAuth();

  useEffect(() => {
    if (!token || !serverUrl?.trim()) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        await update.downloadAndInstall();
        if (!cancelled) await relaunch();
      } catch (_) {}
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [token, serverUrl]);

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "var(--bg-darkest)",
        }}
      >
        <div style={{ color: "var(--text-muted)" }}>Loading...</div>
      </div>
    );
  }

  if (!token || !serverUrl?.trim()) {
    return <Login onLogin={login} />;
  }

  return <MainApp user={user} onLogout={logout} onProfileSaved={refreshUser} />;
}

export default App;
