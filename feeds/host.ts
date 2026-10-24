export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const root = domain.toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
  return host === root || host.endsWith(`.${root}`);
}

export function sanitizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/[^a-z0-9.-]/g, "");
}
