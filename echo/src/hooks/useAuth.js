import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, setServerConfig } from "../api/client";

export function useAuth() {
  const [token, setTokenState] = useState(null);
  const [serverUrl, setServerUrlState] = useState("");
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadStored = useCallback(async () => {
    try {
      await new Promise((r) => setTimeout(r, 100));
      const [t, url] = await Promise.all([
        invoke("get_token").catch(() => null),
        invoke("get_server_url").catch(() => ""),
      ]);
      const normalized =
        url && typeof url === "string"
          ? (url.trim().startsWith("http") ? url.trim() : `http://${url.trim()}`).replace(/\/$/, "")
          : "";
      setTokenState(t || null);
      setServerUrlState(normalized);
      if (t && normalized.startsWith("http")) {
        setServerConfig(normalized, t);
        const me = await api.getMe();
        setUser(me);
      } else {
        setServerConfig("", "");
        setUser(null);
      }
    } catch {
      setTokenState(null);
      setUser(null);
      setServerConfig("", "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStored();
  }, [loadStored]);

  useEffect(() => {
    if (token && serverUrl) {
      const base = serverUrl.startsWith("http") ? serverUrl : `http://${serverUrl}`;
      setServerConfig(base.replace(/\/$/, ""), token);
    } else if (!token) {
      setServerConfig("", "");
    }
  }, [token, serverUrl]);

  const setToken = useCallback(async (newToken) => {
    setTokenState(newToken || null);
    if (!newToken) setUser(null);
    try {
      await invoke("save_token", { token: newToken || "" });
    } catch (_) {}
  }, []);

  const setServerUrl = useCallback(async (url) => {
    setServerUrlState(url || "");
    try {
      await invoke("save_server_url", { url: url || "" });
    } catch (_) {}
  }, []);

  const login = useCallback(async (url, authToken, userData) => {
    const normalized =
      url && typeof url === "string"
        ? (url.trim().startsWith("http") ? url.trim() : `http://${url.trim()}`).replace(/\/$/, "")
        : "";
    setServerConfig(normalized || url || "", authToken);
    setTokenState(authToken);
    setServerUrlState(normalized || url || "");
    setUser(userData);
    const toSave = normalized || url || "";
    try {
      await invoke("save_server_url", { url: toSave });
      await invoke("save_token", { token: authToken });
    } catch (_) {}
  }, []);

  const logout = useCallback(async () => {
    setServerConfig("", "");
    setTokenState(null);
    setServerUrlState("");
    setUser(null);
    try {
      await invoke("save_token", { token: "" });
    } catch (_) {}
  }, []);

  const refreshUser = useCallback(async () => {
    if (!token) return;
    try {
      const me = await api.getMe();
      setUser(me);
    } catch (_) {}
  }, [token]);

  return {
    token,
    serverUrl,
    user,
    loading,
    isAuthenticated: !!token,
    setToken,
    setServerUrl,
    login,
    logout,
    refreshUser,
    loadStored,
  };
}
