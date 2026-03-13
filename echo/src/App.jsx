import React, { useEffect, useState } from "react";
import Login from "./components/Login";
import MainApp from "./components/MainApp";
import { useAuth } from "./hooks/useAuth";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

function App() {
  const { token, serverUrl, user, loading, login, logout, refreshUser } = useAuth();
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!token || !serverUrl?.trim()) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        setPendingUpdate(update);
      } catch (_) {}
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [token, serverUrl]);

  const handleInstallUpdate = async () => {
    if (!pendingUpdate || updating) return;
    setUpdating(true);
    try {
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    } catch (_) {
      setUpdating(false);
    }
  };

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

  return (
    <>
      <MainApp user={user} onLogout={logout} onProfileSaved={refreshUser} />
      {pendingUpdate && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
          }}
        >
          <div
            style={{
              background: "var(--bg-dark)",
              color: "var(--text-primary)",
              padding: 24,
              borderRadius: 8,
              maxWidth: 360,
              boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{ fontSize: 18, marginBottom: 8 }}>Update available</div>
            <div style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 16 }}>
              Version {pendingUpdate.version} is available. Download and restart now?
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setPendingUpdate(null)}
                style={{
                  background: "var(--bg-mid)",
                  color: "var(--text-primary)",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Later
              </button>
              <button
                type="button"
                onClick={handleInstallUpdate}
                disabled={updating}
                style={{
                  background: "var(--bg-hover)",
                  color: "var(--text-primary)",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: 4,
                  cursor: updating ? "wait" : "pointer",
                }}
              >
                {updating ? "Downloading..." : "Update"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
