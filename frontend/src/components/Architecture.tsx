import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { toPng } from "html-to-image";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Credential, Deployment, Domain, Server } from "../lib/types";
import { SecretCell } from "./SecretCell";
import { EnvBadge, HealthBadge, Modal, fmtDate, useUi } from "./ui";

// ---------------------------------------------------------------- look & feel

export const SERVICE_STYLE: Record<string, { color: string; icon: string; label: string }> = {
  proxy: { color: "#3b82f6", icon: "🔀", label: "Proxy" },
  ui: { color: "#06b6d4", icon: "🖥", label: "UI" },
  api: { color: "#8b5cf6", icon: "⚙", label: "API" },
  worker: { color: "#ec4899", icon: "⛭", label: "Worker" },
  database: { color: "#f59e0b", icon: "🛢", label: "Database" },
  cache: { color: "#ef4444", icon: "⚡", label: "Cache" },
  queue: { color: "#f97316", icon: "📨", label: "Queue" },
  storage: { color: "#10b981", icon: "🗄", label: "Storage" },
  monitoring: { color: "#eab308", icon: "📈", label: "Monitoring" },
  other: { color: "#64748b", icon: "◻", label: "Other" },
};
const ROLE_COLOR: Record<string, string> = {
  proxy: "#3b82f6", application: "#8b5cf6", combined: "#6366f1", database: "#f59e0b", storage: "#10b981",
  monitoring: "#eab308", other: "#64748b",
};
const HEALTH_DOT: Record<string, string> = { healthy: "#22c55e", warning: "#f59e0b", critical: "#ef4444", offline: "#ef4444", unknown: "#94a3b8" };

type DiagramTheme = "technical" | "professional";
const ThemeCtx = createContext<DiagramTheme>("technical");

interface NodeData extends Record<string, unknown> {
  kind: "internet" | "domain" | "server" | "service" | "custom" | "note";
  ref_id?: number;
  label: string;
  subtitle?: string;
  role?: string;
  env?: string;
  env_color?: string;
  ip?: string | null;
  public_ip?: string | null;
  vpn_ip?: string | null;
  health?: string;
  credentials?: number;
  app?: string;
  service_type?: string;
  port?: number | null;
  version?: string;
  color?: string;
  text?: string;
}
type FlowNode = Node<NodeData>;

function palette(theme: DiagramTheme) {
  return theme === "technical"
    ? { bg: "#0b1020", panel: "rgba(15,23,42,0.92)", text: "#e2e8f0", muted: "#94a3b8", grid: "#1e293b", edge: "#64748b", glow: true }
    : { bg: "#f8fafc", panel: "#ffffff", text: "#0f172a", muted: "#64748b", grid: "#e2e8f0", edge: "#94a3b8", glow: false };
}

const handles = (
  <>
    <Handle type="target" position={Position.Top} style={{ opacity: 0.6 }} />
    <Handle type="source" position={Position.Bottom} style={{ opacity: 0.6 }} />
    <Handle type="target" id="l" position={Position.Left} style={{ opacity: 0.4 }} />
    <Handle type="source" id="r" position={Position.Right} style={{ opacity: 0.4 }} />
  </>
);

