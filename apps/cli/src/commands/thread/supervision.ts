import { Command } from "commander";
import {
  supervisorCredentialSchema,
  supervisorInboxRequestSchema,
  supervisorNotifyRequestSchema,
} from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveMachineHostId } from "../machine.js";
import { outputJson } from "../helpers.js";

interface AddressOptions {
  thread: string;
  campaign: string;
  inbox: string;
  token?: string;
  afterKey?: string;
  noticeKey?: string;
  limit?: string;
  json?: boolean;
}
const address = (opts: AddressOptions) => ({
  managerThreadId: opts.thread,
  campaignId: opts.campaign,
  inboxId: opts.inbox,
});
function printResult(opts: { json?: boolean }, data: object): void {
  if (!outputJson(opts, data)) console.log(data);
}

export function registerSupervisionCommands(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("source-inspect")
    .description(
      "Inspect immutable source objects in the exact target project repository without creating a thread",
    )
    .requiredOption("--project <id>", "Target project")
    .requiredOption("--machine <id-or-name>", "Target execution machine")
    .requiredOption("--ref <ref>", "Discovery ref or raw commit")
    .requiredOption("--workflow-path <path>", "Relative workflow tree path")
    .option("--json", "Print JSON")
    .action(
      action(
        async (opts: {
          project: string;
          machine: string;
          ref: string;
          workflowPath: string;
          json?: boolean;
        }) => {
          const hostId = await resolveMachineHostId({
            serverUrl: getUrl(),
            target: opts.machine,
          });
          printResult(
            opts,
            await createCliBbSdk(getUrl()).threads.experimental_inspectSource({
              projectId: opts.project,
              hostId,
              ref: opts.ref,
              workflowPath: opts.workflowPath,
            }),
          );
        },
      ),
    );
  parent
    .command("supervisor-register")
    .description(
      "Register a durable campaign inbox; retain the returned private binding token",
    )
    .requiredOption("--thread <id>", "Manager thread")
    .requiredOption("--campaign <id>", "Campaign identity")
    .requiredOption("--inbox <id>", "Inbox identity")
    .option(
      "--token <hex>",
      "Private 64-hex token for recoverable registration and replay",
    )
    .option("--json", "Print JSON")
    .action(
      action(async (opts: AddressOptions) =>
        printResult(
          opts,
          await createCliBbSdk(
            getUrl(),
          ).threads.experimental_registerSupervisor({
            ...address(opts),
            ...(opts.token === undefined ? {} : { bindingToken: opts.token }),
          }),
        ),
      ),
    );
  parent
    .command("supervisor-inbox")
    .description(
      "Read durable worker outcomes and recover publication after a server restart",
    )
    .requiredOption("--thread <id>", "Manager thread")
    .requiredOption("--campaign <id>", "Campaign identity")
    .requiredOption("--inbox <id>", "Inbox identity")
    .option("--after-key <key>", "Continue after an item in this inbox")
    .option(
      "--notice-key <key>",
      "Find the exact original notification key; cannot combine with --after-key",
    )
    .option("--limit <count>", "Maximum items (1–500)")
    .option("--json", "Print JSON")
    .action(
      action(async (opts: AddressOptions) =>
        printResult(
          opts,
          await createCliBbSdk(getUrl()).threads.experimental_supervisorInbox({
            ...address(opts),
            ...(opts.afterKey === undefined ? {} : { afterKey: opts.afterKey }),
            ...(opts.noticeKey === undefined
              ? {}
              : { noticeKey: opts.noticeKey }),
            ...(opts.limit === undefined ? {} : { limit: Number(opts.limit) }),
          }),
        ),
      ),
    );
  parent
    .command("supervisor-peek")
    .description("Read stored supervisor receipts without recovery or delivery")
    .requiredOption("--thread <id>", "Manager thread")
    .requiredOption("--campaign <id>", "Campaign identity")
    .requiredOption("--inbox <id>", "Inbox identity")
    .option("--after-key <key>", "Continue after an item in this inbox")
    .option(
      "--notice-key <key>",
      "Find the exact original notification key; cannot combine with --after-key",
    )
    .option("--limit <count>", "Maximum items (1–500)")
    .option("--json", "Print JSON")
    .action(
      action(async (opts: AddressOptions) =>
        printResult(
          opts,
          await createCliBbSdk(getUrl()).threads.experimental_supervisorPeek(
            supervisorInboxRequestSchema.parse({
              ...address(opts),
              ...(opts.afterKey === undefined
                ? {}
                : { afterKey: opts.afterKey }),
              ...(opts.noticeKey === undefined
                ? {}
                : { noticeKey: opts.noticeKey }),
              ...(opts.limit === undefined
                ? {}
                : { limit: Number(opts.limit) }),
            }),
          ),
        ),
      ),
    );
  parent
    .command("supervisor-notify")
    .description(
      "Persist a stable decision or exception and admit its manager wake exactly once",
    )
    .requiredOption("--binding <json>", "Private supervisor credential")
    .requiredOption("--key <key>", "Stable idempotency key")
    .requiredOption("--kind <kind>", "decision or exception")
    .requiredOption("--message <message>", "Manager notice")
    .option("--task <id>", "Related task")
    .option("--json", "Print JSON")
    .action(
      action(
        async (opts: {
          binding: string;
          key: string;
          kind: string;
          message: string;
          task?: string;
          json?: boolean;
        }) => {
          const credential = supervisorCredentialSchema.parse(
            JSON.parse(opts.binding),
          );
          printResult(
            opts,
            await createCliBbSdk(
              getUrl(),
            ).threads.experimental_notifySupervisor(
              supervisorNotifyRequestSchema.parse({
                ...credential,
                key: opts.key,
                kind: opts.kind,
                message: opts.message,
                taskId: opts.task ?? null,
              }),
            ),
          );
        },
      ),
    );
}
