export type HookResult =
  | { kind: "continue" }
  | { kind: "inject"; message: string }
  | { kind: "block"; reason: string }
  | { kind: "stop"; reason: string };

export type Immutable<T> = T extends object
  ? { readonly [K in keyof T]: Immutable<T[K]> }
  : T;
export function hookSnapshot<T>(value: T): Immutable<T> {
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  const copy: T = structuredClone(value);
  freeze(copy);
  return copy as Immutable<T>;
}
