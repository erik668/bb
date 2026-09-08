import type { ExperimentalThreadStopIfCurrentTurnResult } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { codexHandledEventSchema } from "../schemas.js";
import type { CodexAppServerConnection } from "./app-server-connection.js";

interface NativeTurnGeneration {
  id: string;
  settled: boolean;
  waiters: Set<(settled: boolean) => void>;
}

type ConditionalStopOutcome =
  ExperimentalThreadStopIfCurrentTurnResult["condition"];
const interruptResultSchema = z.unknown();

export class CodexConditionalTurnState {
  private currentTurn: NativeTurnGeneration | null = null;
  private readonly openTurnIds = new Set<string>();

  observe(args: {
    method: string;
    params: unknown;
    providerThreadId: string | null;
  }): void {
    if (args.method !== "turn/started" && args.method !== "turn/completed") {
      return;
    }
    const event = codexHandledEventSchema.safeParse({
      jsonrpc: "2.0",
      method: args.method,
      params: args.params,
    });
    if (!event.success) {
      this.invalidate();
      return;
    }
    if (
      (event.data.method !== "turn/started" &&
        event.data.method !== "turn/completed") ||
      event.data.params.threadId !== args.providerThreadId
    ) {
      return;
    }
    const turn = event.data.params.turn;
    if (event.data.method === "turn/started") {
      this.resolveWaiters(false);
      this.currentTurn = { id: turn.id, settled: false, waiters: new Set() };
      this.openTurnIds.add(turn.id);
      return;
    }
    if (turn.status === "inProgress") {
      this.invalidate();
      return;
    }
    this.openTurnIds.delete(turn.id);
    if (this.currentTurn?.id === turn.id) {
      this.currentTurn.settled = true;
      this.resolveWaiters(true);
    }
  }

  private resolveWaiters(settled: boolean): void {
    if (this.currentTurn === null) {
      return;
    }
    for (const resolve of this.currentTurn.waiters) {
      resolve(settled);
    }
    this.currentTurn.waiters.clear();
  }

  private invalidate(): void {
    this.resolveWaiters(false);
    this.currentTurn = null;
    this.openTurnIds.clear();
  }

  private activeTurnId(): string | null {
    return this.currentTurn !== null && !this.currentTurn.settled
      ? this.currentTurn.id
      : null;
  }

  private waitForSettlement(
    turn: NativeTurnGeneration,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.currentTurn !== turn || turn.settled) {
      return Promise.resolve(this.currentTurn === turn && turn.settled);
    }
    return new Promise((resolve) => {
      const complete = (settled: boolean): void => {
        clearTimeout(timer);
        turn.waiters.delete(complete);
        resolve(settled);
      };
      const timer = setTimeout(() => complete(false), timeoutMs);
      timer.unref?.();
      turn.waiters.add(complete);
    });
  }

  async stop(args: {
    providerThreadId: string;
    expectedTurnId: string;
    connection: Pick<CodexAppServerConnection, "request">;
    isCurrent(): boolean;
    requestTimeoutMs: number;
    settlementTimeoutMs: number;
  }): Promise<ExperimentalThreadStopIfCurrentTurnResult> {
    const refuse = (
      reason: Extract<ConditionalStopOutcome, { status: "refused" }>["reason"],
    ): ExperimentalThreadStopIfCurrentTurnResult => ({
      condition: {
        status: "refused",
        expectedTurnId: args.expectedTurnId,
        reason,
        activeTurnId: this.activeTurnId(),
      },
    });
    const turn = this.currentTurn;
    if (!args.isCurrent()) {
      return refuse("runtime-missing");
    }
    if (turn === null || turn.settled) {
      return refuse("no-active-turn");
    }
    if (turn.id !== args.expectedTurnId) {
      return refuse("turn-mismatch");
    }
    const openTurnCount = this.openTurnIds.size;
    if (openTurnCount !== 1 || !this.openTurnIds.has(turn.id)) {
      return refuse("unproven");
    }
    try {
      await args.connection.request({
        method: "turn/interrupt",
        params: { threadId: args.providerThreadId, turnId: turn.id },
        resultSchema: interruptResultSchema,
        timeoutMs: args.requestTimeoutMs,
      });
    } catch {
      return refuse(args.isCurrent() ? "unproven" : "runtime-missing");
    }
    const settled = await this.waitForSettlement(
      turn,
      args.settlementTimeoutMs,
    );
    if (!args.isCurrent()) {
      return refuse("runtime-missing");
    }
    if (this.currentTurn !== turn) {
      return refuse("turn-mismatch");
    }
    if (!settled || !turn.settled || this.openTurnIds.size !== 0) {
      return refuse("unproven");
    }
    return {
      condition: { status: "stopped", expectedTurnId: args.expectedTurnId },
    };
  }
}
