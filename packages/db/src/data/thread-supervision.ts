import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { sourcePinSchema, type SourcePin } from "@bb/domain";
import type { DbQueryConnection } from "../connection.js";
import { events, threads, threadSupervisors, threadSupervisorBindings, threadSupervisorInbox, threadSourcePins } from "../schema.js";

export type ThreadSupervisorRow = typeof threadSupervisors.$inferSelect;
export type ThreadSupervisorInboxRow = typeof threadSupervisorInbox.$inferSelect;

export function getThreadSupervisor(db: DbQueryConnection, id: string) {
  return db.select().from(threadSupervisors).where(eq(threadSupervisors.id, id)).get();
}

export function insertThreadSupervisor(db: DbQueryConnection, row: ThreadSupervisorRow) {
  db.insert(threadSupervisors).values(row).run();
}

export function getThreadSupervisorBinding(db: DbQueryConnection, childThreadId: string) {
  return db.select({ binding: threadSupervisorBindings, supervisor: threadSupervisors })
    .from(threadSupervisorBindings)
    .leftJoin(threadSupervisors, eq(threadSupervisors.id, threadSupervisorBindings.supervisorId))
    .where(eq(threadSupervisorBindings.childThreadId, childThreadId)).get();
}

export function insertThreadSupervisorBinding(db: DbQueryConnection, row: typeof threadSupervisorBindings.$inferInsert) {
  db.insert(threadSupervisorBindings).values(row).run();
}

export function getThreadSupervisorInboxItem(db: DbQueryConnection, key: string) {
  return db.select().from(threadSupervisorInbox).where(eq(threadSupervisorInbox.key, key)).get();
}

export function getSupervisorNoticeByQueuedMessage(db: DbQueryConnection, queuedMessageId: string) {
  return db.select().from(threadSupervisorInbox).where(eq(threadSupervisorInbox.queuedMessageId, queuedMessageId)).get();
}

export function getSupervisorNoticeRequestSequence(db: DbQueryConnection, args: { managerThreadId: string; key: string }): number | null {
  const row = db.select({ sequence: events.sequence }).from(events).where(and(
    eq(events.threadId, args.managerThreadId), eq(events.type, "client/turn/requested"),
    sql`json_extract(${events.data}, '$.initiator') = 'system'`,
    sql`EXISTS (SELECT 1 FROM json_each(${events.data}, '$.input') AS input WHERE json_extract(input.value, '$.type') = 'text' AND instr(json_extract(input.value, '$.text'), ${`key ${args.key}]`}) > 0)`,
  )).orderBy(asc(events.sequence)).limit(1).get();
  return row?.sequence ?? null;
}

export function insertThreadSupervisorInboxItem(db: DbQueryConnection, row: ThreadSupervisorInboxRow) {
  db.insert(threadSupervisorInbox).values(row).onConflictDoNothing().run();
}

export function markThreadSupervisorInboxQueued(db: DbQueryConnection, key: string, queuedMessageId: string) {
  db.update(threadSupervisorInbox).set({ queuedMessageId }).where(eq(threadSupervisorInbox.key, key)).run();
}

export function listThreadSupervisorInbox(db: DbQueryConnection, args: { supervisorId: string; after: ThreadSupervisorInboxRow | null; limit: number }) {
  const after = args.after;
  return db.select().from(threadSupervisorInbox).where(and(
    eq(threadSupervisorInbox.supervisorId, args.supervisorId),
    after === null ? undefined : or(gt(threadSupervisorInbox.createdAt, after.createdAt), and(eq(threadSupervisorInbox.createdAt, after.createdAt), gt(threadSupervisorInbox.key, after.key))),
  )).orderBy(asc(threadSupervisorInbox.createdAt), asc(threadSupervisorInbox.key)).limit(args.limit).all();
}

export function insertThreadSourcePin(db: DbQueryConnection, threadId: string, pin: SourcePin) {
  db.insert(threadSourcePins).values({ threadId, pin: JSON.stringify(pin), createdAt: Date.now() }).run();
}

export function getThreadSourcePin(db: DbQueryConnection, threadId: string): SourcePin | null {
  const row = db.select().from(threadSourcePins).where(eq(threadSourcePins.threadId, threadId)).get();
  return row === undefined ? null : sourcePinSchema.parse(JSON.parse(row.pin));
}

export function getSupervisorTerminalEvent(db: DbQueryConnection, childThreadId: string) {
  return db.select({ sequence: events.sequence, turnId: events.turnId, type: events.type, data: events.data })
    .from(events).where(and(eq(events.threadId, childThreadId), inArray(events.type, ["turn/completed", "system/error", "system/thread/interrupted"])))
    .orderBy(desc(events.sequence)).limit(1).get();
}

export function listSupervisorRecoveryChildren(db: DbQueryConnection, supervisorId: string) {
  return db.select({ child: threads }).from(threadSupervisorBindings)
    .innerJoin(threads, eq(threads.id, threadSupervisorBindings.childThreadId))
    .where(and(eq(threadSupervisorBindings.supervisorId, supervisorId), inArray(threads.status, ["idle", "error"]), sql`${threads.deletedAt} IS NULL`)).all().map((row) => row.child);
}
