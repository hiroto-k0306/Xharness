import { z } from "zod";
import type { TokenMeasurement } from "../../providers/token-usage.js";

export const provider = z.enum(["claude", "codex"]);
export type OfficialProvider = z.infer<typeof provider>;
export const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const text = z.string().trim().min(1).max(4000);
export const relativeFile = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (s) =>
      !/[:\x00-\x1f*?\[\]{}]|^[\\/]/.test(s) &&
      !s
        .replaceAll("\\", "/")
        .split("/")
        .some((p) => !p || p === "." || p === "..") &&
      !/(^|[\\/])(\.git|\.env[^\\/]*|\.npmrc|\.netrc|\.git-credentials|auth\.json|.*\.credentials\.json|id_rsa|id_ed25519|id_ecdsa|id_dsa|.*\.(pem|key))($|[\\/])/i.test(
        s,
      ),
  );
const assignment = z
  .object({
    provider,
    model: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
    effort: effort.nullable(),
    reason: text,
  })
  .strict();
export const planContract = z
  .object({
    summary: text,
    tasks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
            title: text,
            instructions: text,
            files: z.array(relativeFile).min(1).max(30),
            dependsOn: z.array(z.string()).max(16),
            acceptance: z.array(z.string()).min(1).max(20),
            assignee: assignment,
            // Required for new plans (planOutputSchema); absent only in records
            // created before planner-chosen reviewers.
            reviewer: assignment.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type OfficialPlan = z.infer<typeof planContract>;
export const reviewContract = z
  .object({
    base: z.string().regex(/^[a-f0-9]{40,64}$/),
    head: z.string().regex(/^[a-f0-9]{40,64}$/),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(["must", "should", "nit"]),
            file: relativeFile,
            line: z.number().int().positive(),
            message: text,
            evidence: text,
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type OfficialReview = z.infer<typeof reviewContract>;
export const implementationContract = z.object({ summary: text }).strict();
export const inputIntentContract = z
  .object({
    summary: text.describe(
      "For question: the direct answer shown verbatim to the user, not a description of the question. Follow the user's requested language and answer format. For work: ask for target files and an existing Node test; do not claim execution.",
    ),
    intent: z.enum(["question", "work"]),
  })
  .strict();
export const schemas = {
  inputIntent: z.toJSONSchema(inputIntentContract, { target: "draft-7" }),
  plan: z.toJSONSchema(planContract, { target: "draft-7" }),
  review: z.toJSONSchema(reviewContract, { target: "draft-7" }),
  implement: z.toJSONSchema(implementationContract, { target: "draft-7" }),
};
export interface ModelCandidate {
  provider: OfficialProvider;
  model: string;
  resolvedModel?: string;
  efforts: (z.infer<typeof effort> | null)[];
  available: boolean;
  quotaAllowed: boolean | null;
  capabilitySource: "official-sdk" | "official-app-server" | "fixture";
  quota?: QuotaSnapshot;
}
export interface QuotaSnapshot {
  source: "sdk-control" | "sdk-event" | "app-server";
  allowed: boolean | null;
  reason?: string;
  rechecks?: number;
  windows: {
    kind: string;
    usedPercent: number | null;
    resetAt: string | null;
  }[];
  event?: { utilization?: number; resetsAt?: number };
}
export interface TestSpec {
  id: string;
  program: string;
  args: string[];
  /** Exact native-agent Bash command preapproved with the plan. */
  command: string;
  timeoutMs: number;
}
/** The planner returns registered test IDs, never commands or prose criteria. */
export function planOutputSchema(tests: TestSpec[]) {
  return z.toJSONSchema(
    planContract.extend({
      tasks: z
        .array(
          planContract.shape.tasks.element.extend({
            reviewer: assignment.describe(
              "Reviewer model from availableModels whose provider differs from the assignee's provider",
            ),
            acceptance: z
              .array(z.enum(tests.map((test) => test.id)))
              .min(1)
              .max(20)
              .describe("Exact IDs from acceptanceTests; not shell commands"),
          }),
        )
        .min(1)
        .max(16),
    }),
    { target: "draft-7" },
  );
}
export interface ToolEvidence {
  actionId: string;
  name: string;
  inputDigest: string;
  status: "requested" | "allowed" | "denied" | "completed" | "failed";
  outputDigest?: string;
  source: "plan" | "explicit" | "native-sandbox";
}
export interface RuntimeUsage {
  scope:
    "query-pipeline" | "partial-main-loop" | "main-loop" | "thread-cumulative";
  measurement: TokenMeasurement;
  byModel: { model: string; raw: Record<string, number> }[];
  native?: Record<string, number>;
  complete: boolean;
}
export interface AgentRequest {
  /** Only explicitly approved synthetic diagnostics may retain response text. */
  diagnosticText?: boolean;
  requestId: string;
  taskId: string;
  phase: "plan" | "implement" | "fix" | "review" | "conversation";
  cwd: string;
  model: ModelCandidate;
  prompt: string;
  effort: z.infer<typeof effort> | null;
  files: string[];
  tests: TestSpec[];
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
  tool(evidence: ToolEvidence): Promise<void>;
  /** true grants; any other value is the reason the person's grant is missing. */
  approve(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<boolean | "declined" | "expired" | "cancelled">;
}
export interface AgentResult {
  diagnostics?: import("./diagnostics.js").AgentDiagnostics;
  status: "completed" | "failed" | "cancelled" | "timeout" | "quota-paused";
  dispatched: boolean;
  output?: unknown;
  nativeSessionId?: string;
  nativeTurnId?: string;
  observedModels: string[];
  usage: RuntimeUsage | null;
  elapsedMs: number;
  error?: string;
  quota?: QuotaSnapshot;
}
export interface OfficialAgent {
  readonly provider: OfficialProvider;
  discover(cwd: string, signal: AbortSignal): Promise<ModelCandidate[]>;
  run(request: AgentRequest, signal: AbortSignal): Promise<AgentResult>;
}
export interface TestEvidence {
  id: string;
  exitCode: number | null;
  passed: boolean;
  elapsedMs: number;
  output: string;
  source: "process";
}
export interface Snapshot {
  base: string;
  head: string;
  diff: string;
  files: string[];
}
export interface WorkspacePort {
  inspect(signal: AbortSignal): Promise<{ head: string; clean: boolean }>;
  /** `as` is only for the verification-only fault-injection commit. */
  commit(
    files: string[],
    signal: AbortSignal,
    as?: { name: string; email: string; message: string },
  ): Promise<string>;
  /** Real repository root, Git directory and file digests at `rev` (fault injection only). */
  identity?(
    rev: string,
    files: string[],
    signal: AbortSignal,
  ): Promise<{ root: string; gitDir: string; digests: Record<string, string> }>;
  snapshot(base: string, head: string, signal: AbortSignal): Promise<Snapshot>;
  test(spec: TestSpec, signal: AbortSignal): Promise<TestEvidence>;
}
export class WorkflowFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const normalizeFile = (s: string) =>
  s.replaceAll("\\", "/").toLowerCase();
export function validateOfficialPlan(
  value: unknown,
  models: ModelCandidate[],
  files: string[],
  tests: TestSpec[],
  serializeConflicts = false,
  requireReviewer = false,
) {
  const plan = planContract.parse(value);
  const ids = new Set(plan.tasks.map((t) => t.id));
  if (ids.size !== plan.tasks.length)
    throw new WorkflowFailure("duplicate-task");
  for (const task of plan.tasks) {
    if (
      task.files.some(
        (f) =>
          !files.some((allowed) => normalizeFile(allowed) === normalizeFile(f)),
      )
    )
      throw new WorkflowFailure("scope-expansion");
    if (task.acceptance.some((id) => !tests.some((t) => t.id === id)))
      throw new WorkflowFailure("unapproved-test");
    if (
      !models.some(
        (m) =>
          m.provider === task.assignee.provider &&
          m.model === task.assignee.model &&
          m.available &&
          m.quotaAllowed === true &&
          m.efforts.includes(task.assignee.effort),
      )
    )
      throw new WorkflowFailure("unavailable-model");
    if (!task.reviewer) {
      if (requireReviewer) throw new WorkflowFailure("reviewer-missing");
    } else {
      // Review always comes from a different company than the implementation.
      if (task.reviewer.provider === task.assignee.provider)
        throw new WorkflowFailure("reviewer-same-provider");
      const reviewer = task.reviewer;
      if (
        !models.some(
          (m) =>
            m.provider === reviewer.provider &&
            m.model === reviewer.model &&
            m.available &&
            m.quotaAllowed === true &&
            m.efforts.includes(reviewer.effort),
        )
      )
        throw new WorkflowFailure("unavailable-model");
    }
    if (task.dependsOn.some((id) => !ids.has(id)))
      throw new WorkflowFailure("unknown-dependency");
  }
  const ancestors = new Map<string, Set<string>>(),
    visiting = new Set<string>();
  const visit = (id: string): Set<string> => {
    if (visiting.has(id)) throw new WorkflowFailure("dependency-cycle");
    if (ancestors.has(id)) return ancestors.get(id)!;
    visiting.add(id);
    const all = new Set<string>();
    for (const dep of plan.tasks.find((t) => t.id === id)!.dependsOn) {
      all.add(dep);
      for (const a of visit(dep)) all.add(a);
    }
    visiting.delete(id);
    ancestors.set(id, all);
    return all;
  };
  for (const task of plan.tasks) visit(task.id);
  for (const a of plan.tasks)
    for (const b of plan.tasks) {
      if (
        a.id >= b.id ||
        ancestors.get(a.id)!.has(b.id) ||
        ancestors.get(b.id)!.has(a.id)
      )
        continue;
      if (
        a.files.some((f) =>
          b.files.some((g) => normalizeFile(f) === normalizeFile(g)),
        )
      )
        if (!serializeConflicts) throw new WorkflowFailure("file-conflict");
    }
  if (serializeConflicts) {
    // Existing dependency order first; adding edges only forward in this order
    // cannot introduce a cycle, even if the planner lists dependants first.
    const order: typeof plan.tasks = [];
    const visited = new Set<string>();
    const append = (task: (typeof plan.tasks)[number]) => {
      if (visited.has(task.id)) return;
      visited.add(task.id);
      task.dependsOn.forEach((id) =>
        append(plan.tasks.find((t) => t.id === id)!),
      );
      order.push(task);
    };
    plan.tasks.forEach(append);
    for (let i = 0; i < order.length; i++)
      for (let j = i + 1; j < order.length; j++) {
        const before = order[i]!,
          after = order[j]!;
        if (
          before.files.some((f) =>
            after.files.some((g) => normalizeFile(f) === normalizeFile(g)),
          ) &&
          !after.dependsOn.includes(before.id)
        )
          after.dependsOn.push(before.id);
      }
  }
  return plan;
}
