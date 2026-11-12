/**
 * A record's own value for a key that comes from outside the code: a header or parameter named in
 * a mock rule, a template, or a request. Plain objects inherit Object's members, so without this a
 * name such as "constructor" or "toString" finds a built-in function instead of nothing.
 */
export function ownValue<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}
/** Sets a record's own value; defined rather than assigned, so "__proto__" is kept like any key. */
export function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
