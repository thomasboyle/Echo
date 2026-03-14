import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, FIXED_SERVER_URL, setServerConfig } from "../api/client";

export function useAuth() {
  const [token, setTokenState] = useState(null);
  const [serverUrl, setServerUrlState] = useState(FIXED_SERVER_URL);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadStored = useCallback(async () => {
    try {
      await new Promise((r) => setTimeout(r, 100));
      const t = await invoke("get_token").catch(() => null);
      setTokenState(t || null);
      setServerUrlState(FIXED_SERVER_URL);
      if (t) {
        setServerConfig(FIXED_SERVER_URL, t);
        const me = await api.getMe();
        setUser(me);
      } else {
        setServerConfig(FIXED_SERVER_URL, "");
        setUser(null);
      }
    } catch {
      setTokenState(null);
      setUser(null);
      setServerConfig(FIXED_SERVER_URL, "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStored();
  }, [loadStored]);

  useEffect(() => {
    if (token) {
      setServerConfig(FIXED_SERVER_URL, token);
    } else if (!token) {
      setServerConfig(FIXED_SERVER_URL, "");
    }
  }, [token]);

  const setToken = useCallback(async (newToken) => {
    setTokenState(newToken || null);
    if (!newToken) setUser(null);
    try {
      await invoke("save_token", { token: newToken || "" });
    } catch (_) {}
  }, []);

  const setServerUrl = useCallback(async () => {
    setServerUrlState(FIXED_SERVER_URL);
    try {
      await invoke("save_server_url", { url: FIXED_SERVER_URL });
    } catch (_) {}
  }, []);

  const login = useCallback(async (_url, authToken, userData) => {
    setServerConfig(FIXED_SERVER_URL, authToken);
    setTokenState(authToken);
    setServerUrlState(FIXED_SERVER_URL);
    setUser(userData);
    try {
      await invoke("save_server_url", { url: FIXED_SERVER_URL });
      await invoke("save_token", { token: authToken });
    } catch (_) {}
  }, []);

  const logout = useCallback(async () => {
    setServerConfig(FIXED_SERVER_URL, "");
    setTokenState(null);
    setServerUrlState(FIXED_SERVER_URL);
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