function ServerNode({ data, selected }: NodeProps<FlowNode>) {
  const theme = useContext(ThemeCtx);
  const p = palette(theme);
  const c = data.color || ROLE_COLOR[data.role || "other"] || "#64748b";
  return (
    <div style={{
      width: "100%", height: "100%", borderRadius: 14, border: `2px solid ${c}`, background: theme === "technical" ? `${c}14` : `${c}0d`,
      boxShadow: p.glow ? `0 0 18px ${c}55` : "0 2px 8px rgba(15,23,42,0.08)", color: p.text, position: "relative",
    }}>
      <NodeResizer isVisible={selected} minWidth={220} minHeight={90} color={c} />
      {handles}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: `1px dashed ${c}66` }}>
        <span style={{ width: 9, height: 9, borderRadius: 9, background: HEALTH_DOT[data.health || "unknown"] }} title={data.health} />
        <b style={{ fontSize: 14 }}>🖧 {data.label}</b>
        <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 9, background: c, color: "#fff", textTransform: "uppercase" }}>{data.role}</span>
        {data.env && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 9, background: data.env_color, color: "#fff" }}>{data.env}</span>}
      </div>
      <div style={{ padding: "4px 12px", fontSize: 11.5, color: p.muted, fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        title={[data.ip, data.public_ip && `public ${data.public_ip}`, data.vpn_ip && `vpn ${data.vpn_ip}`].filter(Boolean).join(" · ")}>
        {data.ip || "no IP"}{data.public_ip && data.public_ip !== data.ip ? ` · pub ${data.public_ip}` : ""}{data.vpn_ip ? ` · vpn ${data.vpn_ip}` : ""}
        {data.credentials ? ` · 🔐${data.credentials}` : ""}
      </div>
    </div>
  );
}

