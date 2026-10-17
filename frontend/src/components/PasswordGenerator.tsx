import { useCallback, useEffect, useState } from "react";
import { DEFAULT_GEN, generatePassword, strength, suggestPasswords, type GenOptions } from "../lib/password";
import { Modal, useUi } from "./ui";

const PREFS_KEY = "tagid.generator.prefs";

function loadPrefs(): GenOptions {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    // Only option toggles are remembered — never any generated value
    return raw ? { ...DEFAULT_GEN, ...JSON.parse(raw) } : DEFAULT_GEN;
  } catch {
    return DEFAULT_GEN;
  }
}

/** Fallback for plain-http pages, where browsers disable navigator.clipboard. */
function legacyCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("Copy failed — select and copy manually");
}

export async function copyText(text: string, clearAfterMs = 30_000) {
  if (!window.isSecureContext || !navigator.clipboard) {
    legacyCopy(text); // no auto-clear possible without the clipboard API
    return;
  }
  await navigator.clipboard.writeText(text);
  if (clearAfterMs) {
    setTimeout(async () => {
      try {
        if ((await navigator.clipboard.readText()) === text) await navigator.clipboard.writeText("");
      } catch {
        /* clipboard read not permitted — ignore */
      }
    }, clearAfterMs);
  }
}

export function StrengthMeter({ value }: { value: string }) {
  const s = strength(value);
  return (
    <div>
      <div className="strength"><div style={{ width: `${(s.score + 1) * 20}%`, background: s.color }} /></div>
      <div className="small muted" style={{ marginTop: 4 }}>{value ? `${s.label} · ~${s.bits} bits` : " "}</div>
    </div>
  );
}

export function GeneratorPanel({ onUse, contextHint }: { onUse?: (pw: string) => void; contextHint?: string }) {
  const { toast } = useUi();
  const [o, setO] = useState<GenOptions>(loadPrefs);
  const [kwText, setKwText] = useState(o.keywords.join(" ") || "tagid cloud");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const gen = useCallback((opts: GenOptions) => {
    try {
      setPw(generatePassword(opts));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
      setPw("");
    }
  }, []);

  useEffect(() => {
    const opts = { ...o, keywords: kwText.split(/[\s,;]+/).filter(Boolean) };
    gen(opts);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(opts));
    } catch {
      /* storage unavailable */
    }
  }, [o, kwText, gen]);

  const set = <K extends keyof GenOptions>(k: K, v: GenOptions[K]) => setO((p) => ({ ...p, [k]: v }));

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="gen-output">{pw || <span className="muted">{err || "—"}</span>}</div>
      <StrengthMeter value={pw} />
      <div className="row wrap">
        <button className="btn" onClick={() => gen({ ...o, keywords: kwText.split(/[\s,;]+/).filter(Boolean) })}>↻ Generate password</button>
        <button className="btn" disabled={!pw} onClick={() => copyText(pw).then(() => toast(window.isSecureContext ? "Copied — clipboard clears in 30s" : "Copied"))}>⧉ Copy</button>
        {onUse && <button className="btn primary" disabled={!pw} onClick={() => onUse(pw)}>✓ Use password</button>}
      </div>

      <label className="field">
        <span>Length: {o.length}</span>
        <div className="row">
          <input type="range" min={8} max={64} value={o.length} onChange={(e) => set("length", +e.target.value)} />
          <input type="number" min={8} max={128} value={o.length} style={{ width: 80 }}
            onChange={(e) => set("length", Math.max(8, Math.min(128, +e.target.value || 8)))} />
        </div>
      </label>

      <div className="row wrap" style={{ gap: 18 }}>
        <label className="check"><input type="checkbox" checked={o.upper} onChange={(e) => set("upper", e.target.checked)} /> Uppercase</label>
        <label className="check"><input type="checkbox" checked={o.lower} onChange={(e) => set("lower", e.target.checked)} /> Lowercase</label>
        <label className="check"><input type="checkbox" checked={o.digits} onChange={(e) => set("digits", e.target.checked)} /> Numbers</label>
        <label className="check"><input type="checkbox" checked={o.symbols} onChange={(e) => set("symbols", e.target.checked)} /> Symbols</label>
        <label className="check"><input type="checkbox" checked={o.excludeAmbiguous} onChange={(e) => set("excludeAmbiguous", e.target.checked)} /> Avoid look-alikes (Il1O0o)</label>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>Exclude characters</span>
          <input className="mono" value={o.exclude} placeholder="e.g. @ ' &quot; \ ` $" onChange={(e) => set("exclude", e.target.value)} />
        </label>
        <label className="field">
          <span>Keywords</span>
          <input value={kwText} placeholder="tag smart cloud devops" onChange={(e) => setKwText(e.target.value)} />
        </label>
      </div>
      <div className="row wrap" style={{ gap: 18 }}>
        <label className="check"><input type="radio" checked={!o.useKeywords} onChange={() => set("useKeywords", false)} /> Completely random</label>
        <label className="check"><input type="radio" checked={o.useKeywords} onChange={() => set("useKeywords", true)} /> Include keywords (memorable)</label>
      </div>
      <div className="card" style={{ padding: 12 }}>
        <div className="row">
          <b className="small">💡 Suggestions with your keywords</b>
          {contextHint && <button type="button" className="btn sm ghost" onClick={() => setKwText(`${kwText} ${contextHint}`.trim())} title="Add client / server words">+ {contextHint}</button>}
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => setSuggestions(suggestPasswords({ ...o, keywords: kwText.split(/[\s,;]+/).filter(Boolean) }))}>Suggest</button>
        </div>
        {suggestions.length > 0 && (
          <div className="grid" style={{ gap: 6, marginTop: 8 }}>
            {suggestions.map((sg) => (
              <div key={sg} className="row">
                <span className="mono" style={{ flex: 1, wordBreak: "break-all" }}>{sg}</span>
                <span className="small muted">{strength(sg).label}</span>
                <button type="button" className="btn sm" onClick={() => setPw(sg)}>Pick</button>
                {onUse && <button type="button" className="btn sm primary" onClick={() => onUse(sg)}>Use</button>}
              </div>
            ))}
          </div>
        )}
        <div className="small muted" style={{ marginTop: 6 }}>Keywords make it memorable; at least 12 random characters are always added, so it is never guessable from the words alone.</div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Generated in your browser with the Web Crypto secure random generator — never sent to the server or logged.
        Tip: exclude <span className="mono">$ ` ' " \</span> for passwords used in shell scripts or .env files.
      </p>
    </div>
  );
}

export function GeneratorModal({ onClose, onUse }: { onClose: () => void; onUse?: (pw: string) => void }) {
  return (
    <Modal title="Generate password" onClose={onClose}>
      <GeneratorPanel onUse={onUse ? (pw) => { onUse(pw); onClose(); } : undefined} />
    </Modal>
  );
}
