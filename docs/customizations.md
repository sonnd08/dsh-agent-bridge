# Customizations

This file records what `sonnd08/dsh-agent-bridge` adds to or changes from the upstream plugin. [AGENTS.md](../AGENTS.md) gives the rule for when to add an entry.

## Upstream baseline

| Item | Value |
| --- | --- |
| Upstream repository | `wiiwings1988/dsh-agent-bridge` |
| Upstream release | `v0.2.2` |
| Upstream commit | `7b64f77` |
| Date of last sync | 2026-11-08 |

## Entry template

Copy this template to the top of the **Log** section.

```markdown
### YYYY-MM-DD: Short name of the change

- **What:** The behavior, UI, setting or dependency that we added or changed.
- **Why:** The problem that the change solves.
- **Files:** The main files that we changed.
- **Upstream merge risk:** Low, medium or high, and the upstream code that can conflict.
- **Verified:** The tests or manual checks that we did. Write "Not verified" if we did none.
```

## Log

Put the newest entry first.

### 2026-11-09: Permission levels apply to Claude Code and Codex, and a full test pass

- **What:** Read Only and Workspace Write now apply to tool calls of Claude Code and Codex. A call that the engine asks about shows the native DSH approval card, and Reject stops it. Full access runs with no question, and Auto sends the call to the reviewer. A plain read of a handoff file does not ask. Stop on a Codex command now also stops the shell process. The model label updates after a chat opens again. The rails of Claude Code and Codex follow the hidden, order and custom model settings. New unit tests cover the selector, the settings page, the client stores and the host decisions, and they render the real React components.
- **Why:** A test in Read Only showed that Claude Code created a file with no question. A full test pass found the other faults.
- **Other fixes:** a refused provider removal shows its reason; the suggested instance id is free when Codex is off; an error answer no longer breaks the preferences or the provider list; a missing Codex executable no longer crashes the host; a Codex turn that ends at once does not stay running; several tool calls after a step end stay in one step; new turns of a long Codex chat are imported; an old tool call with broken arguments no longer blocks a chat; an empty chat does not use an import slot.
- **Files:** `src/engine-access.ts`, `src/native-engine.ts`, `src/native-codex.ts`, `src/codex.ts`, `src/mirror.ts`, `src/engine-id.ts`, `src/login.ts`, `src/instances.ts`, `src/index.ts`, `src/client/seat-services.ts`, `src/client/index.ts`, `src/client/NewChat.tsx`, `src/client/model-names.ts`, `src/client/ModelsSection.tsx`, `src/client/graft.tsx`, `src/client/info.ts`, `src/client/login-store.ts`, `src/client/model-prefs-store.ts`, `src/client/providers-store.ts`, `AGENTS.md`, `tests/`
- **Upstream merge risk:** Medium. Upstream changes to `src/codex.ts`, `src/index.ts` or the settings UI can conflict.
- **Verified:** The unit tests pass. In the running app: model switch and label, Codex handoff, Claude Allow, Codex Reject, the Read Only approval card, sign-in, settings pages and chat import. Stop on Codex was tested against real Codex directly, not through the app UI. New chat, Fork, Auto, a Workspace Write file change and a real pointer hover were not tested in the app.

### 2026-11-09: One-click sign-in and a stable permission popup

- **What:** If the selected Claude Code or Codex provider is not signed in, a notice appears above the message box, and on the provider's settings page. **Sign in** runs `claude auth login` or `codex login`, and the engine opens the browser. The notice shows the state of the attempt. A turn that fails because of a missing sign-in now tells the user what to do. The permission popup keeps one height for all levels, and its order is now Read Only, Workspace Write, Auto, Full access.
- **Why:** The turn failed with only "Please run /login". The popup grew upward, so its buttons moved away from the pointer on hover. T3 Code shows the same sign-in state, but for Claude it only tells the user to run the command.
- **Files:** `src/login.ts`, `src/protocol.ts`, `src/index.ts`, `src/native-engine.ts`, `src/client/login-store.ts`, `src/client/LoginBar.tsx`, `src/client/LoginBar.module.css`, `src/client/access-order.ts`, `src/client/NewChat.tsx`, `src/client/PermissionPicker.tsx`, `src/client/ProviderPicker.module.css`, `src/client/ModelsSection.tsx`, `src/client/ModelsSection.module.css`, `src/client/index.ts`, `src/client/locales.ts`, `tests/login.test.mjs`

