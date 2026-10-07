import {
  BoundaryError,
  validateProposal,
  type Input,
  type ModelInference,
  type Outcome,
} from "./contracts.js";
import { RunBoundary } from "./boundary.js";
import { measure } from "./measurement.js";

/** Auth and HTTP remain separate, injected main-process bindings. No credential-reader imports. */
export interface SiwcBinding {
  registrationConfirmed: boolean;
  /** A grant issued to this registered client, not a CLI access-token transplant. */
  grantSource: "registered-client";
  send(
    request: {
      endpoint: "https://api.openai.com/v1/responses";
      body: Record<string, unknown>;
    },
    signal: AbortSignal,
  ): AsyncIterable<unknown>;
}
export function siwcReadiness(binding?: SiwcBinding) {
  return binding?.registrationConfirmed &&
    binding.grantSource === "registered-client"
    ? { available: true, reason: null }
    : {
        available: false,
        reason:
          "Registered client authorization and transport are not configured",
      };
}
export class SiwcInference implements ModelInference {
  readonly kind = "inference";
  readonly boundary = new RunBoundary();
  constructor(private binding?: SiwcBinding) {}
  infer(input: Input, signal: AbortSignal): Promise<Outcome> {
    input = structuredClone(input);
    return this.boundary.run("openai-siwc", input, signal, async (inner) => {
      if (!siwcReadiness(this.binding).available || !this.binding)
        throw new BoundaryError("unconfigured");
      // Tools are JSON action proposals, never hosted execution. X validates them independently.
      let answer = "";
      for await (const raw of this.binding.send(
        {
          endpoint: "https://api.openai.com/v1/responses",
          body: {
            model: input.model,
            instructions:
              input.instructions +
              (input.tools.length
                ? `\nReturn only JSON with answer:string and actions:[{id,tool,input}]. Available X tools: ${JSON.stringify(input.tools)}.`
                : ""),
            input: input.history,
            store: false,
            stream: true,
            ...(input.effort ? { reasoning: { effort: input.effort } } : {}),
          },
        },
        inner,
      )) {
        if (inner.aborted) throw new BoundaryError("cancelled");
        if (!raw || typeof raw !== "object")
          throw new BoundaryError("malformed");
        const event = raw as Record<string, unknown>;
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string")
            throw new BoundaryError("malformed");
          answer += event.delta;
        } else if (event.type === "response.completed") {
          const response = event.response as
            Record<string, unknown> | undefined;
          if (!response || response.status !== "completed")
            throw new BoundaryError("malformed");
          try {
            let value: unknown = { answer, actions: [] };
            if (input.tools.length) {
              try {
                value = JSON.parse(answer);
              } catch {
                throw new BoundaryError("malformed");
              }
            }
            return {
              status: "completed",
              proposal: validateProposal(value, input.tools),
              measurement: measure("responses", response.usage),
            };
          } catch (e) {
            return {
              status: "failed",
              error: e instanceof BoundaryError ? e.code : "malformed",
              measurement: measure("responses", response.usage),
            };
          }
        } else if (event.type === "response.failed" || event.type === "error") {
          const response = event.response as
            Record<string, unknown> | undefined;
          const error = (response?.error ?? event.error) as
            Record<string, unknown> | undefined;
          if (
            [
              "subscription_sharing_usage_limit_exceeded",
              "subscription_sharing_usage_unavailable",
            ].includes(String(error?.code))
          ) {
            return {
              status: "quota-paused",
              error: "quota",
              measurement: measure("responses", response?.usage),
              quota: {
                source: "official-response",
                observedAt: new Date().toISOString(),
                usedPercent: null,
                resetAt: null,
                limited: true,
              },
            };
          }
          return {
            status: "failed",
            error: "transport",
            measurement: measure("responses", response?.usage),
          };
        } else if (event.type === "response.incomplete") {
          const response = event.response as
            Record<string, unknown> | undefined;
          return {
            status: "failed",
            error: "malformed",
            measurement: measure("responses", response?.usage),
          };
        }
      }
      throw new BoundaryError("transport"); // EOF or partial text is not completion.
    });
  }
}
