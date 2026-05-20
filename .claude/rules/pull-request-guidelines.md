# Pull Request Guidelines

Commit titles and PR titles serve different readers: commits speak to
developers reading `git log` (technical references allowed); PR titles speak
to release-notes readers (plain language, action-first). Treat them as
separate writing tasks even when the PR squashes to one commit.

## Pull Request Title

- Imperative mood, present tense, 50–60 characters, no prefix.
- Action-first verb (`Add`, `Fix`, `Refactor`, `Bump`, `Use`, `Restructure`).
- ELI5 / user-facing where possible — describe the change from a user's
  perspective, not as an implementation detail. Internal class, file, or
  function names belong in commit titles or the PR description, not here.
- If the PR squashes to one commit, the PR title becomes the commit subject:
  pick wording that works for both audiences.

## Pull Request Description

Three required sections, in this order. Use Markdown headings exactly as
shown so the triage scripts and templates pick them up.

### What changed

User-facing explanation of what the PR does. Describe the problem fixed or
the feature added from the user's perspective. **No internal class, file, or
function names.**

For non-user-facing PRs (refactors, CI, dependency bumps, internal docs):
write `No user-facing behavior change.` and then a brief sentence describing
the internal change.

### Technical Context

What can't be extracted from the diff. Use bullets, keep it scannable,
don't restate file names or line-level changes. Cover:

- **Why** this approach was chosen — and which alternatives were considered
  or rejected.
- **Root cause** for bug fixes. The diff shows the fix, not what caused it.
- **Non-obvious side effects** or behavioural changes not apparent from
  reading the code.
- **Review guidance** — what's tricky or deserves close attention.

### Test plan

Bullet checklist of how the change was verified. Examples:

- `pnpm check && pnpm test` pass locally
- `pnpm test:smoke` passes against `ghcr.io/d4rken-org/octi-server:latest`
- Manual: paired with an Android device on `prod.kserver.octi.darken.eu`
  and confirmed the new tile renders peer data

For wire-format changes, the plan **must** include a roundtrip with an
Android (or desktop) peer, or a recorded fixture from one.

## Example

```markdown
## What changed

Fixed a crash that could happen when opening the dashboard immediately after
linking a new device on a flaky connection.

## Technical Context

- Root cause: `listDevices()` returned before the encrypted-keyset payload
  was persisted, so the first poll tick read a half-written record and threw
  on decode.
- Chose to await the IndexedDB transaction's `done` promise before flipping
  the bootstrapping flag, over adding a retry — retry would mask future
  ordering bugs in the same path.
- Side effect: the onboarding spinner stays visible ~30ms longer on slow
  storage. Not perceptible in manual testing.

## Test plan

- [ ] `pnpm check && pnpm test` green
- [ ] Manual: simulate slow IndexedDB via DevTools throttling and confirm
      dashboard mounts without throwing
```

## Labels

Before opening (or just after), run `gh label list` and attach **every**
label that fits the change. Triage dashboards key off labels; an unlabeled
PR is invisible to anyone scanning by area.

Octi Web's label vocabulary:

| Label | Apply when… |
|---|---|
| `documentation` | `.claude/`, `README`, rule files, inline JSDoc-only changes |
| `enhancement` | new user-visible feature or capability |
| `bug` | fixes incorrect behaviour |
| `Build/Deploy` | CI workflows, `Dockerfile`, `tools/release/`, release pipeline |
| `c: sync/octi` | touches the Octi-Server connector or wire protocol (`src/protocol/`, headers, encryption) |
| `c: sync` | broader sync changes that span connectors |
| `c: module` | touches `src/modules/` generally |
| `c: module/<name>` | touches a specific module (`apps`, `clipboard`, `connectivity`, `files`, `meta`, `wifi`). Apply alongside `c: module` |
| `Translations` | string changes only |
| `needs help or infos` | blocked on user/maintainer input |

Apply more than one when the change spans areas (e.g. a new files-module
feature is `enhancement` + `c: module` + `c: module/files`).

```bash
gh pr create --label documentation               # at creation time
gh pr edit 11 --add-label documentation \        # post-creation
              --add-label Build/Deploy
```

## Conventions

- **Issue references** in the body: `Closes #123`, `Fixes #123`, or
  `Resolves #123`. For sister repositories use the qualified form,
  e.g. `Closes d4rken-org/octi#309`.
- **Breaking changes** to the wire format that older Android peers can't
  read: prefix the PR title with `BREAKING:`. Wire-compat is usually
  preserved via capability tags — see
  [device-capabilities.md](device-capabilities.md) — so this is rare.
- **Co-authors**: append `Co-authored-by: Name <email>` trailers at the
  bottom of the PR body, one per line. Don't add unless you actually paired.

## Sister-repo PRs

A wire-format or capability change usually spans repos
(`d4rken-org/octi`, `d4rken-org/octi-server`, `d4rken-org/octi-desktop`).
Link each matched PR in the description so review can verify end-to-end.
The canonical worked example is the Octi-Device-Capabilities trio — web
commit `5ff5fd7` ↔ `d4rken-org/octi#309` ↔ `d4rken-org/octi-server#23`.

## Draft vs Ready

Open as draft only while CI is still red and you intend to keep iterating;
flip to ready when you want review. Don't open as draft just to "show
progress" — it disables review-required gates and clutters the triage queue.
