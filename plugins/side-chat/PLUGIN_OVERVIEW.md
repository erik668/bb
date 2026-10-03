Ask a follow-up question about one message without adding noise to the main conversation. A side chat is a fork of the thread that opens in a panel beside it.

## What you get

- A **Reply in side chat** action on any message. Select part of the message first to reply to only that text.
- A **Start side chat** panel action for a fork that starts from the current thread state.
- A panel that shows the quoted message and a compact chat with its own composer.
- A **Promote to primary chat** button that makes the same conversation visible in the sidebar and opens it as a full chat. Its history, workspace, ongoing work, and link to the original chat are retained.
- An **Original chat** link for returning to the source conversation.
- A **Send to main thread** action on side-chat replies. It queues the reply as a message in the original thread.

## How it works

The fork copies the conversation up to the chosen message and reuses the same workspace. The quoted text is given to the agent as context. Side chats start hidden from the sidebar. Promoting one makes it a top-level chat with normal unread and attention indicators. Its existing panel remains a shortcut to the same conversation. You can rename it using the normal chat controls.

Once per hour, the plugin looks for side chats older than 24 hours. A side chat with no user message and no queued message is archived. A side chat you used is kept.

## Agent access

Agents can promote a side chat using the existing core CLI and SDK surfaces:

```sh
bb thread list --include-hidden --json
bb thread update <side-chat-id> --visibility visible --clear-parent-thread
```

```ts
await bb.sdk.threads.update({
  threadId: sideChatId,
  visibility: "visible",
  parentThreadId: null,
});
```

Use `--title` or the SDK's `title` field to name an untitled chat. These operations preserve `sourceThreadId` and the existing conversation. The panel's `promoteSideChat` RPC additionally validates that the target is an unarchived fork owned by this plugin and supplies “Side chat” when it has no title.

To restore a hidden side chat whose panel tab was lost on an older build, find it by `originPluginId: "side-chat"` and its `sourceThreadId` in the list, then promote that existing ID. Do not create a new fork to recover its history.

The plugin adds no agent tools or CLI commands.
