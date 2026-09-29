// The network name an agent registers under, derived from its display name
// (SPEC §16.2): NFKD without combining marks, lowercase, runs of anything
// outside a-z 0-9 _ - become one "-", "-" and "_" trimmed from both ends, cut
// to 32 characters. Null when fewer than 2 characters are left, so the app can
// ask for a Latin name.

export const NAME_PATTERN = /^[a-z0-9_-]{2,32}$/;

export function networkName(displayName: string): string | null {
  const name = displayName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
  return NAME_PATTERN.test(name) ? name : null;
}
