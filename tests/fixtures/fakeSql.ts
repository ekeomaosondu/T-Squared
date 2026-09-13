/**
 * Minimal `sql` stand-in for tests that exercise logic around the database
 * rather than the database itself.
 *
 * Returns one placeholder row for any query and supports the tagged-template,
 * method and `sql.json()` call shapes the repositories use.
 */
export function fakeSql(rows: Record<string, unknown>[] = [{ id: '1' }]): never {
  const handler: ProxyHandler<() => Promise<unknown>> = {
    apply: () => Promise.resolve(rows),
    get: (_target, prop) => {
      if (prop === 'json') return (v: unknown) => v;
      if (prop === 'begin') return async (fn: (tx: unknown) => unknown) => fn(fakeSql(rows));
      if (prop === 'unsafe') return () => Promise.resolve(rows);
      if (prop === 'then') return undefined; // not a thenable
      return () => Promise.resolve(rows);
    },
  };
  return new Proxy((() => Promise.resolve(rows)) as () => Promise<unknown>, handler) as never;
}
