import { getThread, listEvents, listQueuedThreadMessages } from "@bb/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import { sendQueuedMessageNow } from "../../src/services/threads/queued-messages.js";
import { seedEnvironment, seedEvent, seedHostSession, seedProjectWithSource, seedThread, seedThreadRuntimeState } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { listQueuedCommands } from "../helpers/commands.js";

const owned = resolve(import.meta.dirname, "../../../../..");
const controller = join(owned, "source/controller/runtime-retry-admission.mjs");
const ledgerModule = join(owned, "source/controller/dispatch-ledger.mjs");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true}); });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const requests = (h: TestAppHarness, threadId: string) => listEvents(h.db, {threadId}).filter(e => e.type === "client/turn/requested");
const commands = (h: TestAppHarness) => listQueuedCommands(h, "turn.submit");

function fixture(h: TestAppHarness, max = 14, kind = "manager") {
  const root = mkdtempSync(join(tmpdir(), "v46-retry-")); roots.push(root);
  const {host} = seedHostSession(h.deps);
  const {project} = seedProjectWithSource(h.deps, {hostId:host.id, path:root});
  const environment = seedEnvironment(h.deps, {hostId:host.id, projectId:project.id, path:root});
  const thread = seedThread(h.deps, {environmentId:environment.id, projectId:project.id, status:"active"});
  seedThreadRuntimeState(h.deps, {environmentId:environment.id, threadId:thread.id, inputText:"Original work", providerThreadId:"provider-runtime-retry"});
  const original = requests(h, thread.id)[0]!;
  const requestId = readEvent(original).requestId;
  seedEvent(h.deps, {threadId:thread.id, environmentId:environment.id, sequence:original.sequence+1,
    type:"turn/input/accepted", scope:{kind:"turn",turnId:"turn-original"},
    data:{providerThreadId:"provider-runtime-retry",clientRequestId:requestId}});
  applyLoggedThreadLifecycleEvent(h.deps, {event:{type:"run.failed"},threadId:thread.id});
  const acceptance = listEvents(h.db,{threadId:thread.id}).find(e=>e.type==="turn/input/accepted")!;
  const ledgerPath = join(root,"ledger.json"), authorityPath=join(root,"authority.json");
  const authority={version:1,issuerId:"fixture-issuer",projectId:project.id,ledgerPath,pins:[
    {label:"node",path:process.execPath,sha256:sha(readFileSync(process.execPath))},
    {label:"controller",path:controller,sha256:sha(readFileSync(controller))},
    {label:"ledger",path:ledgerModule,sha256:sha(readFileSync(ledgerModule))}]};
  writeFileSync(authorityPath,JSON.stringify(authority));
  const authoritySha256=sha(readFileSync(authorityPath));
  const proof={threadId:thread.id,turnId:"turn-original",requestId,requestEventId:original.id,acceptanceEventId:acceptance.id};
  const state={version:1,ceilings:{total:max,role:8,manager:8,initialReadiness:2},deadlineAt:new Date(Date.now()+120000).toISOString(),
    actualTurns:[{threadId:thread.id,turnId:"turn-original",category:kind,initialReadiness:false,firstDispatchId:"original"}],
    dispatchAttempts:[],reservations:[{dispatchId:"original",kind,key:"original",status:"accepted",initialReadiness:false,nativeInvokedAt:new Date().toISOString(),nativeReturn:{threadId:thread.id},proof}],
    runtimeAdmission:{issuerId:authority.issuerId,projectId:project.id,authoritySha256}};
  writeFileSync(ledgerPath,JSON.stringify(state));
  h.db.run(sql`create table if not exists native_retry_admission (project_id text primary key, authority_path text not null, authority_sha256 text not null)`);
  h.db.run(sql`insert into native_retry_admission values (${project.id},${authorityPath},${authoritySha256})`);
  return {root,thread,environment,requestId,ledgerPath,authorityPath};
}
function readEvent(event:{data:string}) { return JSON.parse(event.data); }
async function queue(h:TestAppHarness,f:ReturnType<typeof fixture>) {
  return retryFailedTurn(h.deps,{thread:getThread(h.db,f.thread.id)!,request:{turnRequestId:f.requestId,sendAt:Date.now()+60000,reason:"Selected model at capacity"}});
}
async function sweep(h:TestAppHarness) {return runQueuedMessageDispatch(h.deps,{kind:"time-reached",now:Date.now()+120000});}

