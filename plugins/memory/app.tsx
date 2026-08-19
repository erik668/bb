import { Fragment, useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  CandidateChallenge,
  MemoryCandidate,
  MemoryRecord as MemoryRecordContract,
  memoryRpcContract,
} from "./server.js";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Switch } from "@bb/shared-ui/switch";
import { Textarea } from "@bb/shared-ui/textarea";

const MEMORY_KINDS = [
  "fact",
  "preference",
  "decision",
  "procedure",
  "episode",
  "reference",
] as const;
type MemoryKind = (typeof MEMORY_KINDS)[number];
type MemoryRecord = Pick<
  MemoryRecordContract,
  | "id"
  | "scope"
  | "projectId"
  | "name"
  | "summary"
  | "details"
  | "kind"
  | "tags"
  | "importance"
  | "pinned"
  | "version"
  | "updatedAt"
>;

function isMemoryKind(value: string): value is MemoryKind {
  return MEMORY_KINDS.some((candidate) => candidate === value);
}

type PendingMemoryCandidate = MemoryCandidate & {
  status: "pending";
  decisionReceipt: null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMemory(value: unknown): MemoryRecord {
  if (!isRecord(value)) throw new Error("Memory returned an invalid record.");
  const kind = value.kind;
  if (
    typeof value.id !== "string" ||
    (value.scope !== "global" && value.scope !== "project") ||
    (value.projectId !== null && typeof value.projectId !== "string") ||
    typeof value.name !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.details !== "string" ||
    typeof kind !== "string" ||
    !isMemoryKind(kind) ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === "string") ||
    typeof value.importance !== "number" ||
    typeof value.pinned !== "boolean" ||
    typeof value.version !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    throw new Error("Memory returned an invalid record.");
  }
  return {
    id: value.id,
    scope: value.scope,
    projectId: value.projectId,
    name: value.name,
    summary: value.summary,
    details: value.details,
    kind,
    tags: value.tags,
    importance: value.importance,
    pinned: value.pinned,
    version: value.version,
    updatedAt: value.updatedAt,
  };
}

function parseMemoryList(value: unknown): MemoryRecord[] {
  if (!isRecord(value) || !Array.isArray(value.memories)) {
    throw new Error("Memory returned an invalid list.");
  }
  return value.memories.map(parseMemory);
}

function parseUpdatedMemory(value: unknown): MemoryRecord {
  if (!isRecord(value)) throw new Error("Memory returned an invalid update.");
  return parseMemory(value.memory);
}

function parseStringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`Memory returned invalid ${label}.`);
  }
  return value;
}

function parseCandidateChallenge(value: unknown): CandidateChallenge {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.summary !== "string" ||
    (value.sourceThreadId !== null &&
      typeof value.sourceThreadId !== "string") ||
    typeof value.createdAt !== "number"
  ) {
    throw new Error("Memory returned an invalid candidate challenge.");
  }
  return {
    id: value.id,
    summary: value.summary,
    evidence: parseStringList(value.evidence, "challenge evidence"),
    sourceThreadId: value.sourceThreadId,
    createdAt: value.createdAt,
  };
}

function parseCandidate(value: unknown): PendingMemoryCandidate {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.status !== "pending" ||
    (value.scope !== "global" && value.scope !== "project") ||
    (value.projectId !== null && typeof value.projectId !== "string") ||
    typeof value.name !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.details !== "string" ||
    typeof value.kind !== "string" ||
    !isMemoryKind(value.kind) ||
    typeof value.importance !== "number" ||
    typeof value.pinned !== "boolean" ||
    !Array.isArray(value.challenges) ||
    (value.proposedByThreadId !== null &&
      typeof value.proposedByThreadId !== "string") ||
    typeof value.proposalReason !== "string" ||
    typeof value.version !== "number" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    value.decisionReceipt !== null
  ) {
    throw new Error("Memory returned an invalid candidate.");
  }
  return {
    id: value.id,
    status: value.status,
    scope: value.scope,
    projectId: value.projectId,
    name: value.name,
    summary: value.summary,
    details: value.details,
    kind: value.kind,
    tags: parseStringList(value.tags, "candidate tags"),
    importance: value.importance,
    pinned: value.pinned,
    evidence: parseStringList(value.evidence, "candidate evidence"),
    challenges: value.challenges.map(parseCandidateChallenge),
    proposedByThreadId: value.proposedByThreadId,
    proposalReason: value.proposalReason,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    decisionReceipt: null,
  };
}

