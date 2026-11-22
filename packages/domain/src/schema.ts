/** Small throwing decoders for the portable HTTP boundary. No producer or runtime dependencies. */

/** Checks a JSON value and reports a field path on failure. */
export type Decoder<T> = (value: unknown, path?: string) => T;

/** Infers a DTO from its runtime decoder. */
export type Decoded<T> = T extends Decoder<infer Value> ? Value : never;

/** Identifies fields that can be absent from a JSON object. */
type OptionalKeys<T> = { [K in keyof T]-?: undefined extends Decoded<T[K]> ? K : never }[keyof T];

/** Describes the known fields of a decoded object and preserves optionality. */
type Shape<T> = { [K in Exclude<keyof T, OptionalKeys<T>>]: Decoded<T[K]> }
  & { [K in OptionalKeys<T>]?: Exclude<Decoded<T[K]>, undefined> };

/** Rejects malformed contract data without echoing its contents. */
export function invalid(path: string, expected: string): never {
  throw new TypeError(`${path}: expected ${expected}`);
}

/** Parses known fields, ignoring additive fields from newer v1 peers. */
export function object<T extends Record<string, Decoder<unknown>>>(fields: T): Decoder<Shape<T>> {
  return (value, path = '$') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path, 'object');
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, decode] of Object.entries(fields)) {
      const parsed = decode(Object.hasOwn(input, key) ? input[key] : undefined, `${path}.${key}`);
      if (parsed !== undefined) output[key] = parsed;
    }
    return output as Shape<T>;
  };
}

/** Parses every item of a JSON array. */
export function array<T>(decode: Decoder<T>): Decoder<T[]> {
  return (value, path = '$') => Array.isArray(value)
    ? value.map((item, index) => decode(item, `${path}[${index}]`))
    : invalid(path, 'array');
}

/** Allows explicit JSON null. */
export function nullable<T>(decode: Decoder<T>): Decoder<T | null> {
  return (value, path) => value === null ? null : decode(value, path);
}

/** Allows a field to be omitted. */
export function optional<T>(decode: Decoder<T>): Decoder<T | undefined> {
  return (value, path) => value === undefined ? undefined : decode(value, path);
}

/** Recognizes the declared wire literals without coercion. */
export function oneOf<const T extends readonly (string | number | boolean | null)[]>(...values: T): Decoder<T[number]> {
  return (value, path = '$') => values.includes(value as T[number])
    ? value as T[number]
    : invalid(path, values.map(String).join(' | '));
}

/** Specifies bounded wire strings such as IDs, cursors and digests. */
export function matching(pattern: RegExp, expected: string): Decoder<string> {
  return (value, path = '$') => typeof value === 'string' && pattern.exec(value)?.[0] === value
    ? value
    : invalid(path, expected);
}

/** Parses tagged variants while retaining their discriminants. */
export function tagged<const T extends Record<string, Decoder<unknown>>>(key: string, variants: T): Decoder<Decoded<T[keyof T]>> {
  return (value, path = '$') => {
    const tag = value && typeof value === 'object' && Object.hasOwn(value, key)
      ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof tag !== 'string' || !Object.hasOwn(variants, tag)) return invalid(`${path}.${key}`, Object.keys(variants).join(' | '));
    return variants[tag](value, path) as Decoded<T[keyof T]>;
  };
}

/** Parses strings including empty source text. */
export const text: Decoder<string> = (value, path = '$') =>
  typeof value === 'string' ? value : invalid(path, 'string');

/** Parses JSON booleans. */
export const bool = oneOf(true, false);

/** Parses finite numbers such as quota percentages and rates. */
export const number: Decoder<number> = (value, path = '$') =>
  typeof value === 'number' && Number.isFinite(value) ? value : invalid(path, 'finite number');

/** Parses nonnegative safe integers such as clocks, counts and byte lengths. */
export const count: Decoder<number> = (value, path = '$') =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid(path, 'nonnegative safe integer');
