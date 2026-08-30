import type { WorkflowCheckRequest } from "./check-contract.js";

export type { WorkflowCheckRequest } from "./check-contract.js";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = boolean | JsonObject;

export interface ExplicitModelSelection {
  provider: string;
  model: string;
  reasoningLevel: string;
}

export interface WorkflowContextRequirement {
  /** Smallest model context window that is considered a fit for this task. */
  minimumTokens: number;
}

export interface WorkflowContextProfile {
  /** Skills the worker must load before performing the relevant phase work. */
  requiredSkills: string[];
  /** Advisory memory searches to perform only when relevant and available. */
  memoryQueries: string[];
  /** Caller-supplied artifact references that ground this phase. */
  artifactRefs: string[];
  /** Explicit boundary for completing this phase call. */
  stopCondition: string | null;
}

export interface WorkflowAgentOptions {
  selection: ExplicitModelSelection | null;
  outputSchema: JsonSchema | null;
  contextRequirement: WorkflowContextRequirement | null;
  contextProfile: WorkflowContextProfile | null;
  title: string | null;
  phase: string | null;
}

interface WorkflowPhase {
  title: string;
  detail: string | null;
}

interface WorkflowMetadata {
  name: string;
  description: string;
  inputSchema: JsonSchema | null;
  outputSchema: JsonSchema | null;
  phases: WorkflowPhase[];
}

export interface ParsedWorkflow {
  metadata: WorkflowMetadata;
  body: string;
}

export interface WorkflowRuntimeLimits {
  memoryLimitBytes: number;
  maxStackBytes: number;
  synchronousDeadlineMs: number;
  maxAgentCalls: number;
  maxConcurrentAgents: number;
}

type WorkflowDepth = 0 | 1;

export type WorkflowReference =
  | string
  | { name: string }
  | { script: string }
  | { scriptPath: string };

export interface WorkflowBudgetSnapshot {
  [key: string]: JsonValue;
  agentCalls: number;
  activeAgents: number;
  queuedAgents: number;
  maxAgentCalls: number;
  maxConcurrentAgents: number;
  totalTokens: null;
}

export interface WorkflowExecutionScheduler {
  readonly limits: Readonly<WorkflowRuntimeLimits>;
  budget(): WorkflowBudgetSnapshot;
}

export interface NestedWorkflowContext {
  signal: AbortSignal;
  limits: Readonly<WorkflowRuntimeLimits>;
  scheduler: WorkflowExecutionScheduler;
  depth: 1;
}

export interface WorkflowCapabilities {
  agent(
    prompt: string,
    options: WorkflowAgentOptions,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  checkpoint?(value: JsonValue, phase: string | null): void;
  workflow?(
    nameOrRef: WorkflowReference,
    args: JsonValue,
    context: NestedWorkflowContext,
  ): Promise<JsonValue>;
  check?(
    request: WorkflowCheckRequest,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  log(message: string): void;
  phase(title: string): void;
}

export interface ExecuteWorkflowScriptArgs {
  args: JsonValue;
  body: string;
  capabilities: WorkflowCapabilities;
  limits?: Partial<WorkflowRuntimeLimits>;
  signal?: AbortSignal;
  depth?: WorkflowDepth;
  scheduler?: WorkflowExecutionScheduler;
}
