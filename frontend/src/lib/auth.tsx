import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "./api";
import type { Me } from "./types";

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (perm: string) => boolean;
  refresh: () => Promise<void>;
  logout: (reason?: string) => Promise<void>;
  logoutReason: string | null;
}

const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [logoutReason, setLogoutReason] = useState<string | null>(null);
  const lastActivity = useRef(Date.now());

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/auth/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async (reason?: string) => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* already gone */
    }
    setLogoutReason(reason ?? null);
    setMe(null);
  }, []);

  useEffect(() => {
    refresh();
    setUnauthorizedHandler(() => {
      setLogoutReason("Your session expired. Please sign in again.");
      setMe(null);
    });
  }, [refresh]);

  // Client-side idle logout mirrors the server's idle timeout
  useEffect(() => {
    if (!me) return;
    const bump = () => (lastActivity.current = Date.now());
    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current > me.session_idle_minutes * 60_000) {
        logout("You were signed out after a period of inactivity.");
      }
    }, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(timer);
    };
  }, [me, logout]);

  const can = useCallback((perm: string) => !!me?.permissions.includes(perm), [me]);

  return <Ctx.Provider value={{ me, loading, can, refresh, logout, logoutReason }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
