export interface LlmLimits {
  llmCallsPerTurn: number;
  llmCallsPerSession: number;
}
export interface LlmCalls extends LlmLimits {
  turn: number;
  session: number;
  simulatedTurn: number;
  simulatedSession: number;
  since: number;
}
export const unlimitedCalls: LlmLimits = {
  llmCallsPerTurn: 0,
  llmCallsPerSession: 0,
};
export function validLlmCalls(value: unknown): value is LlmCalls {
  if (!value || typeof value !== "object") return false;
  const v = value as LlmCalls;
  return (
    [
      v.turn,
      v.session,
      v.simulatedTurn,
      v.simulatedSession,
      v.llmCallsPerTurn,
      v.llmCallsPerSession,
      v.since,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) &&
    v.turn <= v.session &&
    v.simulatedTurn <= v.turn &&
    v.simulatedSession <= v.session &&
    v.simulatedTurn <= v.simulatedSession
  );
}