### 2026-11-09: Updated chats become DSH chats

- **What:** If a Claude Code or Codex chat has a new turn, the bridge imports it as a native DSH chat, and the old panel row goes away. Later turns made outside DSH appear in that DSH chat as they were written, and the engine does not run again. A message sent from the DSH chat continues the same Claude or Codex thread. Chats with no new turn stay as they are.
- **Why:** The user wants updated chats in one place.
- **Files:** `src/mirror.ts`, `src/dsh-import.ts`, `src/native-engine.ts`, `src/used-model.ts`, `src/extras.ts`, `src/protocol.ts`, `src/index.ts`, `src/client/index.ts`, `tests/mirror.test.mjs`, `tests/native-engine.test.mjs`, `tests/used-model.test.mjs`.
- **Upstream merge risk:** Medium.
- **Limits:** The import holds text only, not tool calls, and at most 400,000 characters. A finished turn appears at once, and the last turn waits until the chat is quiet for 20 seconds, so a long pause inside a turn can leave the rest of that turn out. A chat changed to another provider in DSH gets no more outside turns until it changes back.
- **Verified:** All 222 unit tests pass. In the DSH desktop app, a turn made with `claude -p --resume` appeared in the DSH chat with no engine run. A message sent from the DSH chat continued the same thread and did not show twice after later checks. Chats with no new turn were not imported.

### 2026-11-09: Open chat shows the model that it used

- **What:** The bridge reads the model and reasoning level of the last turn from the Claude or Codex session file. The panel shows them for an open chat, and the next message uses them. A pick in the chat applies until a turn uses it. The access setting does not change.
- **Why:** The panel showed the provider's last saved model, so a chat made in Claude Code on Opus showed Claude Haiku and sent the next message with Haiku.
- **Files:** `src/used-model.ts`, `src/protocol.ts`, `src/index.ts`, `src/client/transcript.ts`, `src/client/model-names.ts`, `src/client/ExternalPanel.tsx`, `tests/used-model.test.mjs`.
- **Upstream merge risk:** Low.
- **Verified:** Unit tests pass. In the DSH desktop app, a chat made in Claude Code on Opus with High effort opened as Claude Opus 5.5 High while the saved Claude model was Haiku. The Codex reader returned the right model from a real session file. A Codex chat was not opened in the panel.

### 2026-11-09: Row icon follows the selected model

- **What:** A DSH chat row shows the Claude, Codex or DeepSeek mark of the chat's selected model. An external row keeps the mark of its engine.
- **Why:** All native chats showed the DeepSeek mark after Claude Code and Codex became DSH providers.
- **Files:** `src/client/graft.tsx`, `src/client/index.ts`, `src/native-routes.ts`, `tests/native-engine.test.mjs`.
- **Upstream merge risk:** Low. The mark reads the `modelSelection` value of the DSH session list.
- **Verified:** The `native-engine` unit tests pass. In the DSH desktop app, rows showed the Claude, Codex and DeepSeek marks. A change from a Codex model to Claude Haiku changed the row mark at once, with no restart and no message.

### 2026-11-09: Folder of a long Claude session

