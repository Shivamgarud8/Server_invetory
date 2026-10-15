export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

type Params = Record<string, string | number | boolean | null | undefined>;

export function qs(params?: Params): string {
  if (!params) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "" && v !== false) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function request<T>(method: string, path: string, body?: unknown, params?: Params): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "TagIDPortal" };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}${qs(params)}`, {
    method,
    headers,
    body: payload,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/me")) {
    onUnauthorized?.();
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") msg = j.detail;
      else if (Array.isArray(j.detail))
        msg = j.detail.map((d: { loc?: string[]; msg: string }) => `${(d.loc || []).slice(1).join(".")}: ${d.msg}`).join("; ");
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, params?: Params) => request<T>("GET", path, undefined, params),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: (path: string) => request<void>("DELETE", path),
  upload: <T>(path: string, form: FormData) => request<T>("POST", path, form),
};

/** Trigger a browser download of an authenticated GET endpoint. */
export async function download(path: string, params?: Params) {
  const res = await fetch(`/api${path}${qs(params)}`, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status, "Download failed");
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") || "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] || "export";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
