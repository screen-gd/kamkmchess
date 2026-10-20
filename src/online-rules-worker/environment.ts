/**
 * The worker needs no configuration. The Go client already starts it with a
 * narrow environment; this second pass removes anything a direct local start
 * inherited so provider keys and database credentials cannot leak into rules
 * evaluation.
 */
export const WORKER_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
]);

const allowlist = new Set(WORKER_ENV_ALLOWLIST);

export function forbiddenWorkerEnvironmentKeys(environment: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(environment).filter((key) => !allowlist.has(key.toUpperCase()));
}

export function sanitizeWorkerEnvironment(environment: Record<string, string | undefined>): void {
  for (const key of forbiddenWorkerEnvironmentKeys(environment)) delete environment[key];
}
