# AGENTS.md

This repository is `sonnd08/dsh-agent-bridge`, a customized copy of `wiiwings1988/dsh-agent-bridge`. The plugin shows Claude Code, Codex and Pi sessions inside DeepSeek Harness (DSH).

## Record every customization

Add an entry to [docs/customizations.md](docs/customizations.md) for each change that adds or changes behavior, UI, configuration or dependencies.

1. Add the entry at the top of the **Log** section.
2. Use the entry template in that file.
3. Put the entry in the same commit as the change.
4. If a change needs a long explanation, write it in `docs/<topic>.md`. Then link that file from the entry.

Do not record typo fixes or changes that do not change behavior.

## Remotes

| Remote | Repository | Use |
| --- | --- | --- |
| `origin` | `sonnd08/dsh-agent-bridge` | Push all work here |
| `upstream` | `wiiwings1988/dsh-agent-bridge` | Fetch new releases only |

Do not push to `upstream`.

To get a new upstream release:

1. Run `git fetch upstream --tags`.
2. Merge the upstream release into `main`.
3. Read the **Log** section and make sure that each customization still operates.
4. Update the **Upstream baseline** section in `docs/customizations.md`.

## Build and test

The build needs a DSH source checkout. This repository must be 3 folder levels below the checkout root, for example `dsh/local/plugins/dsh-agent-bridge`. See the **Development** section of `README.md` for the setup.

| Task | Command |
| --- | --- |
| Type check | `pnpm run typecheck` |
| Build | `pnpm run build` |
| Unit test (one file) | `node --import tsx/esm --test tests/graft.test.mjs` |
| Install the working copy | `dsh plugin --profile desktop add link:$PWD` |
| Install from GitHub | `dsh plugin --profile desktop add github:sonnd08/dsh-agent-bridge` |

The end-to-end tests are `tests/e2e*.mjs`. They need a running `dsh web` instance. Set `DEV_BASE` to its URL and `DEV_HOME` to its `DSH_HOME`.

## Rules for changes

- `lib/` is committed, and an install from GitHub does no build. Rebuild `lib/` before you commit source changes.
- If a change adds UI text, add the text to both the `zh` and `en` dictionaries in `src/client/locales.ts`.
- If a change is visible to users, update both `README.md` and `README.zh.md`.
- Bump `version` in `package.json` in each pull request to `main`. Use a minor bump for a new feature and a patch bump for a fix.
- For each version, add an entry at the top of **What's new** in both README files. Explain what changed for the user.
- If a version adds a feature, add an image to `docs/images/` and show it in that entry. Name the image `whats-new-<version>.png`.
- If a change adds a setting, add it to the **Configuration** section of both README files.
- Keep the `LICENSE` file. The MIT license requires this notice in all copies.

## Sensitive data

Do not put sensitive data in this repository. This rule applies to source, `lib/`, tests, docs, images, commit messages and pull request text.

- Do not add credentials, API keys, tokens, cookies, `.env` files or SSH keys.
- Do not add personal data, such as email addresses, or local folder paths, such as your home folder.
- Do not add private code or data from an employer or a customer. Do not add internal hostnames, internal model routes or project names.
- Do not add session transcripts or screenshots of real sessions. Make images with invented data.
- `pnpm run build` removes the local folder from `lib/`. Do not edit the build to keep it.
- Before you commit, read the staged diff, and search it for your home folder path and for key patterns.

## Main entry points

| Path | Function |
| --- | --- |
| `src/index.ts` | Host plugin, settings schema and session list |
| `src/client/index.ts` | Client plugin and UI slot registration |
| `src/client/graft.tsx` | Merges external sessions into the DSH Workspace browser |
| `src/client/ExternalPanel.tsx` | Session panel in the main column |
| `src/client/locales.ts` | UI text in `zh` and `en` |
| `tests/` | Unit tests, end-to-end tests and stand-in executables |
| `docs/images/` | Images for the README files, with invented data only |
| `scripts/strip-local-paths.mjs` | Removes the local folder from the built bundles |