function parseCandidateList(value: unknown): PendingMemoryCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    throw new Error("Memory returned an invalid candidate list.");
  }
  return value.candidates.map(parseCandidate);
}

function parseApprovedMemory(value: unknown): MemoryRecord {
  if (!isRecord(value)) throw new Error("Memory returned an invalid approval.");
  return parseMemory(value.memory);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MemoryEditor({
  memory,
  onCancel,
  onSaved,
}: {
  memory: MemoryRecord;
  onCancel: () => void;
  onSaved: (memory: MemoryRecord) => void;
}) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [draft, setDraft] = useState(memory);
  const [tags, setTags] = useState(memory.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Summary
          <Input
            aria-label="Memory summary"
            value={draft.summary}
            maxLength={400}
            onChange={(event) =>
              setDraft({ ...draft, summary: event.target.value })
            }
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Tags
          <Input
            aria-label="Memory tags"
            value={tags}
            placeholder="comma, separated"
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Details
        <Textarea
          aria-label="Memory details"
          value={draft.details}
          maxLength={16_000}
          className="min-h-28 resize-y text-sm"
          onChange={(event) =>
            setDraft({ ...draft, details: event.target.value })
          }
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          Kind
          <select
            aria-label="Memory kind"
            value={draft.kind}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={(event) => {
              if (isMemoryKind(event.target.value)) {
                setDraft({ ...draft, kind: event.target.value });
              }
            }}
          >
            {MEMORY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Importance
          <Input
            aria-label="Memory importance"
            type="number"
            min={0}
            max={100}
            value={draft.importance}
            onChange={(event) =>
              setDraft({ ...draft, importance: Number(event.target.value) })
            }
          />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <Switch
            aria-label="Pinned memory"
            checked={draft.pinned}
            onCheckedChange={(pinned) => setDraft({ ...draft, pinned })}
          />
          Pinned
        </label>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            void rpc
              .call("updateMemory", {
                id: draft.id,
                expectedVersion: draft.version,
                summary: draft.summary,
                details: draft.details,
                kind: draft.kind,
                tags: tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                importance: draft.importance,
                pinned: draft.pinned,
              })
              .then(parseUpdatedMemory)
              .then(onSaved)
              .catch((saveError: unknown) => setError(errorMessage(saveError)))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function CandidateReview({
  candidate,
  onDecided,
}: {
  candidate: PendingMemoryCandidate;
  onDecided: (memory: MemoryRecord | null) => void;
}) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [reason, setReason] = useState("");
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = deciding !== null || reason.trim().length === 0;

  const decide = (decision: "approve" | "reject") => {
    setDeciding(decision);
    setError(null);
    const input = {
      id: candidate.id,
      expectedVersion: candidate.version,
      reason,
    };
    const request =
      decision === "approve"
        ? rpc.call("approveCandidate", input).then(parseApprovedMemory)
        : rpc.call("rejectCandidate", input).then(() => null);
    void request
      .then(onDecided)
      .catch((decisionError: unknown) => setError(errorMessage(decisionError)))
      .finally(() => setDeciding(null));
  };

  return (
    <article className="space-y-3 border-b border-border p-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-foreground">{candidate.name}</div>
          <div className="mt-1 break-words text-sm text-muted-foreground">
            {candidate.summary}
          </div>
        </div>
        <div className="flex gap-2 text-xs text-muted-foreground">
          <span>{candidate.scope}</span>
          <span>{candidate.kind}</span>
          <span>v{candidate.version}</span>
        </div>
      </div>
      <div className="whitespace-pre-wrap text-sm text-foreground">
        {candidate.details}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Evidence
          </div>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-foreground">
            {candidate.evidence.map((item) => (
              <li key={item} className="break-words">
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Challenges
          </div>
          {candidate.challenges.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              No counterevidence attached.
            </p>
          ) : (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-foreground">
              {candidate.challenges.map((challenge) => (
                <li key={challenge.id} className="break-words">
                  {challenge.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Decision reason
        <Textarea
          aria-label={`Decision reason for ${candidate.name}`}
          value={reason}
          maxLength={400}
          className="min-h-20 resize-y text-sm"
          placeholder="Record what you inspected and why this should or should not become active memory."
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => decide("reject")}
        >
          {deciding === "reject" ? "Rejecting…" : "Reject candidate"}
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => decide("approve")}>
          {deciding === "approve" ? "Approving…" : "Approve and activate"}
        </Button>
      </div>
    </article>
  );
}

function MemorySettings() {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [candidates, setCandidates] = useState<PendingMemoryCandidate[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [memoryResult, candidateResult] = await Promise.all([
        rpc.call("listMemories"),
        rpc.call("listCandidates"),
      ]);
      setMemories(parseMemoryList(memoryResult));
      setCandidates(parseCandidateList(candidateResult));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading memories…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
        This plugin shares memory across providers. We recommend disabling
        provider-native memory under Settings → Providers to avoid duplicate or
        conflicting stores.
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <section
        className="space-y-2"
        aria-labelledby="memory-candidates-heading"
      >
        <div>
          <h3
            id="memory-candidates-heading"
            className="text-sm font-medium text-foreground"
          >
            Pending promotion review
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Agent proposals stay outside active retrieval until you approve them
            here. A recorded reason is required for every decision.
          </p>
        </div>
        {candidates.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            No candidate memories awaiting your review.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            {candidates.map((candidate) => (
              <CandidateReview
                key={candidate.id}
                candidate={candidate}
                onDecided={(memory) => {
                  setCandidates((current) =>
                    current.filter((entry) => entry.id !== candidate.id),
                  );
                  if (memory) {
                    setMemories((current) => [memory, ...current]);
                  }
                }}
              />
            ))}
          </div>
        )}
      </section>
      <section className="space-y-2" aria-labelledby="active-memories-heading">
        <h3
          id="active-memories-heading"
          className="text-sm font-medium text-foreground"
        >
          Active memories
        </h3>
        {memories.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No memories stored yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full table-fixed text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-auto px-3 py-2 font-medium">Memory</th>
                  <th className="w-24 px-3 py-2 font-medium">Scope</th>
                  <th className="w-28 px-3 py-2 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {memories.map((memory) => (
                  <Fragment key={memory.id}>
                    <tr className="align-top">
                      <td className="min-w-0 px-3 py-3">
                        <div className="truncate font-medium text-foreground">
                          {memory.pinned ? "📌 " : ""}
                          {memory.name}
                        </div>
                        <div className="mt-1 line-clamp-2 break-words text-muted-foreground">
                          {memory.summary}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{memory.kind}</span>
                          <span>importance {memory.importance}</span>
                          <span>
                            updated{" "}
                            {new Date(memory.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">
                        <div>{memory.scope}</div>
                        {memory.projectId ? (
                          <div
                            className="mt-1 max-w-36 truncate text-xs"
                            title={memory.projectId}
                          >
                            {memory.projectId}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col items-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setEditingId((current) =>
                                current === memory.id ? null : memory.id,
                              )
                            }
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={deletingId === memory.id}
                            className="text-destructive hover:text-destructive"
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `Delete memory “${memory.name}”?`,
                                )
                              ) {
                                return;
                              }
                              setDeletingId(memory.id);
                              setError(null);
                              void rpc
                                .call("deleteMemory", {
                                  id: memory.id,
                                  expectedVersion: memory.version,
                                })
                                .then(() => {
                                  setMemories((current) =>
                                    current.filter(
                                      (entry) => entry.id !== memory.id,
                                    ),
                                  );
                                  setEditingId((current) =>
                                    current === memory.id ? null : current,
                                  );
                                })
                                .catch((deleteError: unknown) =>
                                  setError(errorMessage(deleteError)),
                                )
                                .finally(() => setDeletingId(null));
                            }}
                          >
                            {deletingId === memory.id ? "Deleting…" : "Delete"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {editingId === memory.id ? (
                      <tr>
                        <td colSpan={3} className="bg-muted/10 p-3">
                          <MemoryEditor
                            memory={memory}
                            onCancel={() => setEditingId(null)}
                            onSaved={(updated) => {
                              setMemories((current) =>
                                current.map((entry) =>
                                  entry.id === updated.id ? updated : entry,
                                ),
                              );
                              setEditingId(null);
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "memory",
    title: "Memory",
    description:
      "Review and manage provider-independent global and project memories.",
    component: MemorySettings,
  });
});
