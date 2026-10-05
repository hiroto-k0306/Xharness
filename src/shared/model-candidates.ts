import { type Effort } from "./ipc.js";
export interface CandidateQuota {
  state: "unknown" | "stale" | "observed" | "exhausted" | "simulated";
  scope: "provider-pool-unknown";
  observedAt?: number;
  reasons: string[];
}
export interface CandidateSample {
  sessionId: string;
  taskId: string;
  evidence: string;
  input: number | null;
  output: number | null;
  elapsedMs: number | null;
  measuredAt: number | null;
  coverage: string;
  cache: string;
  eligible: boolean;
  reason: string;
}
export interface ModelCandidate {
  id: string;
  provider: string;
  model: string;
  effort?: Effort;
  priority: boolean;
  selectable: boolean;
  reasons: string[];
  quota: CandidateQuota;
  samples: CandidateSample[];
}
export interface ModelCandidateView {
  snapshot: string;
  observedAt: number;
  expiresAt: number;
  conditions: string;
  allExhausted: boolean;
  candidates: ModelCandidate[];
  omitted: string[];
}
