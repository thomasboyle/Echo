import React, { useState } from "react";
import { api, FIXED_SERVER_URL, setServerConfig } from "../api/client";
import styles from "./Login.module.css";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    setServerConfig(FIXED_SERVER_URL, "");
    try {
      if (mode === "register") {
        const res = await api.register(username, password, displayName || username);
        await onLogin(FIXED_SERVER_URL, res.token, res.user);
      } else {
        const res = await api.login(username, password);
        await onLogin(FIXED_SERVER_URL, res.token, res.user);
      }
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        <h1 className={styles.logo}>NEXUS</h1>
        <form onSubmit={handleSubmit} className={styles.form}>
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={styles.input}
            required
            disabled={loading}
          />
          {mode === "register" && (
            <input
              type="text"
              placeholder="Display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={styles.input}
              disabled={loading}
            />
          )}
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={styles.input}
            required
            disabled={loading}
          />
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={loading}>
              {loading ? "..." : mode === "login" ? "Sign In" : "Create Account"}
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError("");
              }}
              disabled={loading}
            >
              {mode === "login" ? "Create Account" : "Sign In"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
