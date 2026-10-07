import { beginTrace, withTraceFields } from "../../core/trace.js";
import type { OfficialAgent, AgentRequest } from "./contracts.js";
/** Parent planning and supplemental cross-review join the same task trace. */
export async function runDagAgent(
  agent: OfficialAgent,
  request: AgentRequest,
  signal: AbortSignal,
  simulated: boolean,
) {
  const span = beginTrace(
    "llm",
    agent.provider,
    {
      internal: {
        model: request.model.model,
        reasoning: request.effort ? { effort: request.effort } : undefined,
      },
      officialPhase: request.phase,
      requestId: request.requestId,
    },
    simulated,
  );
  try {
    const result = await withTraceFields(span.fields, () =>
      agent.run(request, signal),
    );
    span.end(
      {
        dispatched: result.dispatched,
        tokenMeasurement: result.usage?.measurement,
        usageComplete: result.usage?.complete ?? false,
        response: [
          {
            usageScope: result.usage?.scope,
            observedModels: result.observedModels,
            nativeSessionId: result.nativeSessionId,
            nativeTurnId: result.nativeTurnId,
          },
        ],
      },
      result.status,
    );
    return result;
  } catch (error) {
    span.end({ unconfirmed: true }, signal.aborted ? "cancelled" : "failed");
    throw error;
  }
}
