import {
  experimental_threadStopIfCurrentTurnParamsSchema,
  type ExperimentalThreadStopIfCurrentTurnResult,
} from "@bb/provider-bridge-protocol";
import type { ProviderRequestCommandPlan } from "@bb/provider-bridge-protocol/bridge-kit";
import type { BridgeProtocolAdapter } from "./bridge-protocol-adapter.js";
import type { StopThreadResult } from "./types.js";

interface ConditionalStopState {
  activeTurnId: string | null;
  replaced: boolean;
  owned: boolean;
}

export async function stopCurrentProviderTurn(args: {
  threadId: string;
  providerThreadId: string;
  expectedTurnId: string;
  adapter: BridgeProtocolAdapter;
  readState(): ConditionalStopState;
  send(
    message: ProviderRequestCommandPlan,
  ): Promise<ExperimentalThreadStopIfCurrentTurnResult>;
}): Promise<StopThreadResult> {
  const refuse = (
    reason: Extract<
      ExperimentalThreadStopIfCurrentTurnResult["condition"],
      { status: "refused" }
    >["reason"],
    activeTurnId = args.readState().activeTurnId,
  ): StopThreadResult => ({
    providerCheckpointId: null,
    condition: {
      status: "refused",
      expectedTurnId: args.expectedTurnId,
      reason,
      activeTurnId,
    },
  });
  const command = args.adapter.buildCommandPlan({
    type: "thread/stop-if-current-turn",
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    expectedTurnId: args.expectedTurnId,
  });
  if (command.kind === "noop") {
    return refuse("unproven");
  }
  const params = experimental_threadStopIfCurrentTurnParamsSchema.parse(
    command.params,
  );
  const result = await args.send(command);
  const state = args.readState();
  if (!state.owned) {
    return refuse("runtime-missing", state.activeTurnId);
  }
  if (
    state.replaced ||
    (state.activeTurnId !== null && state.activeTurnId !== args.expectedTurnId)
  ) {
    return refuse("turn-mismatch", state.activeTurnId);
  }
  if (result.condition.expectedTurnId !== params.expectedTurnId) {
    return refuse("unproven", state.activeTurnId);
  }
  if (result.condition.status === "refused") {
    return refuse(result.condition.reason, state.activeTurnId);
  }
  if (state.activeTurnId !== null) {
    return refuse("unproven", state.activeTurnId);
  }
  return {
    providerCheckpointId: null,
    condition: { status: "stopped", expectedTurnId: args.expectedTurnId },
  };
}
