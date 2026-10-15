import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePref = "light" | "dark" | "system";

export interface PublicConfig {
  app_name: string;
  server_label: string;
  default_theme: ThemePref;
}

const KEY = "tagid.theme";
const DEFAULT_CONFIG: PublicConfig = { app_name: "TagID Infra Manager", server_label: "", default_theme: "system" };

function stored(): ThemePref | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : null;
  } catch {
    return null;
  }
}

function resolve(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface ThemeCtx {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  config: PublicConfig;
}

const Ctx = createContext<ThemeCtx>(null!);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PublicConfig>(DEFAULT_CONFIG);
  const [pref, setPrefState] = useState<ThemePref>(() => stored() ?? "system");

  useEffect(() => {
    fetch("/api/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: PublicConfig | null) => {
        if (!c) return;
        setConfig(c);
        // The server default applies until the user picks a theme themselves
        if (!stored()) setPrefState(c.default_theme);
        document.title = c.server_label ? `${c.app_name} · ${c.server_label}` : c.app_name;
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const apply = () => (document.documentElement.dataset.theme = resolve(pref));
    apply();
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* storage unavailable */
    }
  }, []);

  return <Ctx.Provider value={{ pref, setPref, config }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

const OPTIONS: { value: ThemePref; icon: string; label: string }[] = [
  { value: "light", icon: "☀", label: "Light" },
  { value: "dark", icon: "☾", label: "Dark" },
  { value: "system", icon: "🖥", label: "System" },
];

export function ThemeSwitcher({ labels = false }: { labels?: boolean }) {
  const { pref, setPref } = useTheme();
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={pref === o.value} title={`${o.label} theme`}
          className={pref === o.value ? "on" : ""} onClick={() => setPref(o.value)}>
          {o.icon}{labels && <span> {o.label}</span>}
        </button>
      ))}
    </div>
  );
}

export const AUTHOR_URL = "https://shivam-garud.vercel.app/";

export function Footer() {
  const { config } = useTheme();
  return (
    <footer className="app-footer">
      <span>© {new Date().getFullYear()} {config.app_name}</span>
      <span className="dot">·</span>
      <span>
        Designed &amp; developed by{" "}
        <a href={AUTHOR_URL} target="_blank" rel="noopener noreferrer">Shivam Garud</a>
      </span>
    </footer>
  );
}