- **What:** If the SDK gives no folder for a Claude session, the bridge reads the first `cwd` field from the session file and keeps it in memory. The panel uses the default folder if the file has no folder.
- **Why:** The SDK reads only the first and last 64 KB of a file. A long session got an empty folder, and the switch to a DeepSeek model failed with `failed to ensure project directory ""`.
- **Files:** `src/claude.ts`, `src/client/ExternalPanel.tsx`, `tests/claude-folder.test.mjs`.
- **Upstream merge risk:** Low.
- **Verified:** All 210 unit tests pass. A list of real Claude sessions has no empty folder, and a long session that the SDK reports with no folder gets its folder. The DeepSeek switch from that chat is not repeated, because it creates a new session from a real chat.

### 2026-11-09: Claude Code and Codex in one DSH chat

- **What:** Claude Code and Codex are model providers of a DSH session, on the routes `claude-code` and `codex-cli`. Added instances use their own id as the route. A model change stays in the same chat, with the native DSH chat view, right sidebar and header. Each engine runs its own tools, and the `engine_tool` proxy records each call in the DSH session. The provider selector shows Claude Code and Codex rails in every chat, with the real model lists and reasoning levels. A new chat no longer starts a separate bridge session.
- **Why:** The bridge made a second chat for each provider switch. The user wants one chat.
- **Files:** `src/native-engine.ts`, `src/native-codex.ts`, `src/native-routes.ts`, `src/codex.ts`, `src/index.ts`, `src/extras.ts`, `src/client/NewChat.tsx`, `src/client/index.ts`, `tests/native-engine.test.mjs`.
- **Upstream merge risk:** Medium. The change replaces the model seat logic and uses the DSH `llm.registerAdapter` service.
- **Limits:** The engine runs one process for each turn, so Claude Code background tasks are off in these chats. The selector has no Standard / Fast control for these rails. Engine questions (`AskUserQuestion`, Codex user input) are refused. Images do not go to the engines. Old Claude and Codex threads still open in the bridge panel.
- **Verified:** 206 unit tests pass. In the DSH desktop app, one chat changed from Claude Haiku to a DeepSeek route and back, and Claude read the hand-over file. Tool calls, a restart, Stop during a command and a message after Stop worked. The Claude Code, Codex and DeepSeek rails show in an open chat. With a Codex model, Codex ran a shell command and replied in a new chat, and the chat title came from Codex. In that chat, Codex changed to Claude Haiku and back, and each engine read the hand-over file. Stop during a Codex command and the Ask permission path are not tested in the app.

### 2026-11-09: Provider switch points to a file

- **What:** A Claude and Codex switch checks for messages that the other provider has not seen. If there are none, the message goes as typed. If there are some, the bridge writes the conversation to a Markdown file in `handoffs` beside the bridge state, and tells the provider to look at the last 30 messages and read further only if it needs more. The file has no size limit, and it holds the whole conversation of all earlier providers. Tool calls are listed by name, and tool output is left out. If the file cannot be written, the old catch-up text is sent.
- **Why:** The provider reads what it needs, and a long chat is no longer cut to 24,000 characters.
- **Files:** `src/handoff.ts`, `src/links.ts`, `src/extras.ts`, `src/run.ts`, `src/index.ts`, `tests/handoff.test.mjs`.
- **Upstream merge risk:** Low.
- **Verified:** `handoff` and `links` unit tests pass. In the DSH desktop app, Codex with Workspace Write and Claude Haiku with Default permission each opened the file without an approval and answered from it. A softer instruction was skipped by Claude Haiku, so the read is written as a required first step.

### 2026-11-09: DeepSeek import survives a reload

- **What:** After the import, the bridge releases the agent that it created. The DSH session controller loads the stored session on the next call and owns the agent.
- **Why:** The agent lived as long as the bridge plugin. A turn stopped with `aborted: disposed` about 2 seconds after a switch that changed the default model, and the session showed "Session unavailable".
- **Files:** `src/index.ts`.
- **Upstream merge risk:** Low.
- **Verified:** In the DSH desktop app, a switch that changed the default model ran a 19-second turn to the end. The imported history was correct, and a follow-up message worked.

