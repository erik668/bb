import type { BrowserSnapshot } from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface BrowserSnapshotArgs {
  signal?: AbortSignal;
  threadId: string;
}

export interface BrowserArea {
  snapshot(args: BrowserSnapshotArgs): Promise<BrowserSnapshot>;
}

export function createBrowserArea(args: CreateSdkAreaArgs): BrowserArea {
  const { transport } = args;
  return {
    async snapshot(input) {
      return transport.readJson(
        transport.api.v1.browser.snapshots.$post(
          { json: { threadId: input.threadId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
