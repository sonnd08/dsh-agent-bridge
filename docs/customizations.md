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

### 2026-11-08: One transcript across a provider switch

- **What:** The session route merges the linked Claude and Codex threads, in the order of the switches, and the chat shows a "Switched to" divider at each switch. The chat stays on screen while the merged transcript loads. Each switch now records its position in `ThreadLink.segments`. A link without segments shows the other thread first.
- **Why:** After a switch, the chat showed only the current provider's thread, so the earlier conversation disappeared from the UI.
- **Files:** `src/links.ts`, `src/index.ts`, `src/protocol.ts`, `src/client/transcript.ts`, `src/client/timeline.ts`, `src/client/ExternalPanel.tsx`, `src/client/ExternalPanel.module.css`, `src/client/locales.ts`, `tests/links.test.mjs`, `tests/timeline.test.mjs`.
- **Upstream merge risk:** Medium for the session route in `src/index.ts` and the message list in `src/client/ExternalPanel.tsx`.
- **Verified:** `links` and `timeline` unit tests pass. In the DSH desktop app, a real switch kept the earlier messages on screen and showed the divider.

### 2026-11-08: Model management for Claude and Codex

- **What:** A new **Agent models** settings page shows each provider's models. The user can reorder models, hide or show them, mark favorites, and add or remove custom model IDs. The selector follows these settings. Favorites moved from browser storage to the plugin state file.
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