### 2026-11-09: Folded tool rows

- **What:** The Claude and Codex panel folds the tool calls between two pieces of text into one row. The row names a result, such as **Created PR #2**, else the largest kinds of work, such as **Ran commands, read files**. While the turn runs, the row shows the newest call. One plain call stays an ordinary row. Internal calls, such as `update_plan`, `wrap_up` and `ToolSearch`, are hidden unless they fail. Rows show short MCP names and no raw JSON. Checklists move into the fold.
- **Why:** A list of raw tool rows was hard to read.
- **Files:** `src/client/tool-runs.ts`, `src/client/ToolCard.tsx`, `src/client/ToolCard.module.css`, `src/client/ExternalPanel.tsx`, `src/client/locales.ts`, `tests/tool-runs.test.mjs`, `tests/e2e.mjs`, `tests/e2e-chat.mjs`.
- **Upstream merge risk:** Low. `ToolCard.tsx` is the only upstream file with a real change.
- **Verified:** `tool-runs` and `timeline` unit tests pass. In the DSH desktop app, real Claude sessions showed the folded rows and the result titles, and a fold opened to its calls. The end-to-end tests were changed but not run, because they need a separate `dsh web` instance.

### 2026-11-09: Version 0.3.0 and repository rules

- **What:** The version is 0.3.0. Both README files have a **What's new** section with an image. `AGENTS.md` now requires a version bump, a **What's new** entry and an image for a new feature, and it forbids sensitive data. The build removes the local folder from `lib/`.
- **Why:** Each version must explain what is new, and the repository must not hold private data.
- **Files:** `package.json`, `README.md`, `README.zh.md`, `AGENTS.md`, `docs/images/whats-new-0.3.0.png`, `scripts/strip-local-paths.mjs`.
- **Upstream merge risk:** Low.
- **Verified:** The build ran, and `lib/` has no local folder path. The image was checked for invented data only.

### 2026-11-09: Unread and branch indicators on session rows

- **What:** Claude and Codex rows show a blue dot when the session changed after you last opened it. Opening the row clears the dot. Rows show a purple icon when the branch of the session has a merged pull request, a green icon when it has an open pull request, and a gray icon when the branch has commits that the default branch does not have. Claude and Codex rows use the branch that the session recorded. DSH rows use the current branch of their folder and keep the DSH unread state. The list refreshes every 30 seconds while the app is visible.
- **Why:** The rows must show the same information as Claude and Codex. A pull request decides first because a squash merge leaves no shared commit. The public Codex repository has only the unread logic of its terminal picker and a merge-base helper, and T3 Code has the pull request states.
- **Files:** `src/branch-status.ts`, `src/index.ts`, `src/claude.ts`, `src/codex.ts`, `src/extras.ts`, `src/protocol.ts`, `src/client/RowIndicators.tsx`, `src/client/RowIndicators.module.css`, `src/client/index.ts`, `src/client/sessions.ts`, `src/client/locales.ts`, `tests/branch-status.test.mjs`.
- **Upstream merge risk:** Low. The indicators use the DSH `sidebar.session.row.trailing` slot, so `dsh-better-left-sidebar` needs no change.
- **Verified:** `branch-status` unit tests pass. The reader returned `merged`, `open`, `unmerged` and `none` for real branches and pull requests. In the DSH desktop app, a real row showed the unread dot. The branch icons were not seen in the app, because no listed session has a non-default branch that still exists.

### 2026-11-09: DeepSeek in the selector of an open chat

