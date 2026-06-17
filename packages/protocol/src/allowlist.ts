function matchHost(host: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

function normalizeBackend(backend: string): URL | null {
  let url: URL;
  try {
    url = new URL(backend);
  } catch {
    return null;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
  return url;
}

export function isBackendAllowed(backend: string, allowedHosts: string[]): boolean {
  const url = normalizeBackend(backend);
  if (!url) return false;
  return allowedHosts.some((pattern) => matchHost(url.hostname, pattern));
}

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((pattern) => pattern === "*" || pattern === origin);
}

export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
