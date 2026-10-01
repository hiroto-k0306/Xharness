import { resolveModel } from "../config/config.js";
import { type ProviderId } from "./types.js";
import { type Provider, type ReasoningEffort } from "../providers/provider.js";

export interface Route {
  provider: Provider;
  model: string;
  reasoning?: { effort: ReasoningEffort };
}
export class Router {
  constructor(
    private readonly providers: readonly Provider[],
    private readonly fallbacks: Partial<Record<ProviderId, string>> = {},
    private readonly aliases?: Record<string, string>,
  ) {}
  provider(model: string): Provider {
    const provider = this.providers.find((p) =>
      p.models().some((m) => m.id === model),
    );
    if (!provider) throw new Error("Unavailable routed model");
    return provider;
  }
  fallback(
    from: ProviderId,
    effort: ReasoningEffort | undefined,
    visited: ReadonlySet<string>,
  ): Route | undefined {
    const spec = this.fallbacks[from];
    const resolved = spec && resolveModel(spec, this.aliases);
    if (!resolved || visited.has(resolved.model)) return undefined;
    const provider = this.providers.find(
      (p) =>
        p.id === resolved.provider &&
        p.models().some((m) => m.id === resolved.model),
    );
    return provider
      ? {
          provider,
          model: resolved.model,
          ...(effort ? { reasoning: { effort } } : {}),
        }
      : undefined;
  }
}