- **What:** The selector of an open Claude or Codex chat has the DeepSeek Harness rail, and its models show in Favorites. If you select a DeepSeek model, the next message starts a new DSH session in the same folder with that model. The host creates the session with `agents.create` and a seed of the conversation (`src/dsh-import.ts`), so the old messages show as native messages and the model receives them as history. The newest 400,000 characters are kept. If DSH refuses the seed, the first message carries the text instead. The old chat stays in the list. The switch goes one way, and tool calls, tool results, thinking and attachments do not move. Each catch-up line now names the provider that wrote the reply.
- **Why:** The user wants to continue a Claude or Codex chat on a DeepSeek model and see the old messages.
- **Files:** `src/dsh-import.ts`, `tests/dsh-import.test.mjs`, `src/index.ts`, `src/links.ts`, `src/protocol.ts`, `src/client/index.ts`, `src/client/ExternalPanel.tsx`, `src/client/transcript.ts`, `src/client/locales.ts`, `tests/fork.test.mjs`.
- **Upstream merge risk:** Medium. The seed follows the session format v4 event rules, which are pre-stable. A DSH update can make the seed invalid, and then the text fallback runs. An imported session also has no model-switch notice until the next app start.
- **Verified:** `dsh-import`, `fork` and `links` unit tests pass. In the DSH desktop app, a switched Codex and Claude chat moved to a DeepSeek Harness model, showed its old messages as native messages and answered from them. The session reopened after an app restart. A failed call restored the typed message and showed the error.

### 2026-11-09: Fork from the session row

- **What:** The row menu of a Claude or Codex session has **Fork session**. Claude uses the SDK `forkSession` and Codex uses `thread/fork`, and each instance forks in its own home folder. A fork of a conversation that switched provider forks every provider thread and makes a new link, so the fork keeps the merged transcript and can still switch. Claude and Codex can fork a running session: Codex uses its own interrupted snapshot, and Claude stops at the last completed turn. Codex does not list a fork before its first message, so the bridge saves such a fork in `unlistedForks` until Codex lists it. Pi still cannot fork a running session. DeepSeek Harness sessions keep the native DSH fork, which copies the latest completed-turn prefix.
- **Why:** The sidebar menu had no fork for Claude and Codex sessions.
- **Files:** `src/fork.ts`, `src/index.ts`, `src/claude.ts`, `src/extras.ts`, `src/protocol.ts`, `src/client/index.ts`, `src/client/transcript.ts`, `src/client/ExternalPanel.tsx`, `src/client/locales.ts`, `tests/fork.test.mjs`.
- **Upstream merge risk:** Low. The change adds one row menu item and replaces the fork case of the upstream manage route.
- **Verified:** `fork` unit tests pass. In the DSH desktop app, the **Fork** item of the session menu forked a Claude session, a running Claude session and a conversation that switched from Claude to Codex. The switched fork kept its merged transcript, stayed in the list after a restart and answered from the copied context. The right-click row item was not opened in the test, because the test tools could not open that menu.

### 2026-11-09: Add provider instances

- **What:** Settings → Agent Bridge has **+ Add provider**. A 3-step dialog (Provider, Identity, Config) adds a Claude or Codex instance with a label, an ID, an accent color, a binary path, a home folder and launch arguments. Each instance has its own login and sessions: Claude uses `CLAUDE_CONFIG_DIR` and Codex uses `CODEX_HOME`. The host makes the home folder when the instance is added, because Codex does not start if `CODEX_HOME` is missing. Each instance has a rail in the selector, its own models, reasoning levels and favorites, a login command and a **Remove this provider** button. A removal does not delete the home folder. The DeepSeek Harness models are a fixed row of the provider list, and that row has no remove button.
- **Why:** The user can use more than one Claude or Codex account, as in T3 Code.
- **Files:** `src/instances.ts`, `src/protocol.ts`, `src/index.ts`, `src/claude.ts`, `src/run.ts`, `src/codex.ts`, `src/extras.ts`, `src/links.ts`, `src/model-prefs.ts`, `src/client/AddProviderDialog.tsx`, `src/client/providers-store.ts`, `src/client/dsh-catalog-store.ts`, `src/client/ModelsSection.tsx`, `src/client/ProviderPicker.tsx`, `src/client/NewChat.tsx`, `src/client/ExternalPanel.tsx`, `src/client/locales.ts`, `tests/instances.test.mjs`.
- **Upstream merge risk:** Medium. The session ID format of an instance (`claude:@work:uuid`) touches the upstream ID parser in `src/index.ts`.
- **Verified:** `instances` unit tests pass. In the DSH desktop app, a Claude instance and a Codex instance were added and removed, the rail showed the instance models, and a session in the instance folder opened. A turn on the Claude instance used the instance folder and returned the sign-in error. A successful turn on a signed-in instance was not tested, because the test instances have no login.

