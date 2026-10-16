import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { copyText } from "./PasswordGenerator";
import { useUi } from "./ui";

const AUTO_HIDE_MS = 20_000;

/** Masked password with Show / Copy. Each action is a separate audited server call; nothing is cached. */
export function SecretCell({ credentialId, hasSecret }: { credentialId: number; hasSecret: boolean }) {
  const { can } = useAuth();
  const { toast } = useUi();
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number>();

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!hasSecret) return <span className="muted small">no password</span>;
  if (!can("credentials.view_password")) return <span className="secret"><span className="val" title="You do not have permission to view passwords">••••••••••</span></span>;

  const fetchSecret = (purpose: "view" | "copy") =>
    api.post<{ password: string }>(`/credentials/${credentialId}/reveal`, { purpose }).then((r) => r.password);

  const toggle = async () => {
    if (shown !== null) {
      setShown(null);
      return;
    }
    setBusy(true);
    try {
      setShown(await fetchSecret("view"));
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setShown(null), AUTO_HIDE_MS);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    setBusy(true);
    try {
      await copyText(await fetchSecret("copy"));
      toast(window.isSecureContext ? "Password copied — clipboard clears in 30s" : "Password copied");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="secret" onClick={(e) => e.stopPropagation()}>
      <span className={`val ${shown !== null ? "shown" : ""}`}>{shown ?? "••••••••••"}</span>
      <button className="icon-btn" disabled={busy} onClick={toggle} title={shown !== null ? "Hide" : "Show password"}>{shown !== null ? "🙈" : "👁"}</button>
      <button className="icon-btn" disabled={busy} onClick={copy} title="Copy password">⧉</button>
    </span>
  );
}
