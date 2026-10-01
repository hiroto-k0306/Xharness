import { type Provider, type ProviderEvent } from "../providers/provider.js";
import { webFetchTool, type WebFetchOptions } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";

/** Fake mode must not resolve DNS or fetch public pages. URL validation remains active. */
export function webTools(
  provider: () => Provider,
  mode: "live" | "cached",
  fake: boolean,
  onEvent?: (event: ProviderEvent) => void,
) {
  const options: WebFetchOptions = fake
    ? {
        lookup: async () => [{ address: "93.184.215.14", family: 4 }],
        fetcher: async () =>
          new Response("Fake public page (no network request).", {
            headers: { "content-type": "text/plain" },
          }),
      }
    : {};
  const tools = [webSearchTool(provider, mode, onEvent), webFetchTool(options)];
  return tools.map((tool) => [tool.spec.name, tool] as const);
}
