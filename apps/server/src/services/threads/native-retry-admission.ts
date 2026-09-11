import { getThread, type DbTransaction, type AppendStoredThreadEventArgs } from "@bb/db";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// The requirement lives with the scoped project in the native database, never
// in the current process environment or an optional message.dispatch hook.
export function admitRequiredNativeRetries(db: DbTransaction, events: readonly AppendStoredThreadEventArgs[]): void {
  for (const event of events) {
    if (event.type !== "client/turn/requested") continue;
    const data = event.data as Record<string, unknown>;
    if (data.retryOfRequestId === undefined) continue;
    const table = db.get(sql`select name from sqlite_master where type='table' and name='native_retry_admission'`);
    if (!table) continue;
    const thread = getThread(db, event.threadId);
    if (!thread) throw new Error("Retry admission requires original thread");
    const binding = db.get<{ authority_path: string; authority_sha256: string }>(
      sql`select authority_path, authority_sha256 from native_retry_admission where project_id=${thread.projectId}`);
    if (!binding) continue;
    const protocolId = (value: unknown): value is string =>
      typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
    if (!protocolId(data.requestId) || !protocolId(data.retryOfRequestId)
      || !Number.isSafeInteger(data.retryAttempt) || Number(data.retryAttempt) < 2
      || !protocolId(event.environmentId)) {
      throw new Error("Malformed required retry protocol metadata");
    }
    const originals = db.all<{ sequence: number; environmentId: string | null; data: string }>(
      sql`select sequence, environment_id as environmentId, data from events where thread_id=${event.threadId} and type='client/turn/requested' and json_extract(data,'$.requestId')=${data.retryOfRequestId} order by sequence`);
    const latest = db.get<{ environmentId: string | null; data: string }>(
      sql`select environment_id as environmentId, data from events where thread_id=${event.threadId} and type='client/turn/requested' order by sequence desc limit 1`);
    if (originals.length !== 1 || !latest) throw new Error("Original required retry request unavailable");
    const original = originals[0]!;
    let originalData: Record<string, unknown>;
    let previous: Record<string, unknown>;
    try {
      originalData = JSON.parse(original.data) as Record<string, unknown>;
      previous = JSON.parse(latest.data) as Record<string, unknown>;
    } catch {
      throw new Error("Malformed original required retry metadata");
    }
    if (originalData.requestId !== data.retryOfRequestId
      || original.environmentId !== event.environmentId
      || latest.environmentId !== event.environmentId) {
      throw new Error("Required retry environment or original identity changed");
    }
    if ((previous.retryOfRequestId ?? previous.requestId) !== data.retryOfRequestId || (previous.retryAttempt ?? 1) + 1 !== data.retryAttempt) {
      throw new Error("Required retry displaced by a later request or attempt");
    }
    if (db.get(sql`select id from events where thread_id=${event.threadId} and sequence>${original.sequence} and type='system/thread/interrupted' and json_extract(data,'$.reason')='manual-stop' limit 1`)) {
      throw new Error("Required retry cancelled by original manual stop");
    }
    const bytes = readFileSync(binding.authority_path);
    const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    if (hash(bytes) !== binding.authority_sha256) throw new Error("Required retry authority changed");
    const authority = JSON.parse(bytes.toString("utf8"));
    if (authority.version !== 1 || authority.projectId !== thread.projectId || !Array.isArray(authority.pins)) {
      throw new Error("Invalid required retry authority");
    }
    for (const pin of authority.pins) {
      if (hash(readFileSync(pin.path)) !== pin.sha256) throw new Error("Required retry interface changed");
    }
    const runner = authority.pins.find((pin: { label: string }) => pin.label === "node");
    const controller = authority.pins.find((pin: { label: string }) => pin.label === "controller");
    const ledger = authority.pins.find((pin: { label: string }) => pin.label === "ledger");
    if (!runner || !controller || !ledger) throw new Error("Required retry protocol unavailable");
    const result = spawnSync(runner.path, [controller.path, "--admit-runtime-retry"], {
      input: JSON.stringify({ authorityPath: binding.authority_path, authoritySha256: binding.authority_sha256,
        threadId: event.threadId, projectId: thread.projectId, environmentId: event.environmentId,
        requestId: data.requestId, retryOfRequestId: data.retryOfRequestId, retryAttempt: data.retryAttempt }),
      encoding: "utf8", timeout: 5000, maxBuffer: 65536,
    });
    if (result.error || result.status !== 0) throw new Error("Required native retry admission denied: " + (result.stderr || result.error?.message || "runner failed"));
    const admitted = JSON.parse(result.stdout);
    if (admitted.status !== "reserved" || admitted.requestId !== data.requestId) throw new Error("Invalid native retry admission response");
  }
}
