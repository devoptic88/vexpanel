export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
  ) {
    super(message);
  }
}

function csrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)vex_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-csrf-token': csrf(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('vex:signed-out'));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.detail);
  }
  return data as T;
}

export const get = <T,>(url: string) => api<T>('GET', url);
export const post = <T,>(url: string, body: unknown = {}) => api<T>('POST', url, body);
export const put = <T,>(url: string, body: unknown = {}) => api<T>('PUT', url, body);
export const del = <T,>(url: string, body?: unknown) => api<T>('DELETE', url, body);

export async function upload(dir: string, files: FileList | File[]): Promise<void> {
  const fd = new FormData();
  for (const f of Array.from(files)) fd.append('file', f, f.name);
  const res = await fetch(`/api/files/upload?path=${encodeURIComponent(dir)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': csrf() },
    body: fd,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? 'Upload failed');
  }
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export interface Pkg {
  id: number;
  name: string;
  disk_mb: number;
  max_addon_domains: number;
  max_subdomains: number;
  max_databases: number;
  max_email_accounts: number;
  max_cron_jobs: number;
  accounts?: number;
}

export interface Me {
  user: { id: number; username: string; role: 'admin' | 'user'; email: string; status: string; package: Pkg | null } | null;
  impersonatedBy?: string | null;
}
