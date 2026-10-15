import { PageHead } from "../components/Layout";
import { GeneratorPanel } from "../components/PasswordGenerator";

export function GeneratorPage() {
  return (
    <>
      <PageHead title="Password Generator" sub="Cryptographically secure passwords, generated locally in your browser. Shortcut: Ctrl+Shift+G, or triple-click 🔑 in the top bar." />
      <div className="card card-pad" style={{ maxWidth: 760 }}>
        <GeneratorPanel />
      </div>
    </>
  );
}
