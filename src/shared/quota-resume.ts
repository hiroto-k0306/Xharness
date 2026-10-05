export type QuotaPauseState =
  | "paused"
  | "waiting"
  | "running"
  | "manual"
  | "cancelled"
  | "expired"
  | "completed";
export interface QuotaPauseView {
  id: string;
  state: QuotaPauseState;
  reason: string;
  provider: string;
  model: string;
  scope: string;
  nextCheckAt?: number;
  expiresAt: number;
  eligible: boolean;
  attempts: number;
  taskId?: string;
  phase?: string;
}
