# Release

Releases are cut via the **Release prepare** workflow
(`.github/workflows/release-prepare.yml`). It bumps `package.json#version`,
commits to `main`, tags `v<version>`, and pushes the commit + tag
atomically. The App-token push fires `on: push:` in `release-tag.yml`, which
runs `validate-tag` and then in parallel: builds + uploads the GitHub release
tarball, deploys to GitHub Pages, and publishes a multi-arch Docker image to
`ghcr.io/d4rken-org/octi-web`.

Web's flow is ported from `app-main/.claude/rules/release.md`. Key
differences:

- Source-of-truth is `package.json#version` (single file; no
  `version.properties` + `VERSION` pair).
- No `versionCode` — there's no app-store monotonicity gate.
- Job 2 ("Push and dispatch") is gated by the `web-production` GitHub
  Environment, so the operator approves **before** the tag is pushed. (The
  Android workflow uses the "cancel between Job 1 and Job 2" pattern; web
  flipped to an explicit env approval because there's no human gate
  downstream.)

## Dispatch

```bash
# Plan only — no commit, no tag, no push.
gh workflow run release-prepare.yml -f bump_kind=build -f dry_run=true

# Real cut — pauses on the `web-production` environment approval.
gh workflow run release-prepare.yml -f bump_kind=build -f dry_run=false
```

After `dry_run=false`: Job 1 ("Compute and validate") writes the plan summary,
then Job 2 ("Push and dispatch") pauses for the `web-production` env
approval. Review the plan summary, approve, and Job 2 commits/tags/pushes
atomically. The tag push triggers `release-tag.yml`.

Job 1 refuses to bump if `main` has failing checks. It also belt-and-braces
asserts the five required `code-checks.yml` jobs (`Type check`, `Unit tests`,
`Production build`, `Smoke (real sync-server)`, `Release tooling`) all
report success on the head commit — so a commit that skipped CI can't sneak
through.

**Do NOT dispatch `release-prepare.yml` while a previous tag's downstream
jobs are still pending** unless you're sure they target a different tag —
per-tag concurrency in `release-tag.yml` only blocks duplicate runs of the
same tag.

## Inputs

| Input | Default | Notes |
|---|---|---|
| `bump_kind` | `build` | `build` \| `patch` \| `minor` \| `major` |
| `version_type` | `keep-current` | Preserves current `rc`/`beta`. Set explicitly to switch. |
| `version_override` | empty | e.g. `1.0.0-rc0`. Bypasses bump_kind/version_type. **Required for the first release** (no prior version to bump from). |
| `expected_current` | empty | Optional: fail if `package.json#version` ≠ this. Useful for tight coordination. |
| `dry_run` | `true` | Default is plan-only. |

Bump rules: `build` increments the build counter; `patch`/`minor`/`major`
zero everything to the right of the bumped field. All numeric fields bounded
`0..99`.

## Local

```bash
./tools/release/bump.sh --mode=plan --bump-kind=build --version-type=keep-current
./tools/release/bump.sh --mode=check
bats tools/release/bump.bats
```

`bats` + `shellcheck` are run in CI under the `Release tooling` job to keep
the bump script honest. Don't edit `bump.sh` without updating `bump.bats`.

## Channel Mapping

| Tag suffix | GitHub release | Docker `:latest`? | Pages deploy |
|---|---|---|---|
| `-beta*` | pre-release | no | yes |
| `-rc*`   | pre-release | no | yes |
| no suffix (`vM.m.p`) | full release (`--latest`) | yes | yes |

Today `bump.sh` only ever emits suffixed versions (`-rc` / `-beta`); the
suffix-free path is forward-compat for the eventual `1.0.0` stable cut.

## Rollback

| Stage reached | Steps |
|---|---|
| Bump on `main`, downstream not started | `git push origin :refs/tags/v<bad>`, `git revert <bump-sha>`, push |
| GitHub release created | Above + `gh release delete v<bad> --yes --cleanup-tag` |
| Docker image published | Above + delete the bad tag in `ghcr.io/d4rken-org/octi-web`'s package settings (it's still mutable until something tags `:latest` against it) |
| Pages already deployed | Roll forward — re-cut a new version. Pages does not retain history meaningfully. |

## Auth Setup

`release-prepare.yml` Job 2 uses a GitHub App token (not `GITHUB_TOKEN`) to
push the bump commit + tag past branch protection. Required org secrets,
shared with the Android repo:

- `RELEASE_APP_CLIENT_ID`
- `RELEASE_APP_PRIVATE_KEY`

The `d4rken-org-releaser` App is installed on this repo and added as a
bypass actor on the main-branch ruleset (PR/status check requirements) and
the tag-creation ruleset (`v*`). See `app-main/.claude/rules/release.md` for
the original setup notes — same App, same secrets.

## Defense in Depth

`release-tag.yml`'s `validate-tag` job:

1. regex-checks `github.ref_name` against `vM.m.p` or `vM.m.p-(rc|beta)N`,
2. verifies the tag commit is reachable from `origin/main`,
3. runs `bump.sh --mode=check`,
4. asserts the parsed name matches the tag.

Hand-pushed tags from feature branches or with a mismatched `package.json`
fail before any build runs.
