#!/usr/bin/env bash
# Source of truth for version bumping. Used by release-prepare.yml and release-tag.yml.
# Mirrors the CLI of app-main/tools/release/bump.sh; differences:
#   - Reads/writes package.json#version (no separate VERSION file, no version.properties).
#   - No versionCode (web has no app-store gating).
#   - Version format: M.m.p-(rc|beta)N — same as Android.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bump.sh --mode=<check|plan|write> [options]

Modes:
  check   Validate package.json#version parses as M.m.p-(rc|beta)N. No mutation.
  plan    check + compute the new version per inputs. Print plan to stdout.
  write   plan + rewrite package.json#version, verify post-condition.

Options (for plan/write):
  --bump-kind=build|patch|minor|major   (default: build)
  --version-type=keep-current|rc|beta   (default: keep-current)
  --version-override=<M.m.p-(rc|beta)N> (overrides bump-kind/version-type)
  --expected-current=<M.m.p-(rc|beta)N> (fail if current package.json#version differs)
  --repo-root=<path>                    (default: current working directory)

Output (plan/write modes):
  Human-readable report on stderr; KEY=value pairs on stdout for parsing:
    current_name=...
    new_name=...
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

log() {
  echo "$*" >&2
}

# ----- argument parsing ----------------------------------------------------

mode=""
bump_kind="build"
version_type="keep-current"
version_override=""
expected_current=""
repo_root=""

for arg in "$@"; do
  case "$arg" in
    --mode=*)              mode="${arg#*=}" ;;
    --bump-kind=*)         bump_kind="${arg#*=}" ;;
    --version-type=*)      version_type="${arg#*=}" ;;
    --version-override=*)  version_override="${arg#*=}" ;;
    --expected-current=*)  expected_current="${arg#*=}" ;;
    --repo-root=*)         repo_root="${arg#*=}" ;;
    -h|--help)             usage; exit 0 ;;
    *)                     die "unknown argument: $arg" ;;
  esac
done

case "$mode" in
  check|plan|write) ;;
  "") usage >&2; exit 2 ;;
  *)  die "invalid --mode: $mode (expected check|plan|write)" ;;
esac

case "$bump_kind" in
  build|patch|minor|major) ;;
  *) die "invalid --bump-kind: $bump_kind" ;;
esac

case "$version_type" in
  keep-current|rc|beta) ;;
  *) die "invalid --version-type: $version_type" ;;
esac

if [[ -z "$repo_root" ]]; then
  repo_root="$(pwd)"
fi

if [[ ! -d "$repo_root" ]]; then
  die "repo root does not exist: $repo_root"
fi

pkg_file="$repo_root/package.json"
[[ -f "$pkg_file" ]] || die "package.json not found at: $pkg_file"

# ----- helpers -------------------------------------------------------------

# Strict semver-ish parser: M.m.p-(rc|beta)N. All numeric fields non-negative
# integers without leading zeros (except a single "0").
VERSION_RE='^([0-9]+)\.([0-9]+)\.([0-9]+)-(rc|beta)([0-9]+)$'
PLACEHOLDER_RE='^0\.0\.0$'

read_current_version() {
  node -e 'const p=require("./package.json"); process.stdout.write(p.version);' \
    --eval-stdin 2>/dev/null || node -e "const p=require('$pkg_file'); process.stdout.write(p.version);"
}

parse_version() {
  # Sets globals: PARSED_MAJOR PARSED_MINOR PARSED_PATCH PARSED_TYPE PARSED_BUILD
  local v="$1"
  if [[ "$v" =~ $VERSION_RE ]]; then
    PARSED_MAJOR="${BASH_REMATCH[1]}"
    PARSED_MINOR="${BASH_REMATCH[2]}"
    PARSED_PATCH="${BASH_REMATCH[3]}"
    PARSED_TYPE="${BASH_REMATCH[4]}"
    PARSED_BUILD="${BASH_REMATCH[5]}"
  elif [[ "$v" =~ $PLACEHOLDER_RE ]]; then
    # Placeholder 0.0.0 — never published, only seen pre-first-release.
    PARSED_MAJOR=0; PARSED_MINOR=0; PARSED_PATCH=0
    PARSED_TYPE="placeholder"; PARSED_BUILD=0
  else
    die "version '$v' does not match M.m.p-(rc|beta)N (or 0.0.0 placeholder)"
  fi
}

write_version() {
  local new="$1"
  # In-place rewrite via node — keeps formatting / key order stable beyond
  # `version`, which `JSON.stringify` round-trips faithfully when fed an
  # already-parsed object.
  node -e "
    const fs = require('fs');
    const path = '$pkg_file';
    const txt = fs.readFileSync(path, 'utf8');
    const obj = JSON.parse(txt);
    obj.version = '$new';
    // Preserve trailing newline if present.
    const trailing = txt.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(path, JSON.stringify(obj, null, 2) + trailing);
  "
}

# ----- modes ---------------------------------------------------------------

current=$(read_current_version)
parse_version "$current"
current_major=$PARSED_MAJOR
current_minor=$PARSED_MINOR
current_patch=$PARSED_PATCH
current_type=$PARSED_TYPE
current_build=$PARSED_BUILD

if [[ -n "$expected_current" && "$expected_current" != "$current" ]]; then
  die "expected current version '$expected_current' but package.json has '$current'"
fi

if [[ "$mode" == "check" ]]; then
  echo "current_name=$current"
  exit 0
fi

# plan or write — compute the new version.
new_name=""
if [[ -n "$version_override" ]]; then
  # Validate override format.
  parse_version "$version_override"
  if [[ "$PARSED_TYPE" == "placeholder" ]]; then
    die "version-override cannot be the placeholder 0.0.0"
  fi
  new_name="$version_override"
else
  if [[ "$current_type" == "placeholder" ]]; then
    die "cannot bump from placeholder 0.0.0 — pass --version-override=<M.m.p-(rc|beta)N> for the first release"
  fi
  if [[ "$version_type" == "keep-current" ]]; then
    new_type="$current_type"
  else
    new_type="$version_type"
  fi
  case "$bump_kind" in
    build)
      new_major=$current_major
      new_minor=$current_minor
      new_patch=$current_patch
      new_build=$((current_build + 1))
      ;;
    patch)
      new_major=$current_major
      new_minor=$current_minor
      new_patch=$((current_patch + 1))
      new_build=0
      ;;
    minor)
      new_major=$current_major
      new_minor=$((current_minor + 1))
      new_patch=0
      new_build=0
      ;;
    major)
      new_major=$((current_major + 1))
      new_minor=0
      new_patch=0
      new_build=0
      ;;
  esac
  new_name="${new_major}.${new_minor}.${new_patch}-${new_type}${new_build}"
fi

log "Plan: $current → $new_name"
echo "current_name=$current"
echo "new_name=$new_name"

if [[ "$mode" == "plan" ]]; then
  exit 0
fi

# write mode — rewrite package.json and verify.
write_version "$new_name"
post=$(read_current_version)
if [[ "$post" != "$new_name" ]]; then
  die "post-write verification failed: package.json now reports '$post', expected '$new_name'"
fi
log "Wrote: package.json#version = $new_name"
