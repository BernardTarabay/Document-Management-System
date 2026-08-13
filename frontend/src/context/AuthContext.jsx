import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { api, setTokens, getAccessToken, setUnauthorizedHandler } from "../services/apiClient";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | authenticated | anonymous

  const loadSession = useCallback(async () => {
    if (!getAccessToken()) {
      setStatus("anonymous");
      return;
    }
    try {
      const session = await api.get("/auth/me");
      setUser(session);
      setStatus("authenticated");
    } catch {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setTokens(null);
      setUser(null);
      setStatus("anonymous");
    });
    loadSession();
  }, [loadSession]);

  const login = useCallback(async (email, password) => {
    const data = await api.post("/auth/login", { email, password });
    setTokens(data);
    await loadSession();
    return data;
  }, [loadSession]);

  const register = useCallback(async (email, password, fullName) => {
    const data = await api.post("/auth/register", { email, password, fullName });
    setTokens(data);
    await loadSession();
    return data;
  }, [loadSession]);

  const logout = useCallback(async () => {
    try {
      const refreshToken = localStorage.getItem("atlas.refreshToken");
      if (refreshToken) await api.post("/auth/logout", { refreshToken });
    } catch {
      // best-effort revoke; clear local state regardless
    }
    setTokens(null);
    setUser(null);
    setStatus("anonymous");
  }, []);

  const hasPermission = useCallback(
    (key) => Boolean(user?.permissions?.includes(key)),
    [user]
  );

  const value = useMemo(
    () => ({ user, status, login, register, logout, hasPermission, refresh: loadSession }),
    [user, status, login, register, logout, hasPermission, loadSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