function ServiceNode({ data, selected }: NodeProps<FlowNode>) {
  const theme = useContext(ThemeCtx);
  const p = palette(theme);
  const s = SERVICE_STYLE[data.service_type || "other"] || SERVICE_STYLE.other;
  const c = data.color || s.color;
  return (
    <div style={{
      width: "100%", height: "100%", borderRadius: 10, background: theme === "technical" ? `linear-gradient(135deg, ${c}33, ${c}11)` : "#fff",
      border: `1.5px solid ${c}`, color: p.text, padding: "6px 10px", display: "flex", flexDirection: "column", justifyContent: "center",
      boxShadow: p.glow ? `0 0 10px ${c}44` : "0 1px 3px rgba(15,23,42,0.1)", borderLeft: `5px solid ${c}`,
    }}>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={44} color={c} />
      {handles}
      <div style={{ fontWeight: 700, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.icon} {data.label}</div>
      <div style={{ fontSize: 10.5, color: p.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {data.app && data.app !== data.label ? `${data.app} · ` : ""}{data.port ? `:${data.port}` : s.label}{data.version && data.version !== "-" ? ` · ${data.version}` : ""}
      </div>
    </div>
  );
}

function InfraNode({ data, selected }: NodeProps<FlowNode>) {
  const theme = useContext(ThemeCtx);
  const p = palette(theme);
  const isInternet = data.kind === "internet";
  const c = data.color || (isInternet ? "#0ea5e9" : "#14b8a6");
  return (
    <div style={{
      minWidth: 200, padding: "10px 16px", borderRadius: isInternet ? 40 : 12, border: `2px solid ${c}`, color: p.text,
      background: theme === "technical" ? `${c}22` : "#fff", textAlign: "center", boxShadow: p.glow ? `0 0 14px ${c}55` : "0 1px 4px rgba(15,23,42,0.1)",
    }}>
      <NodeResizer isVisible={selected} minWidth={140} minHeight={40} color={c} />
      {handles}
      <div style={{ fontWeight: 700, fontSize: 13 }}>{isInternet ? "🌍" : "🌐"} {data.label}</div>
      {data.subtitle && <div style={{ fontSize: 11, color: p.muted, fontFamily: "ui-monospace, monospace" }}>{data.subtitle}</div>}
    </div>
  );
}

function CustomNode({ data, selected }: NodeProps<FlowNode>) {
  const theme = useContext(ThemeCtx);
  const p = palette(theme);
  const c = data.color || "#6366f1";
  const note = data.kind === "note";
  return (
    <div style={{
      width: "100%", height: "100%", minWidth: 140, minHeight: 50, borderRadius: note ? 4 : 12, padding: "8px 12px", color: note ? "#422006" : p.text,
      background: note ? "#fef08a" : theme === "technical" ? `${c}22` : "#fff", border: note ? "1px solid #eab308" : `2px dashed ${c}`,
      fontSize: 12.5, whiteSpace: "pre-wrap", overflow: "hidden",
    }}>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={44} color={c} />
      {handles}
      <b>{data.label}</b>
      {data.text && <div style={{ marginTop: 4, fontSize: 11.5 }}>{data.text}</div>}
    </div>
  );
}

const nodeTypes = { server: ServerNode, service: ServiceNode, infra: InfraNode, custom: CustomNode };

// ---------------------------------------------------------------- layout merge / save

interface SavedLayout {
  nodes: { id: string; type?: string; position: { x: number; y: number }; width?: number; height?: number; parentId?: string; data?: Partial<NodeData> }[];
  edges: Edge[];
  theme?: DiagramTheme;
}

function styleEdge(e: Edge, theme: DiagramTheme): Edge {
  const kind = (e.data as { kind?: string } | undefined)?.kind;
  const p = palette(theme);
  const color = kind === "dependency" ? "#8b5cf6" : kind === "route" ? "#3b82f6" : kind === "dns" ? "#0ea5e9" : kind === "manual" ? "#10b981" : p.edge;
  return {
    ...e,
    type: "smoothstep",
    animated: kind === "dependency" || kind === "route",
    markerEnd: { type: MarkerType.ArrowClosed, color },
    style: { stroke: color, strokeWidth: kind === "inferred" ? 1.2 : 2, strokeDasharray: kind === "inferred" ? "5 5" : undefined },
    labelStyle: { fill: p.text, fontSize: 11, fontWeight: 600 },
    labelBgStyle: { fill: p.panel, fillOpacity: 0.9 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
  };
}

function merge(gen: { nodes: FlowNode[]; edges: Edge[] }, saved: SavedLayout | null, theme: DiagramTheme) {
  const byId = new Map((saved?.nodes || []).map((n) => [n.id, n]));
  const nodes: FlowNode[] = gen.nodes.map((n) => {
    const s = byId.get(n.id);
    if (!s) return n;
    const style = { ...(n.style || {}) } as Record<string, unknown>;
    if (s.width) style.width = s.width;
    if (s.height) style.height = s.height;
    return { ...n, position: s.position, style, data: { ...n.data, ...(s.data?.label ? { label: s.data.label } : {}), ...(s.data?.color ? { color: s.data.color } : {}) } };
  });
  for (const s of saved?.nodes || []) {
    if ((s.data?.kind === "custom" || s.data?.kind === "note") && !nodes.some((n) => n.id === s.id)) {
      nodes.push({ id: s.id, type: "custom", position: s.position, style: { width: s.width || 180, height: s.height || 70 }, data: s.data as NodeData });
    }
  }
  const ids = new Set(nodes.map((n) => n.id));
  const manual = (saved?.edges || []).filter((e) => (e.data as { kind?: string })?.kind === "manual" && ids.has(e.source) && ids.has(e.target));
  const edges = [...gen.edges, ...manual].filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => styleEdge(e, theme));
  return { nodes, edges };
}

function toSaved(nodes: FlowNode[], edges: Edge[], theme: DiagramTheme): SavedLayout {
  return {
    theme,
    nodes: nodes.map((n) => ({
      id: n.id, type: n.type, position: n.position, parentId: n.parentId,
      width: n.width ?? (n.style?.width as number | undefined), height: n.height ?? (n.style?.height as number | undefined),
      data: n.data.kind === "custom" || n.data.kind === "note"
        ? { kind: n.data.kind, label: n.data.label, text: n.data.text, color: n.data.color }
        : { kind: n.data.kind, ...(n.data.color ? { color: n.data.color } : {}), ...(n.data._renamed ? { label: n.data.label } : {}) },
    })),
    edges: edges.filter((e) => (e.data as { kind?: string })?.kind === "manual")
      .map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, label: e.label, data: e.data })),
  };
}

// ---------------------------------------------------------------- detail panel

