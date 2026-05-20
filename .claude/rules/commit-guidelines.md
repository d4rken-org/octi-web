# Commit Message Guidelines

Octi Web follows the same flat, imperative commit style as the
[main Octi repository](https://github.com/d4rken-org/octi). One subject line
per commit, no Conventional Commits prefixes, no module scopes.

## Format

- Imperative mood, present tense ("Add feature" not "Added feature").
- First line: 50–60 characters max. Use the body for detail.
- No module / scope prefix — this project uses flat commit messages.
- Optionally add a blank line and a detailed description body (wrap at ~72
  cols). Use the body for **why**, not what.
- Use `gh pr create` or `pnpm`-style flat sentences; don't add trailers,
  signatures, or co-author attribution unless the user explicitly asks for them.

## Examples from History

```
Restructure README to differentiate official vs self-hosted use
Bump actions to Node 24-compatible SHAs
Use gh release create for atomic, immutable-release-compatible publish
Match required-check names against the actual GitHub check-run names
Declare encryption capabilities via Octi-Device-Capabilities header
Add foreground poll loop + UX polish (M7)
Add file upload, list, download (M6)
Source version string from package.json
Fix MetaInfo wire issues found during live E2E test
Fix POST account response field name (account, not accountID)
Add crypto layer: Tink keyset parser + AES-GCM-SIV payload
```

## Special Formats

- **Release commits**: `Release: {version}` — e.g. `Release: 0.1.0-rc1`. Cut
  by the `release-prepare.yml` workflow; do not hand-author.
- **Dependency upgrades**: `Upgrade {dep} from {old} to {new}` or
  `Bump {dep} to {version}`.
- **CI / tooling**: lead with the verb (`Use`, `Bump`, `Add`, `Match`,
  `Restructure`); reviewers shouldn't need to read the diff to know whether
  the change is risk-free infra or product behaviour.

## Pull Requests

- Title follows the same rules as the commit subject. If the PR squashes to
  one commit, the subject **is** the commit message.
- Body: 1–3 bullet `## Summary` + a `## Test plan` checklist. Keep it
  scannable; reviewers skim.
- Link any sister PRs in other repos (Android `octi`, `octi-server`,
  `octi-desktop`) so the wire-format change is reviewable end-to-end. See the
  `Declare encryption capabilities…` commit for an example.
- Open as draft only while CI is still red and you intend to keep iterating;
  flip to ready when you want review.