### 2026-11-09: Correct sign-in status

- **What:** A Claude account report with `tokenSource: "none"` now shows **Not signed in**. Codex no longer shows **Not signed in**, because its account read returns no account even when it is signed in.
- **Why:** The provider list showed the wrong state for both engines.
- **Files:** `src/run.ts`, `src/client/ModelsSection.tsx`, `tests/instances.test.mjs`.
- **Upstream merge risk:** Low.
- **Verified:** `instances` unit tests pass. In the DSH desktop app, Codex showed **Available** and a Claude instance with no login showed **Not signed in**.

### 2026-11-09: Favorites tab in the provider list

- **What:** The provider list starts with a **Favorites** tab for all providers. It can reorder, unfavorite and disable models. A changed row stays until the tab opens again. The order of this tab is the order of the Favorites rail in the selector. The selector opens on the last rail that the user chose.
- **Why:** The user can manage favorites in one place and undo a change.
- **Files:** `src/model-prefs.ts`, `src/client/ModelsSection.tsx`, `src/client/ModelsSection.module.css`, `src/client/ProviderPicker.tsx`, `src/client/locales.ts`, `tests/model-prefs.test.mjs`.
- **Upstream merge risk:** Low.
- **Verified:** `model-prefs` unit tests pass. In the DSH desktop app, unfavorite, disable and reorder were checked, and a changed row stayed in the list.

### 2026-11-09: No new-session rows in the sidebar

- **What:** The Workspace browser no longer lists **+ New Claude session** and **+ New Codex session**. New chats start from the selector. The standalone "Claude / Codex" fallback page keeps these rows.
- **Why:** The selector replaces these rows.
- **Files:** `src/client/graft.tsx`, `tests/graft.test.mjs`.
- **Upstream merge risk:** Low.
- **Verified:** `graft` unit tests pass, and the rows were absent in the DSH desktop app.

### 2026-11-09: Reasoning level per model

- **What:** The selector saves the reasoning level of each model. A model pick restores the model's saved level, else keeps the current level if the model supports it, else uses Medium if the model supports it. The Reasoning column marks the saved level of the model under the pointer. Medium is also used when no level is saved, and it is sent with the message.
- **Why:** A model pick must not reset the selected level.
- **Files:** `src/model-prefs.ts`, `src/protocol.ts`, `src/client/NewChat.tsx`, `src/client/ExternalPanel.tsx`, `tests/model-prefs.test.mjs`.
- **Upstream merge risk:** Low.
- **Verified:** `model-prefs` and `model-names` unit tests pass. In the DSH desktop app, a model change kept the level and each Claude model restored its own level.

### 2026-11-09: Settings gear in the selector

- **What:** The selector footer has a gear to the left of **Standard / Fast**. The gear opens the Agent Bridge settings tab.
- **Why:** The user can reach the provider and model settings directly from the selector.
- **Files:** `src/client/ProviderPicker.tsx`, `src/client/ProviderPicker.module.css`, `src/client/NewChat.tsx`, `src/client/ExternalPanel.tsx`, `src/client/index.ts`, `src/client/locales.ts`.
- **Upstream merge risk:** Medium. The gear uses the store of the DSH `sidebar.settings` slot entry, which is not a published API. If the store is absent, the gear is not shown.
- **Verified:** In the DSH desktop app, the gear opened the Agent Bridge tab.

