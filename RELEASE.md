# Release procedure

## One-time setup (do once before the first release)

1. **Install the `d4rken-org-releaser` GitHub App** on the
   [`d4rken-org/octi-web`](https://github.com/d4rken-org/octi-web) repository.
2. **Add the App as a bypass actor** for both rulesets:
   - Settings → Rules → Rulesets → `main` → Bypass list → add the App.
   - Settings → Rules → Rulesets → `Release tags` → Bypass list → add the App.
3. **Verify org secret visibility**. The App secrets
   `RELEASE_APP_CLIENT_ID` + `RELEASE_APP_PRIVATE_KEY` are stored at the
   `d4rken-org` level. In Org Settings → Secrets and variables → Actions →
   Repository access, confirm `octi-web` can read them.
4. **Enable GitHub Pages**. Settings → Pages → Source = "GitHub Actions".
5. **Create the `web-production` environment**. Settings → Environments → New →
   `web-production`. Add yourself as a required reviewer. This is the gate that
   approves the bump commit + tag push.
6. **Point DNS for the custom domain**. The Pages deploy looks for the CNAME
   file in `public/CNAME` (`web.octi.darken.eu`). Configure your DNS provider
   to CNAME the subdomain at `d4rken-org.github.io`. Pages will issue a Let's
   Encrypt cert once the CNAME resolves.
7. **Refresh the smoke-test image digest** (optional, but recommended).
   `.github/workflows/code-checks.yml` pins the sync-server image by manifest
   digest. To update, run:
   ```bash
   docker buildx imagetools inspect ghcr.io/d4rken-org/octi-server:latest \
     | grep Digest
   ```
   and replace the digest in `code-checks.yml` (the `services.sync-server.image`
   line).

## Cutting a release

### First release ever

`package.json#version` ships as the placeholder `0.0.0`. `bump.sh` refuses to
bump from a placeholder — you must specify the initial version explicitly:

```
Actions → Release prepare → Run workflow
  bump_kind:        (ignored)
  version_type:     (ignored)
  version_override: 1.0.0-rc0
  dry_run:          true
```

Read the workflow run's summary. If the plan looks right, dispatch again with
`dry_run: false`. The `web-production` environment will prompt you to approve
before Job 2 actually commits and tags.

### Subsequent releases

```
Actions → Release prepare → Run workflow
  bump_kind:    build | patch | minor | major
  version_type: keep-current | rc | beta
  dry_run:      true   (always check the plan first)
```

The bump follows the same rules as the Android workflow:

- `build` increments the build counter.
- `patch` / `minor` / `major` zero everything to the right and reset build to 0.
- `version_type=keep-current` keeps the current channel (e.g. stays on `rc`);
  set `beta` or `rc` to switch.

After verifying the plan, re-dispatch with `dry_run: false` and approve in
`web-production` when prompted.

## What happens downstream

1. **`release-prepare.yml`** bumps `package.json`, commits `Release: <version>`,
   tags `v<version>`, atomic-pushes both to `main`. The App token bypasses the
   branch-protection + tag-creation rulesets.
2. The tag push fires **`release-tag.yml`** automatically. Its `validate-tag`
   job re-verifies the tag's format, lineage (must be reachable from `main`),
   and that `package.json#version` matches.
3. Three parallel publish jobs:
   - **`release-github`** — builds, packages `dist/` as `octi-web-<tag>.tar.gz`,
     creates a GitHub Release (pre-release flag for `-(rc|beta)*`, full release
     for suffix-free `vM.m.p`).
   - **`release-pages`** — builds, deploys to GitHub Pages
     (`web.octi.darken.eu`). Goes live within a few minutes of approval.
   - **`release-docker`** — builds multi-arch (`amd64` + `arm64`) Docker image,
     pushes to `ghcr.io/d4rken-org/octi-web:<tag>`. Suffix-free tags also push
     `:latest`.

## Rollback

| Stage reached | Steps |
|---|---|
| Bump on `main`, downstream not yet started | Delete the tag (`git push origin :refs/tags/v<bad>`), revert the bump commit, push |
| `release-github` ran but tarball is bad | `gh release delete v<bad> --yes --cleanup-tag` |
| `release-pages` deployed | Re-dispatch `pages.yml` from the previous good `main` commit, then revert+re-bump |
| `release-docker` pushed | Manual: `gh api -X DELETE /user/packages/container/octi-web/versions/<id>` or repush previous tag as `:latest` |

Tag pushes always trigger `release-tag.yml`; no manual recovery is needed for
"tag pushed but workflow didn't fire" in normal conditions.

## Why `web-production` gates Job 2 (and not just downstream)

The Android workflow's pattern intentionally lets Job 2 commit + tag without a
gate, on the rationale that the operator can cancel between Job 1 and Job 2.
Web's pipeline is gated earlier so a rejected approval leaves no public artifact
on `main`. The trade-off: one extra approval click; the bump commit + tag are
never created if you reject. See the inline comment in `release-prepare.yml`.