it("actual due scheduler reserves the failed original's retry before one host command",async()=>{
  await withTestHarness(async h=>{
    const f=fixture(h), before=commands(h).length;
    await queue(h,f);await sweep(h);
    const rows=requests(h,f.thread.id);expect(rows).toHaveLength(2);
    expect(readEvent(rows[1]!)).toMatchObject({retryOfRequestId:f.requestId,retryAttempt:2,initiator:"system",input:[{text:"Please continue.",visibility:"agent-only"}]});
    expect(commands(h).length).toBe(before+1);
    const ledger=read(f.ledgerPath);expect(ledger.actualTurns).toHaveLength(1);expect(ledger.reservations).toHaveLength(2);
    expect(ledger.reservations[1].runtimeRetry.requestId).toBe(readEvent(rows[1]!).requestId);
    const saved=readFileSync(f.ledgerPath);await sweep(h);
    expect(readFileSync(f.ledgerPath)).toEqual(saved);expect(commands(h).length).toBe(before+1);
  });
});
it("exhausted actual scheduler cannot append or dispatch and retains original failure capacity",async()=>{
  await withTestHarness(async h=>{
    const f=fixture(h,1), before=commands(h).length,saved=readFileSync(f.ledgerPath);
    await queue(h,f);await sweep(h);
    expect(requests(h,f.thread.id)).toHaveLength(1);expect(commands(h).length).toBe(before);
    expect(readFileSync(f.ledgerPath)).toEqual(saved);
  });
});
it("persisted authority denies omission and exact restoration permits explicit send of the original queued retry",async()=>{
  await withTestHarness(async h=>{
    const f=fixture(h), before=commands(h).length,saved=readFileSync(f.ledgerPath);
    await queue(h,f);renameSync(f.authorityPath,f.authorityPath+".saved");await sweep(h);
    expect(requests(h,f.thread.id)).toHaveLength(1);expect(commands(h).length).toBe(before);expect(readFileSync(f.ledgerPath)).toEqual(saved);
    renameSync(f.authorityPath+".saved",f.authorityPath);
    const retained=listQueuedThreadMessages(h.db,f.thread.id);expect(retained).toHaveLength(1);
    await sendQueuedMessageNow(h.deps,{threadId:f.thread.id,queuedMessageId:retained[0]!.id,mode:"auto"});
    expect(requests(h,f.thread.id)).toHaveLength(2);expect(commands(h).length).toBe(before+1);
  });
});
it("role retry requires its own two publisher guards atomically",async()=>{
  await withTestHarness(async h=>{
    const f=fixture(h,3,"role"), before=commands(h).length,saved=readFileSync(f.ledgerPath);
    await queue(h,f);await sweep(h);
    expect(requests(h,f.thread.id)).toHaveLength(1);expect(commands(h).length).toBe(before);expect(readFileSync(f.ledgerPath)).toEqual(saved);
  });
});
it("concurrent actual scheduler arrivals dispatch one scoped retry and reserve two role publisher guards",async()=>{
  await withTestHarness(async h=>{
    const f=fixture(h,14,"role"), before=commands(h).length;
    await queue(h,f);await Promise.all([sweep(h),sweep(h)]);
    expect(requests(h,f.thread.id)).toHaveLength(2);expect(commands(h).length).toBe(before+1);
    const ledger=read(f.ledgerPath);expect(ledger.reservations.filter((r:{purpose?:string})=>r.purpose==="automatic-native-publication")).toHaveLength(2);
  });
});
it("recorded manual interruption before scheduled retry consumes no new reservation or transport",async()=>{
  await withTestHarness(async h=>{
    const f=fixture(h), before=commands(h).length,saved=readFileSync(f.ledgerPath);
    await queue(h,f);
    const events=listEvents(h.db,{threadId:f.thread.id});
    seedEvent(h.deps,{threadId:f.thread.id,environmentId:f.environment.id,sequence:events.at(-1)!.sequence+1,type:"system/thread/interrupted",scope:{kind:"thread"},data:{reason:"manual-stop"}});
    await sweep(h);
    expect(requests(h,f.thread.id)).toHaveLength(1);expect(commands(h).length).toBe(before);expect(readFileSync(f.ledgerPath)).toEqual(saved);
  });
});
it("changed authority denies public explicit send without append and restores exact original queued work",async()=>{
  await withTestHarness(async h=>{
    const f=fixture(h), before=commands(h).length,saved=readFileSync(f.ledgerPath),authority=readFileSync(f.authorityPath);
    await queue(h,f);writeFileSync(f.authorityPath,'{}');await sweep(h);
    expect(requests(h,f.thread.id)).toHaveLength(1);expect(commands(h).length).toBe(before);expect(readFileSync(f.ledgerPath)).toEqual(saved);
    const row=listQueuedThreadMessages(h.db,f.thread.id)[0]!;
    await expect(sendQueuedMessageNow(h.deps,{threadId:f.thread.id,queuedMessageId:row.id,mode:"auto"})).rejects.toThrow("authority changed");
    expect(commands(h).length).toBe(before);expect(readFileSync(f.ledgerPath)).toEqual(saved);
    writeFileSync(f.authorityPath,authority);
    await sendQueuedMessageNow(h.deps,{threadId:f.thread.id,queuedMessageId:row.id,mode:"auto"});
    expect(requests(h,f.thread.id)).toHaveLength(2);expect(commands(h).length).toBe(before+1);
  });
});
it("later original request displaces the queued retry before reservation or host dispatch",async()=>{
  await withTestHarness(async h=>{
    const f=fixture(h), before=commands(h).length,saved=readFileSync(f.ledgerPath);
    await queue(h,f);
    const events=listEvents(h.db,{threadId:f.thread.id}),original=readEvent(requests(h,f.thread.id)[0]!);
    seedEvent(h.deps,{threadId:f.thread.id,environmentId:f.environment.id,sequence:events.at(-1)!.sequence+1,type:"client/turn/requested",scope:{kind:"thread"},data:{...original,requestId:"creq_abcdefghjk"}});
    await sweep(h);
    expect(requests(h,f.thread.id)).toHaveLength(2);expect(commands(h).length).toBe(before);expect(readFileSync(f.ledgerPath)).toEqual(saved);
  });
});
it("changed original environment denies the required retry before ledger reservation or host dispatch",async()=>{
  await withTestHarness(async h=>{
    const f=fixture(h), before=commands(h).length,saved=readFileSync(f.ledgerPath);
    await queue(h,f);
    h.db.run(sql`update events set environment_id=null where thread_id=${f.thread.id} and type='client/turn/requested'`);
    await sweep(h);
    expect(requests(h,f.thread.id)).toHaveLength(1);expect(commands(h).length).toBe(before);
    expect(readFileSync(f.ledgerPath)).toEqual(saved);
  });
});
