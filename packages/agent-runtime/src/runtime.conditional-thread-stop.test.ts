import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import { RuntimeProviderProcessManager } from "./runtime-provider-process.js";
import {
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";

describe("conditional runtime stop fence", () => {
  it.each([
    "success",
    "cancelled",
    "malformed",
    "disappeared",
    "replaced",
    "replacement-completed",
  ])(
    "fences new work through a delayed provider reply and unwinds on %s",
    async (outcome) => {
      const workspacePath = mkdtempSync(join(tmpdir(), "bb-conditional-stop-"));
      const record = createScriptedEchoRequestRecord();
      const events: ThreadEvent[] = [];
      const lookup = vi.spyOn(
        RuntimeProviderProcessManager.prototype,
        "requireProviderProcess",
      );
      const runtime = createScriptedEchoRuntime({
        runtime: {
          workspacePath,
          env: record.env,
          onEvent: (event) => events.push(event),
        },
      });
      const startArgs = {
        environmentId: "env-conditional",
        threadId: "t-conditional",
        projectId: "p-conditional",
        providerId: "fake",
        options: fullRuntimeOptions,
      };
      const deliver = createDeferredPromise<void>();
      let stop: ReturnType<typeof runtime.stopThread> | undefined;
      try {
        await runtime.startThread(startArgs);
        await runtime.runTurn({
          threadId: startArgs.threadId,
          clientRequestId: "creq_222222222u",
          input: [promptTextInput({ text: "delay:60000" })],
          options: fullRuntimeOptions,
        });
        await vi.waitFor(() =>
          expect(runtime.getActiveTurnId(startArgs.threadId)).not.toBeNull(),
        );
        const expectedTurnId = runtime.getActiveTurnId(startArgs.threadId);
        if (expectedTurnId === null)
          throw new Error("Active turn was not observed");
        const lastLookup = lookup.mock.results.at(-1);
        if (lastLookup?.type !== "return") {
          throw new Error("Provider process lookup was not captured");
        }
        const proc = lastLookup.value;
        const setPending = proc.pending.set.bind(proc.pending);
        const received = createDeferredPromise<void>();
        vi.spyOn(proc.pending, "set").mockImplementationOnce((id, pending) => {
          return setPending(id, {
            ...pending,
            resolve: (result) => {
              received.resolve(undefined);
              void deliver.promise.then(() => {
                if (outcome === "cancelled") {
                  pending.reject(
                    new Error("Conditional stop transport cancelled"),
                  );
                } else {
                  pending.resolve(
                    outcome === "malformed"
                      ? { providerCheckpointId: 7 }
                      : result,
                  );
                }
              });
            },
          });
        });
        stop = runtime.stopThread({
          threadId: startArgs.threadId,
          expectedTurnId,
        });
        const stopOutcome = stop.then(
          (result) => ({ result, error: null }),
          (error: Error) => ({ result: null, error }),
        );
        await received.promise;
        expect(runtime.getActiveTurnId(startArgs.threadId)).toBeNull();
        await expect(
          runtime.runTurn({
            threadId: startArgs.threadId,
            clientRequestId: "creq_222222222v",
            input: [promptTextInput({ text: "replacement" })],
            options: fullRuntimeOptions,
          }),
        ).rejects.toThrow("conditional stop is in progress");
        await expect(runtime.startThread(startArgs)).rejects.toThrow(
          "conditional stop is in progress",
        );
        await expect(
          runtime.resumeThread({
            ...startArgs,
            providerThreadId: "replacement-session",
          }),
        ).rejects.toThrow("conditional stop is in progress");
        expect(
          record.read().filter((entry) => entry.method === "turn/start"),
        ).toHaveLength(1);
        if (outcome === "replaced" || outcome === "replacement-completed") {
          const stdout = proc.child.stdout;
          if (stdout === null) throw new Error("Provider stdout was not piped");
          stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: "2.0",
                method: "thread/delta",
                params: {
                  threadId: startArgs.threadId,
                  deltas: [
                    {
                      kind: "turn.open",
                      providerTurnId: "provider-replacement",
                    },
                    ...(outcome === "replacement-completed"
                      ? [
                          {
                            kind: "turn.boundary",
                            providerTurnId: "provider-replacement",
                            status: "completed",
                          },
                        ]
                      : []),
                  ],
                },
              })}\n`,
            ),
          );
          const replacementTurn = [...events]
            .reverse()
            .find((event) => event.type === "turn/started");
          expect(replacementTurn?.scope).not.toEqual({
            kind: "turn",
            turnId: expectedTurnId,
          });
        }
        const replacementSnapshot = {
          events: [...events],
          activeTurnId: runtime.getActiveTurnId(startArgs.threadId),
        };
        if (outcome === "disappeared") {
          await runtime.shutdown();
        }
        deliver.resolve(undefined);
        const settled = await stopOutcome;
        if (outcome === "success") {
          expect(settled.result).toEqual({
            providerCheckpointId: null,
            condition: { status: "stopped", expectedTurnId },
          });
        } else if (outcome === "disappeared") {
          expect(settled.result).toEqual({
            providerCheckpointId: null,
            condition: {
              status: "refused",
              expectedTurnId,
              reason: "runtime-missing",
              activeTurnId: null,
            },
          });
          return;
        } else if (
          outcome === "replaced" ||
          outcome === "replacement-completed"
        ) {
          expect(settled.result).toEqual({
            providerCheckpointId: null,
            condition: {
              status: "refused",
              expectedTurnId,
              reason: "turn-mismatch",
              activeTurnId: replacementSnapshot.activeTurnId,
            },
          });
          expect(runtime.hasThread(startArgs.threadId)).toBe(true);
          expect({
            events,
            activeTurnId: runtime.getActiveTurnId(startArgs.threadId),
          }).toEqual(replacementSnapshot);
          return;
        } else {
          expect(settled.result).toBeNull();
          expect(settled.error?.message).toMatch(
            /cancelled|Invalid JSON-RPC result/,
          );
        }
        expect(runtime.hasThread(startArgs.threadId)).toBe(true);
        await runtime.runTurn({
          threadId: startArgs.threadId,
          clientRequestId: "creq_222222222w",
          input: [promptTextInput({ text: "reused session" })],
          options: fullRuntimeOptions,
        });
        expect(
          record.read().filter((entry) => entry.method === "thread/start"),
        ).toHaveLength(1);
        expect(
          record.read().filter((entry) => entry.method === "turn/start"),
        ).toHaveLength(2);
      } finally {
        deliver.resolve(undefined);
        await stop?.catch(() => undefined);
        vi.restoreAllMocks();
        await runtime.shutdown();
        rmSync(workspacePath, { recursive: true, force: true });
      }
    },
  );
});