### 2026-11-09: Separate Permissions popup

- **What:** The access chip in the chat bar opens its own **Permissions** popup with an icon row and a description of each level. The selector footer keeps its access menu.
- **Why:** The user can see what a level does and change it without opening the model selector, as in T3 Code.
- **Files:** `src/client/PermissionPicker.tsx`, `src/client/ProviderPicker.tsx`, `src/client/ProviderPicker.module.css`, `src/client/NewChat.tsx`, `src/client/ExternalPanel.tsx`, `src/client/locales.ts`.
- **Upstream merge risk:** Low. `src/client/PermissionPicker.tsx` is the only upstream file with a large change.
- **Verified:** In the DSH desktop app, the popup, a level change and the Full access risk dialog were checked for a new Claude chat.

### 2026-11-09: Provider settings in Agent Bridge and chat-bar indicators

- **What:** The provider list and model settings moved from a separate settings tab into the Agent Bridge page. Each provider shows its version and status and has an on/off switch. The chat bar shows the provider icon, a Fast mark and the current access. DeepSeek's account and official providers come first in the selector, as in the native selector.
- **Why:** The settings belong with the plugin, as on the Providers page of T3 Code, and the chat bar must show the Fast and access choices.
- **Files:** `src/client/ModelsSection.tsx`, `src/client/ModelsSection.module.css`, `src/client/AboutSection.tsx`, `src/client/ProviderPicker.tsx`, `src/client/ProviderPicker.module.css`, `src/client/PermissionPicker.tsx`, `src/client/NewChat.tsx`, `src/client/ExternalPanel.tsx`, `src/client/index.ts`, `src/client/model-prefs-store.ts`, `src/client/locales.ts`, `src/model-prefs.ts`, `src/protocol.ts`, `tests/model-prefs.test.mjs`.
- **Upstream merge risk:** Low. `src/client/AboutSection.tsx` has one added panel.
- **Verified:** `model-prefs`, `model-names` and `links` unit tests pass. In the DSH desktop app, the Agent Bridge page, the provider on/off switch, the chat-bar access chip and the DeepSeek footer were checked. The Fast mark and the corrected DeepSeek access label were built but not checked in the app. Multiple instances of one provider are not implemented.

### 2026-11-09: Native new-session screen, Standard/Fast and access in the selector

- **What:** The DSH new-session screen stays native. The plugin no longer replaces the composer: it wraps `conversation.sendSession` and routes the send of a blank session to Claude or Codex when one of them is selected. The selector popup has a footer with **Standard / Fast** and the access control, and the model list scrolls. The access control is removed from the DSH composer row and from the Claude/Codex composer. Fast uses Claude's `fastMode` setting and the Codex service tier, and each provider reports which models support it.
- **Why:** The new-session screen must not change except for the selector. Access depends on the selected provider, so it belongs with the selector.
- **Files:** `src/client/NewChat.tsx`, `src/client/ProviderPicker.tsx`, `src/client/ProviderPicker.module.css`, `src/client/PermissionPicker.tsx`, `src/client/ComposerBar.tsx`, `src/client/ExternalPanel.tsx`, `src/client/index.ts`, `src/client/model-names.ts`, `src/client/transcript.ts`, `src/client/locales.ts`, `src/run.ts`, `src/codex.ts`, `src/index.ts`, `src/protocol.ts`, `tests/model-names.test.mjs`.
- **Upstream merge risk:** High for the `conversation.sendSession` wrap, which depends on a DSH method that is not a published extension point. If the method is absent, new chats stay with DSH and the plugin logs a warning.
- **Verified:** `model-names`, `model-prefs` and `links` unit tests pass. In the DSH desktop app, a Claude chat started from the native composer, the list scrolled, and a Codex turn with Fast wrote `service_tier: priority`. A real Claude turn with Fast was not run.

### 2026-11-08: One transcript across a provider switch

