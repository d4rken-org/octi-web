#!/usr/bin/env bats
# Unit tests for tools/release/bump.sh, run by the CI release-tooling job.
# Each test sets up a temporary repo with a fake package.json.

setup() {
  TMP_REPO="$(mktemp -d)"
  cat > "${TMP_REPO}/package.json" <<EOF
{
  "name": "octi-web-fixture",
  "version": "1.2.3-rc4",
  "private": true
}
EOF
  SCRIPT="${BATS_TEST_DIRNAME}/bump.sh"
}

teardown() {
  rm -rf "${TMP_REPO}"
}

write_version() {
  local v="$1"
  cat > "${TMP_REPO}/package.json" <<EOF
{
  "name": "octi-web-fixture",
  "version": "$v",
  "private": true
}
EOF
}

read_version() {
  node -e "process.stdout.write(require('${TMP_REPO}/package.json').version);"
}

@test "check mode prints current_name" {
  run bash "$SCRIPT" --mode=check --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"current_name=1.2.3-rc4"* ]]
}

@test "plan bump=build increments build counter" {
  run bash "$SCRIPT" --mode=plan --bump-kind=build --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new_name=1.2.3-rc5"* ]]
}

@test "plan bump=patch zeroes build, increments patch" {
  run bash "$SCRIPT" --mode=plan --bump-kind=patch --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new_name=1.2.4-rc0"* ]]
}

@test "plan bump=minor zeroes patch + build, increments minor" {
  run bash "$SCRIPT" --mode=plan --bump-kind=minor --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new_name=1.3.0-rc0"* ]]
}

@test "plan bump=major zeroes everything below major" {
  run bash "$SCRIPT" --mode=plan --bump-kind=major --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new_name=2.0.0-rc0"* ]]
}

@test "version-type=beta switches channel" {
  run bash "$SCRIPT" --mode=plan --bump-kind=build --version-type=beta --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new_name=1.2.3-beta5"* ]]
}

@test "version-override bypasses bump-kind" {
  run bash "$SCRIPT" --mode=plan --version-override=2.5.0-beta0 --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new_name=2.5.0-beta0"* ]]
}

@test "version-override rejects invalid format" {
  run bash "$SCRIPT" --mode=plan --version-override=1.0.0 --repo-root="$TMP_REPO"
  [ "$status" -ne 0 ]
}

@test "expected-current mismatch fails" {
  run bash "$SCRIPT" --mode=plan --bump-kind=build --expected-current=9.9.9-rc9 --repo-root="$TMP_REPO"
  [ "$status" -ne 0 ]
  [[ "$output" == *"expected current"* ]]
}

@test "expected-current match succeeds" {
  run bash "$SCRIPT" --mode=plan --bump-kind=build --expected-current=1.2.3-rc4 --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
}

@test "placeholder 0.0.0 refuses bump without override" {
  write_version "0.0.0"
  run bash "$SCRIPT" --mode=plan --bump-kind=build --repo-root="$TMP_REPO"
  [ "$status" -ne 0 ]
  [[ "$output" == *"placeholder"* ]]
}

@test "placeholder 0.0.0 accepts version-override for first release" {
  write_version "0.0.0"
  run bash "$SCRIPT" --mode=plan --version-override=1.0.0-rc0 --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new_name=1.0.0-rc0"* ]]
}

@test "write mode persists the new version to package.json" {
  run bash "$SCRIPT" --mode=write --bump-kind=build --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  [ "$(read_version)" = "1.2.3-rc5" ]
}

@test "write mode preserves other package.json fields" {
  run bash "$SCRIPT" --mode=write --bump-kind=patch --repo-root="$TMP_REPO"
  [ "$status" -eq 0 ]
  name=$(node -e "process.stdout.write(require('${TMP_REPO}/package.json').name);")
  [ "$name" = "octi-web-fixture" ]
}

@test "garbage version in package.json fails check" {
  write_version "not-a-version"
  run bash "$SCRIPT" --mode=check --repo-root="$TMP_REPO"
  [ "$status" -ne 0 ]
}

@test "bad bump-kind argument fails fast" {
  run bash "$SCRIPT" --mode=plan --bump-kind=floof --repo-root="$TMP_REPO"
  [ "$status" -ne 0 ]
}