function NodeDetail({ node, onClose }: { node: FlowNode; onClose: () => void }) {
  const d = node.data;
  const { can } = useAuth();
  const [server, setServer] = useState<Server | null>(null);
  const [services, setServices] = useState<Deployment[]>([]);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [domain, setDomain] = useState<Domain | null>(null);

  useEffect(() => {
    if (d.kind === "server" && d.ref_id) {
      api.get<Server>(`/servers/${d.ref_id}`).then(setServer).catch(() => undefined);
      if (can("versions.view")) api.get<Deployment[]>("/deployments", { server_id: d.ref_id }).then(setServices).catch(() => undefined);
      if (can("credentials.view")) api.get<Credential[]>("/credentials", { server_id: d.ref_id }).then(setCreds).catch(() => undefined);
    }
    if (d.kind === "service" && d.ref_id) {
      if (can("credentials.view")) api.get<Credential[]>("/credentials", { service_id: d.ref_id }).then(setCreds).catch(() => undefined);
      api.get<Deployment[]>("/deployments").then((all) => setServices(all.filter((x) => x.id === d.ref_id))).catch(() => undefined);
    }
    if (d.kind === "domain" && d.ref_id) api.get<Domain[]>("/domains").then((all) => setDomain(all.find((x) => x.id === d.ref_id) || null)).catch(() => undefined);
  }, [d.kind, d.ref_id, can]);

  const ip = (t: string) => server?.networks.filter((n) => n.ip_type === t).map((n) => n.ip_address.split("/")[0]).join(", ") || "—";
  const svc = d.kind === "service" ? services[0] : null;

  return (
    <Modal wide title={<span>{d.kind === "server" ? "🖧" : d.kind === "service" ? SERVICE_STYLE[d.service_type || "other"]?.icon : "🌐"} {d.label}</span>} onClose={onClose}>
      {d.kind === "server" && server && (
        <div className="grid grid-2">
          <dl className="kv">
            <dt>Role</dt><dd>{server.role} · {server.server_type}</dd>
            <dt>Environment</dt><dd><EnvBadge env={server.environment} /></dd>
            <dt>Status</dt><dd><HealthBadge status={server.health_status} detail={server.health_detail} at={server.health_checked_at} /></dd>
            <dt>Private IP</dt><dd className="mono">{ip("private")}</dd>
            <dt>Public IP</dt><dd className="mono">{ip("public")}</dd>
            <dt>VPN IP</dt><dd className="mono">{ip("vpn")}</dd>
            <dt>SSH</dt><dd className="mono">{server.ssh_user ? `ssh ${server.ssh_port && server.ssh_port !== 22 ? `-p ${server.ssh_port} ` : ""}${server.ssh_user}@${ip("private") !== "—" ? ip("private").split(",")[0] : ip("public").split(",")[0]}` : "—"}</dd>
            <dt>Auth</dt><dd>{server.ssh_auth_method || "—"}{server.ssh_key_ref ? ` · key: ${server.ssh_key_ref}` : ""}</dd>
            <dt>OS</dt><dd>{[server.os_name, server.os_version].filter(Boolean).join(" ") || "—"}</dd>
            <dt>Spec</dt><dd>{server.spec?.cpu_cores ?? "–"} vCPU · {server.spec?.ram_gb ?? "–"} GB RAM · {server.spec?.disk_gb ?? "–"} GB</dd>
            <dt>Docker</dt><dd className="mono">{server.docker_version || "—"} / compose {server.compose_version || "—"}</dd>
            <dt>Ports</dt><dd className="mono" style={{ whiteSpace: "pre-wrap" }}>{server.exposed_ports || "—"}</dd>
          </dl>
          <div>
            <h3>Services</h3>
            {services.length ? services.map((s) => (
              <div key={s.id} className="row" style={{ marginBottom: 4 }}>
                <span>{SERVICE_STYLE[s.service_type]?.icon}</span><b>{s.component}</b>
                <span className="muted small">{s.application.name}{s.port ? ` :${s.port}` : ""}</span>
                <span className="spacer" /><span className="mono small">{s.current_version}</span>
              </div>
            )) : <p className="muted small">None recorded</p>}
            <h3 style={{ marginTop: 14 }}>Recovery</h3>
            <p className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{server.recovery_instructions || server.backup_policy || <span className="muted">No recovery notes yet</span>}</p>
          </div>
        </div>
      )}
      {svc && (
        <dl className="kv">
          <dt>Application</dt><dd>{svc.application.name} / {svc.component}</dd>
          <dt>Type</dt><dd>{SERVICE_STYLE[svc.service_type]?.label}</dd>
          <dt>Server</dt><dd>{svc.server?.name || "—"} <EnvBadge env={svc.environment} /></dd>
          <dt>Port</dt><dd className="mono">{svc.port ?? "—"} {svc.protocol}</dd>
          <dt>Version</dt><dd className="mono">{svc.current_version}{svc.previous_version ? ` (prev ${svc.previous_version})` : ""}</dd>
          <dt>Image</dt><dd className="mono small">{svc.image || "—"}</dd>
          <dt>Health URL</dt><dd className="small">{svc.health_url || "—"}</dd>
          <dt>Deployed</dt><dd>{fmtDate(svc.deployed_at, true)}</dd>
          <dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{svc.notes || "—"}</dd>
        </dl>
      )}
      {domain && (
        <dl className="kv">
          <dt>Record</dt><dd className="mono">{domain.record_type} → {domain.target || "—"}</dd>
          <dt>Server</dt><dd>{domain.server?.name || "—"}</dd>
          <dt>DNS provider</dt><dd>{domain.dns_provider || "—"}</dd>
          <dt>SSL</dt><dd>{domain.ssl_provider || "—"}{domain.ssl_expires_at ? ` · expires ${fmtDate(domain.ssl_expires_at)}` : ""}</dd>
          <dt>Status</dt><dd><HealthBadge status={domain.health_status} detail={domain.health_detail} at={domain.health_checked_at} /></dd>
          <dt>Purpose</dt><dd>{domain.purpose || "—"}</dd>
        </dl>
      )}
      {(d.kind === "custom" || d.kind === "note") && <p style={{ whiteSpace: "pre-wrap" }}>{d.text || <span className="muted">No description</span>}</p>}
      {(d.kind === "server" || d.kind === "service") && (
        <>
          <h3 style={{ marginTop: 18 }}>🔐 Credentials</h3>
          {!can("credentials.view") ? <p className="muted small">You don't have permission to see credentials.</p> : creds.length ? (
            <table className="tbl">
              <thead><tr><th>Name</th><th>Type</th><th>Username</th><th>Port</th><th>Password</th></tr></thead>
              <tbody>{creds.map((c) => (
                <tr key={c.id}><td><b>{c.name}</b></td><td><span className="badge gray">{c.credential_type.name}</span></td>
                  <td className="mono">{c.username}</td><td className="mono">{c.port}</td><td><SecretCell credentialId={c.id} hasSecret={c.has_secret} /></td></tr>
              ))}</tbody>
            </table>
          ) : <p className="muted small">No credentials linked.</p>}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- editor

function Editor({ clientId, clientName }: { clientId: number; clientName: string }) {
  const { can } = useAuth();
  const { toast, confirm } = useUi();
  const rf = useReactFlow<FlowNode, Edge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [theme, setTheme] = useState<DiagramTheme>("technical");
  const [info, setInfo] = useState<{ saved_at: string | null; saved_by: string | null }>({ saved_at: null, saved_by: null });
  const [detail, setDetail] = useState<FlowNode | null>(null);
  const [dirty, setDirty] = useState(false);
  const editable = can("clients.update");
  const p = palette(theme);

  const load = useCallback(async (ignoreSaved = false) => {
    const r = await api.get<{ generated: { nodes: FlowNode[]; edges: Edge[] }; saved: SavedLayout | null; saved_at: string | null; saved_by: string | null }>(`/clients/${clientId}/architecture`);
    const t = (!ignoreSaved && r.saved?.theme) || theme;
    const m = merge(r.generated, ignoreSaved ? null : r.saved, t);
    setTheme(t);
    setNodes(m.nodes);
    setEdges(m.edges);
    setInfo({ saved_at: r.saved_at, saved_by: r.saved_by });
    setDirty(false);
    setTimeout(() => rf.fitView({ padding: 0.15 }), 50);
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load().catch((e) => toast(e.message, true));
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setEdges((es) => es.map((e) => styleEdge(e, theme))), [theme, setEdges]);

  const selected = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);

  const onConnect = useCallback((c: Connection) => {
    if (!editable) return;
    const label = window.prompt("Connection label (e.g. HTTPS :443, TCP :5432) — optional", "") ?? "";
    setEdges((es) => addEdge(styleEdge({ ...c, id: `m:${Date.now()}`, label: label || undefined, data: { kind: "manual" } } as Edge, theme), es));
    setDirty(true);
  }, [editable, theme, setEdges]);

  const save = async () => {
    try {
      await api.put(`/clients/${clientId}/architecture`, { layout: toSaved(nodes, edges, theme) });
      toast("Architecture saved");
      setDirty(false);
      load();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const addCustom = (kind: "custom" | "note") => {
    const c = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const label = window.prompt(kind === "note" ? "Note title" : "Box label (e.g. Cloudflare, Load balancer, External API)", kind === "note" ? "Note" : "");
    if (label === null) return;
    const text = window.prompt("Description (optional)", "") ?? "";
    setNodes((ns) => [...ns, { id: `c:${Date.now()}`, type: "custom", position: c, style: { width: 190, height: kind === "note" ? 90 : 70 }, data: { kind, label: label || "Box", text, color: "#6366f1" } }]);
    setDirty(true);
  };

  const recolor = (color: string) => {
    const sel = new Set(selected.map((n) => n.id));
    setNodes((ns) => ns.map((n) => (sel.has(n.id) ? { ...n, data: { ...n.data, color } } : n)));
    setDirty(true);
  };
  const rename = () => {
    const n = selected[0];
    if (!n) return;
    const label = window.prompt("New label", n.data.label);
    if (!label) return;
    setNodes((ns) => ns.map((x) => (x.id === n.id ? { ...x, data: { ...x.data, label, _renamed: true } } : x)));
    setDirty(true);
  };
  const removeSelected = () => {
    const delNodes = new Set(selected.filter((n) => n.data.kind === "custom" || n.data.kind === "note").map((n) => n.id));
    const delEdges = new Set(selectedEdges.filter((e) => (e.data as { kind?: string })?.kind === "manual").map((e) => e.id));
    if (!delNodes.size && !delEdges.size) return toast("Only boxes, notes and manual connections can be removed here. Servers and services come from the inventory.", true);
    setNodes((ns) => ns.filter((n) => !delNodes.has(n.id)));
    setEdges((es) => es.filter((e) => !delEdges.has(e.id) && !delNodes.has(e.source) && !delNodes.has(e.target)));
    setDirty(true);
  };

  const autoLayout = async () => {
    if (!(await confirm("Re-generate the layout?", <p>Positions, sizes and colours go back to the automatic layout. Manual boxes, notes and connections are removed until you reload without saving.</p>, false))) return;
    await load(true);
    setDirty(true);
  };

  const exportImage = async (asPdf: boolean) => {
    const el = document.querySelector<HTMLElement>(".arch-flow .react-flow__viewport");
    if (!el) return;
    const bounds = getNodesBounds(nodes);
    const w = Math.min(4000, Math.max(1200, bounds.width + 200)), h = Math.min(4000, Math.max(800, bounds.height + 200));
    const vp = getViewportForBounds(bounds, w, h, 0.2, 2, 0.08);
    try {
      const url = await toPng(el, { backgroundColor: p.bg, width: w, height: h, pixelRatio: 2,
        style: { width: `${w}px`, height: `${h}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` } });
      if (!asPdf) {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${clientName}-architecture.png`;
        a.click();
        return;
      }
      const win = window.open("", "_blank");
      if (!win) return toast("Allow pop-ups to export PDF", true);
      win.document.write(`<title>${clientName} architecture</title><style>@page{size:landscape;margin:10mm}body{margin:0;font-family:sans-serif}img{width:100%}</style><h3>${clientName} — infrastructure architecture</h3><img src="${url}" onload="setTimeout(()=>window.print(),300)">`);
      win.document.close();
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, true);
    }
  };

  const legend = useMemo(() => Object.entries(SERVICE_STYLE), []);

  return (
    <ThemeCtx.Provider value={theme}>
      <div className="card">
        <div className="filters" style={{ alignItems: "center" }}>
          <div className="segmented">
            <button className={theme === "technical" ? "on" : ""} onClick={() => { setTheme("technical"); setDirty(true); }}>⚡ Technical</button>
            <button className={theme === "professional" ? "on" : ""} onClick={() => { setTheme("professional"); setDirty(true); }}>📄 Professional</button>
          </div>
          {editable && <>
            <button className="btn sm" onClick={() => addCustom("custom")}>＋ Box</button>
            <button className="btn sm" onClick={() => addCustom("note")}>🗒 Note</button>
            <button className="btn sm" disabled={!selected.length} onClick={rename}>✎ Rename</button>
            <label className="btn sm" style={{ cursor: selected.length ? "pointer" : "not-allowed", opacity: selected.length ? 1 : 0.5 }} title="Colour of selected nodes">
              🎨 Colour <input type="color" disabled={!selected.length} style={{ width: 22, height: 18, padding: 0, border: 0 }} onChange={(e) => recolor(e.target.value)} />
            </label>
            <button className="btn sm danger" disabled={!selected.length && !selectedEdges.length} onClick={removeSelected}>🗑 Remove</button>
            <button className="btn sm" onClick={autoLayout}>↻ Auto layout</button>
          </>}
          <span className="spacer" />
          <span className="small muted">{info.saved_at ? `Saved ${fmtDate(info.saved_at, true)} by ${info.saved_by}` : "Not saved yet — automatic layout"}</span>
          <button className="btn sm" onClick={() => exportImage(false)}>⇩ PNG</button>
          <button className="btn sm" onClick={() => exportImage(true)}>⇩ PDF</button>
          {editable && <button className="btn sm primary" onClick={save}>{dirty ? "● " : ""}Save layout</button>}
        </div>
        <div className="arch-flow" style={{ height: "calc(100vh - 280px)", minHeight: 520, background: p.bg, borderRadius: "0 0 10px 10px" }}>
          <ReactFlow<FlowNode, Edge>
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={(c) => { onNodesChange(c); if (c.some((x) => x.type === "position" || x.type === "dimensions")) setDirty(true); }}
            onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeDoubleClick={(_, n) => setDetail(n)}
            onEdgeDoubleClick={(_, e) => {
              if (!editable || (e.data as { kind?: string })?.kind !== "manual") return;
              const label = window.prompt("Connection label", String(e.label || ""));
              if (label !== null) { setEdges((es) => es.map((x) => (x.id === e.id ? { ...x, label } : x))); setDirty(true); }
            }}
            nodesDraggable={editable} nodesConnectable={editable} elementsSelectable
            fitView minZoom={0.1} maxZoom={2} proOptions={{ hideAttribution: true }}
            colorMode={theme === "technical" ? "dark" : "light"}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color={p.grid} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => (n.data as NodeData).color || SERVICE_STYLE[(n.data as NodeData).service_type || ""]?.color || ROLE_COLOR[(n.data as NodeData).role || ""] || "#64748b"}
              style={{ background: p.panel }} maskColor={theme === "technical" ? "rgba(2,6,23,0.6)" : "rgba(241,245,249,0.6)"} />
          </ReactFlow>
        </div>
        <div className="filters" style={{ borderTop: "1px solid var(--border)", borderBottom: 0, gap: 14 }}>
          {legend.map(([k, s]) => <span key={k} className="small"><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: s.color, marginRight: 4 }} />{s.icon} {s.label}</span>)}
          <span className="spacer" />
          <span className="small muted">Double-click a node for details & credentials · drag between handles to connect · dashed = inferred</span>
        </div>
      </div>
      {detail && <NodeDetail node={detail} onClose={() => setDetail(null)} />}
    </ThemeCtx.Provider>
  );
}

export function ArchitectureEditor(props: { clientId: number; clientName: string }) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}