- **What:** The session route merges the linked Claude and Codex threads, in the order of the switches, and the chat shows a "Switched to" divider at each switch. The chat stays on screen while the merged transcript loads. Each switch now records its position in `ThreadLink.segments`. A link without segments shows the other thread first.
- **Why:** After a switch, the chat showed only the current provider's thread, so the earlier conversation disappeared from the UI.
- **Files:** `src/links.ts`, `src/index.ts`, `src/protocol.ts`, `src/client/transcript.ts`, `src/client/timeline.ts`, `src/client/ExternalPanel.tsx`, `src/client/ExternalPanel.module.css`, `src/client/locales.ts`, `tests/links.test.mjs`, `tests/timeline.test.mjs`.
- **Upstream merge risk:** Medium for the session route in `src/index.ts` and the message list in `src/client/ExternalPanel.tsx`.
- **Verified:** `links` and `timeline` unit tests pass. In the DSH desktop app, a real switch kept the earlier messages on screen and showed the divider.

### 2026-11-08: Model management for Claude and Codex

- **What:** The Agent Bridge settings page shows each provider's models. The user can reorder models, hide or show them, mark favorites, and add or remove custom model IDs. The selector follows these settings. Favorites moved from browser storage to the plugin state file.
- **Why:** A user must be able to keep only the needed models in the selector, as in T3 Code.
- **Files:** `src/model-prefs.ts`, `src/protocol.ts`, `src/extras.ts`, `src/index.ts`, `src/client/ModelsSection.tsx`, `src/client/ModelsSection.module.css`, `src/client/model-prefs-store.ts`, `src/client/model-names.ts`, `src/client/NewChat.tsx`, `src/client/ProviderPicker.tsx`, `src/client/ExternalPanel.tsx`, `src/client/index.ts`, `src/client/locales.ts`, `tests/model-prefs.test.mjs`.
- **Upstream merge risk:** Low. The change adds a route, a state field and a settings section.
- **Verified:** `model-prefs` unit tests pass. In the DSH desktop app, reorder, hide, add custom and the selector result were checked.

### 2026-11-08: Provider selector, new-chat start and Claude/Codex switch

- **What:** The DSH model seat is replaced by a selector with a provider rail, search, favorites and a reasoning column. If Claude or Codex is selected on a blank session, a plugin composer replaces the DSH composer and starts that provider's session. In an open Claude or Codex session, a provider change applies to the next message. That message goes to the other provider's thread, with a catch-up block that has only user and assistant text. Linked threads show as 1 sidebar row. The Standard/Fast control and the custom model entry are not in the selector. Claude rows show the full name from the model description, for example `Claude Opus 5.5`, and the Claude `Default` entry is not a row. If no model is picked, the selector marks the model that the engine uses.
- **Why:** A user must be able to start a chat with the needed provider from a new chat, and change provider without loss of the conversation context.
- **Files:** `src/links.ts`, `src/index.ts`, `src/extras.ts`, `src/protocol.ts`, `src/client/NewChat.tsx`, `src/client/ProviderPicker.tsx`, `src/client/ProviderPicker.module.css`, `src/client/model-names.ts`, `src/client/ExternalPanel.tsx`, `src/client/index.ts`, `src/client/transcript.ts`, `src/client/locales.ts`, `tests/links.test.mjs`.
- **Upstream merge risk:** Medium for `src/index.ts`, `src/client/ExternalPanel.tsx` and `src/client/transcript.ts`. High for the `conversation.input.model` and `conversation.composer` slots, because they are DSH preview APIs.
- **Verified:** The build succeeds against DSH 0.2.2-rc.1. `tsc` shows only the upstream `ExternalSessionSource` error. `links`, `model-names`, `graft`, `extras`, `session-reads` and `sessions` unit tests pass. In the DSH desktop app, the selector, the new-chat start and the switch in both directions were checked with real turns.
