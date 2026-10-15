import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { StrengthMeter } from "../components/PasswordGenerator";
import { Footer, ThemeSwitcher, useTheme } from "../lib/theme";

export function Login() {
  const { refresh, logoutReason } = useAuth();
  const { config } = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ ok?: boolean; totp_required?: boolean }>("/auth/login", {
        username, password, totp_code: needCode ? code : null,
      });
      if (r.totp_required) {
        setNeedCode(true);
        return;
      }
      setPassword("");
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="row" style={{ marginBottom: 22 }}>
          <div className="brand-logo" style={{ color: "#fff" }}>T</div>
          <div>
            <div style={{ fontWeight: 800, letterSpacing: "0.03em" }}>TAGID INFRASTRUCTURE</div>
            <div className="muted small">Credential & Infrastructure Portal{config.server_label ? ` · ${config.server_label}` : ""}</div>
          </div>
          <span className="spacer" />
          <ThemeSwitcher />
        </div>
        {logoutReason && <div className="alert info" style={{ marginBottom: 14 }}>{logoutReason}</div>}
        {err && <div className="alert danger" style={{ marginBottom: 14 }}>{err}</div>}
        <div className="grid" style={{ gap: 14 }}>
          {!needCode ? (
            <>
              <label className="field"><span>Username</span>
                <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
              </label>
              <label className="field"><span>Password</span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
            </>
          ) : (
            <label className="field"><span>Authenticator code</span>
              <input autoFocus inputMode="numeric" autoComplete="one-time-code" className="mono" maxLength={8} placeholder="123 456"
                value={code} onChange={(e) => setCode(e.target.value)} required style={{ fontSize: 20, letterSpacing: "0.3em", textAlign: "center" }} />
            </label>
          )}
          <button className="btn primary" disabled={busy} style={{ padding: 11 }}>{busy ? "Signing in…" : needCode ? "Verify" : "Sign in"}</button>
          {needCode && <button type="button" className="btn ghost" onClick={() => { setNeedCode(false); setCode(""); }}>← Back</button>}
        </div>
        <p className="muted small" style={{ marginTop: 20, marginBottom: 0 }}>Authorised personnel only. All access is logged.</p>
      </form>
      <Footer />
    </div>
  );
}

export function ForcePasswordChange() {
  const { refresh, logout } = useAuth();
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setErr("Passwords do not match");
    try {
      await api.post("/auth/change-password", { current_password: cur, new_password: pw });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h2>Set a new password</h2>
        <p className="muted">You must change your password before continuing. Use at least 12 characters with upper, lower, number and symbol.</p>
        {err && <div className="alert danger" style={{ marginBottom: 14 }}>{err}</div>}
        <div className="grid" style={{ gap: 14 }}>
          <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
          <label className="field"><span>New password</span><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
          <StrengthMeter value={pw} />
          <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
          <button className="btn primary">Change password</button>
          <button type="button" className="btn ghost" onClick={() => logout()}>Sign out</button>
        </div>
      </form>
      <Footer />
    </div>
  );
}
