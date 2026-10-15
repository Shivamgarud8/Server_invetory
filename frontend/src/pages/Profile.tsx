import { Fragment, useState, type FormEvent } from "react";
import { PageHead } from "../components/Layout";
import { StrengthMeter } from "../components/PasswordGenerator";
import { EnvBadge, Field, useUi } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { MODULE_LABELS } from "./Users";
import { ThemeSwitcher } from "../lib/theme";

export function Profile() {
  const { me, refresh } = useAuth();
  const { toast } = useUi();
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [setup, setSetup] = useState<{ secret: string; qr_svg: string } | null>(null);
  const [code, setCode] = useState("");
  const [disablePw, setDisablePw] = useState("");
  if (!me) return null;

  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return toast("Passwords do not match", true);
    try {
      await api.post("/auth/change-password", { current_password: cur, new_password: pw });
      toast("Password changed — other sessions signed out");
      setCur(""); setPw(""); setPw2("");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const startMfa = async () => {
    try {
      setSetup(await api.post("/auth/totp/setup"));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const confirmMfa = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/auth/totp/confirm", { code });
      toast("Two-factor authentication enabled");
      setSetup(null); setCode("");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const disableMfa = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/auth/totp/disable", { password: disablePw, code });
      toast("Two-factor authentication disabled");
      setDisablePw(""); setCode("");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const byModule = me.permissions.reduce<Record<string, string[]>>((acc, p) => {
    const [m, a] = p.split(".");
    (acc[m] ||= []).push(a.replace("_", " "));
    return acc;
  }, {});

  return (
    <>
      <PageHead title="My profile" sub={`${me.full_name || me.username} · ${me.roles.join(", ") || "no role"}`} />
      <div className="grid grid-2">
        <div className="card card-pad">
          <h2>My access</h2>
          <dl className="kv">
            <dt>Username</dt><dd className="mono">{me.username}</dd>
            <dt>Email</dt><dd>{me.email || "—"}</dd>
            <dt>Environments</dt><dd className="row wrap">{me.all_environments ? <span className="badge gray">All environments</span> : me.environments.map((e) => <EnvBadge key={e.id} env={e} />)}</dd>
            {Object.entries(byModule).map(([m, acts]) => <Fragment key={m}><dt>{MODULE_LABELS[m] || m}</dt><dd>{acts.join(", ")}</dd></Fragment>)}
          </dl>
        </div>

        <div className="card card-pad">
          <h2>Two-factor authentication</h2>
          {me.totp_enabled ? (
            <form className="grid" style={{ gap: 12 }} onSubmit={disableMfa}>
              <div className="alert info">✓ 2FA is enabled on your account.</div>
              <Field label="Password"><input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} required /></Field>
              <Field label="Current code"><input className="mono" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
              <div><button className="btn danger">Disable 2FA</button></div>
            </form>
          ) : setup ? (
            <form className="grid" style={{ gap: 12 }} onSubmit={confirmMfa}>
              <p className="muted" style={{ margin: 0 }}>Scan with Google Authenticator, Microsoft Authenticator, 1Password, Authy…</p>
              <div className="qr" dangerouslySetInnerHTML={{ __html: setup.qr_svg }} />
              <div className="small muted">Or enter manually: <span className="mono">{setup.secret}</span></div>
              <Field label="6-digit code"><input className="mono" inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
              <div className="row"><button className="btn primary">Enable 2FA</button><button type="button" className="btn" onClick={() => setSetup(null)}>Cancel</button></div>
            </form>
          ) : (
            <div className="grid" style={{ gap: 12 }}>
              <div className="alert warn">2FA is not enabled. Strongly recommended for an account with access to infrastructure credentials.</div>
              <div><button className="btn primary" onClick={startMfa}>Set up 2FA</button></div>
            </div>
          )}
        </div>

        <div className="card card-pad grid" style={{ gap: 12, alignContent: "start" }}>
          <h2 style={{ margin: 0 }}>Appearance</h2>
          <p className="muted small" style={{ margin: 0 }}>Theme is saved in this browser. "System" follows your operating system's light/dark setting.</p>
          <div><ThemeSwitcher labels /></div>
        </div>

        <form className="card card-pad grid" style={{ gap: 12 }} onSubmit={changePw}>
          <h2 style={{ margin: 0 }}>Change password</h2>
          <Field label="Current password"><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
          <Field label="New password"><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
          <StrengthMeter value={pw} />
          <Field label="Confirm new password"><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
          <div><button className="btn primary">Change password</button></div>
        </form>
      </div>
    </>
  );
}
