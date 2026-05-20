# Pull Request Guidelines

Canonical reference: [d4rken-org/sdmaid-se `.claude/rules/commit-guidelines.md`](https://github.com/d4rken-org/sdmaid-se/blob/main/.claude/rules/commit-guidelines.md).
Follow the PR sections of that file unless contradicted below.

## Where octi-web Diverges

- **No module prefix.** sdmaid-se uses `<module>: <title>` for both commits and
  PR titles. octi-web uses flat imperative sentences (see
  [commit-guidelines.md](commit-guidelines.md)) — no `AppCleaner:` / `General:`
  / `Fix:` prefixes.
- **Commit vs PR title can still diverge**: the commit title is for `git log`
  readers (technical references allowed), the PR title is for the release
  notes reader (plain language, action-first).

## Pull Request Title

- Imperative, present tense, 50–60 chars, flat (no prefix).
- Action-first verb (`Add`, `Fix`, `Refactor`, `Bump`, `Use`, `Restructure`).
- ELI5 / user-facing where possible; reserve internal class/file names for the
  description or for commit titles.
- If the PR squashes to one commit, the PR title becomes the commit subject —
  pick wording that works as both.

## Pull Request Description

Two required sections, in this order.

### What changed

User-facing explanation of what the PR does. Describe the problem fixed or
the feature added from the user's perspective. **No internal class, file, or
function names.**

For non-user-facing PRs (refactors, CI, dependency bumps, internal docs):
write "No user-facing behavior change" followed by a brief internal note.

### Technical Context

What can't be extracted from the diff. Use bullets, keep it scannable, don't
restate file names or line-level changes. Cover:

- **Why** this approach was chosen (and alternatives considered/rejected).
- **Root cause** for bug fixes — the diff shows the fix, not what caused it.
- **Non-obvious side effects** or behavioural changes not visible from
  reading the code.
- **Review guidance** — what's tricky or deserves close attention.

### Test plan

Bullet checklist of how the change was verified. Examples:

- `pnpm check && pnpm test` pass locally
- `pnpm test:smoke` passes against `ghcr.io/d4rken-org/octi-server:latest`
- Manual: paired with an Android device on `prod.kserver.octi.darken.eu` and
  confirmed the new tile renders peer data

For wire-format changes, the plan **must** include a roundtrip with the
Android peer (or a recorded fixture from one).

## Labels

Before opening (or just after), run `gh label list` and attach **every** label
that fits the change. Triage dashboards key off labels; an unlabeled PR is
invisible to anyone scanning by area.

Octi Web's label vocabulary:

| Label | Apply when… |
|---|---|
| `documentation` | `.claude/`, `README`, rule files, inline JSDoc-only changes |
| `enhancement` | new user-visible feature or capability |
| `bug` | fixes incorrect behaviour |
| `Build/Deploy` | CI workflows, `Dockerfile`, `tools/release/`, release pipeline |
| `c: sync/octi` | touches the Octi-Server connector or wire protocol (`src/protocol/`, headers, encryption) |
| `c: sync` | broader sync changes that span connectors (rare on web today) |
| `c: module` | touches `src/modules/` generally |
| `c: module/<name>` | touches a specific module (`apps`, `clipboard`, `connectivity`, `files`, `meta`, `wifi`). Apply alongside `c: module` |
| `Translations` | string changes only |
| `needs help or infos` | blocked on user/maintainer input |

Apply more than one when the change spans areas (e.g. a new files-module
feature is `enhancement` + `c: module` + `c: module/files`).

```bash
gh pr create --label documentation               # at creation time
gh pr edit 10 --add-label documentation \        # post-creation
              --add-label Build/Deploy
```

## Conventions (from sdmaid-se)

- **Issue references** in the body: `Closes #123`, `Fixes #123`, or
  `Resolves #123`. For sister repositories use `Closes d4rken-org/octi#309`.
- **Breaking changes** to the wire format that older Android peers cannot
  read: prefix the PR title with `BREAKING:`. (Wire-compat is usually
  preserved via capability tags — see
  [device-capabilities.md](device-capabilities.md) — so this is rare.)
- **Co-authors**: append `Co-authored-by: Name <email>` trailers in the
  body, one per line. Don't add unless you actually paired.

## Sister-repo PRs

A wire-format or capability change usually spans repos
(`d4rken-org/octi`, `d4rken-org/octi-server`, `d4rken-org/octi-desktop`).
Link each matched PR in the description so review can verify end-to-end. The
canonical worked example is the Octi-Device-Capabilities trio — web commit
`5ff5fd7` ↔ `d4rken-org/octi#309` ↔ `d4rken-org/octi-server#23`.

## Draft vs Ready

Open as draft only while CI is still red and you intend to keep iterating;
flip to ready when you want review. Don't open as draft just to "show
progress" — it disables review-required gates and clutters the triage queue.
