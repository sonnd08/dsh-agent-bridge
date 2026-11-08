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

### 2026-11-09: DeepSeek in the selector of an open chat

- **What:** The selector of an open Claude or Codex chat has the DeepSeek Harness rail, and its models show in Favorites. If you select a DeepSeek model, the next message starts a new DSH session in the same folder with that model. The first message has the user and assistant text of the conversation as readable context. The old chat stays in the list. The switch goes one way, and tool calls, tool results and attachments do not move. Each catch-up line now names the provider that wrote the reply.
- **Why:** The user wants to continue a Claude or Codex chat on a DeepSeek model. DSH has no public API to import history, so the context goes in the first message.
- **Files:** `src/index.ts`, `src/links.ts`, `src/protocol.ts`, `src/client/index.ts`, `src/client/ExternalPanel.tsx`, `src/client/transcript.ts`, `src/client/locales.ts`, `tests/fork.test.mjs`.
- **Upstream merge risk:** Low. The switch uses the DSH client calls `sessions.create`, `remote.session.selectModel`, `remote.session.prompt` and `uiWorkspace.openSession`, which are pre-stable.
- **Verified:** `fork` and `links` unit tests pass. In the DSH desktop app, a switched Codex and Claude chat moved to `gpt-6.1-sol`, and the model answered from the copied context. A failed call restored the typed message and showed the error.

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
