#!/bin/zsh

set -euo pipefail

fail() {
  print -u2 -- "$1"
  exit 1
}

if [[ "$#" -eq 5 && "$1" == "--" ]]; then
  shift
fi

if [[ "$#" -ne 4 || "$4" != "--confirm-replace" ]]; then
  fail "explicit --confirm-replace approval is required: safe-install-macos-bundle.zsh SOURCE_BUNDLE TARGET_BUNDLE EXPECTED_NODE_PTY_VERSION --confirm-replace"
fi

source_bundle="$1"
target_bundle="$2"
expected_node_pty_version="$3"
staging_bundle="${target_bundle}.bb-install-stage"
backup_bundle="${target_bundle}.bb-install-backup"
failed_bundle="${target_bundle}.bb-install-failed"
lock_directory="${target_bundle}.bb-install-lock"
lock_acquired=0
staging_created=0
rollback_required=0

node_pty_package_path() {
  print -r -- "$1/Contents/Resources/app.asar.unpacked/node_modules/node-pty/package.json"
}

verify_bundle() {
  local bundle="$1"
  local executable="$bundle/Contents/MacOS/bb"
  local package_path
  local installed_version
  package_path="$(node_pty_package_path "$bundle")"

  [[ -d "$bundle" ]] || fail "bundle does not exist: $bundle"
  [[ ! -L "$bundle" ]] || fail "bundle must not be a symbolic link: $bundle"
  [[ -x "$executable" ]] || fail "bundle executable is missing: $executable"
  [[ -f "$package_path" ]] || fail "node-pty package metadata is missing: $package_path"
  /usr/bin/codesign --verify --deep --strict "$bundle"
  installed_version="$(/usr/bin/plutil -extract version raw "$package_path")"
  [[ "$installed_version" == "$expected_node_pty_version" ]] || fail "node-pty version mismatch in $bundle: expected $expected_node_pty_version, found $installed_version"
}

cleanup() {
  local exit_status="$?"
  local recovery_failed=0
  trap - EXIT

  if [[ "$rollback_required" -eq 1 ]]; then
    if [[ -e "$target_bundle" ]]; then
      if ! /bin/mv "$target_bundle" "$failed_bundle"; then
        print -u2 -- "recovery failed to retain the rejected bundle: $target_bundle -> $failed_bundle"
        recovery_failed=1
      fi
    fi
    if [[ ! -e "$backup_bundle" ]]; then
      print -u2 -- "recovery failed because the rollback bundle is missing: $backup_bundle"
      recovery_failed=1
    elif [[ -e "$target_bundle" ]]; then
      print -u2 -- "recovery could not restore $backup_bundle because the target still exists: $target_bundle"
      recovery_failed=1
    elif ! /bin/mv "$backup_bundle" "$target_bundle"; then
      print -u2 -- "recovery failed to restore the rollback bundle: $backup_bundle -> $target_bundle"
      recovery_failed=1
    fi
  elif [[ "$staging_created" -eq 1 && -e "$staging_bundle" ]]; then
    if ! /bin/mv "$staging_bundle" "$failed_bundle"; then
      print -u2 -- "recovery failed to retain the rejected staging bundle: $staging_bundle -> $failed_bundle"
      recovery_failed=1
    fi
  fi

  if [[ "$lock_acquired" -eq 1 ]]; then
    if ! /bin/rmdir "$lock_directory"; then
      print -u2 -- "recovery failed to release the install lock: $lock_directory"
      recovery_failed=1
    fi
  fi

  if [[ "$recovery_failed" -eq 1 ]]; then
    print -u2 -- "recovery incomplete: target=$target_bundle backup=$backup_bundle failed=$failed_bundle stage=$staging_bundle lock=$lock_directory"
  fi

  exit "$exit_status"
}

[[ "$(uname -s)" == "Darwin" ]] || fail "this installer supports macOS only"
[[ "$source_bundle" == /* ]] || fail "source bundle path must be absolute"
[[ "$target_bundle" == /* ]] || fail "target bundle path must be absolute"
[[ "$source_bundle" == *.app ]] || fail "source bundle path must end in .app"
[[ "$target_bundle" == *.app ]] || fail "target bundle path must end in .app"
[[ -n "$expected_node_pty_version" ]] || fail "expected node-pty version must not be empty"
[[ -d "$target_bundle" ]] || fail "target bundle does not exist: $target_bundle"
[[ ! -L "$target_bundle" ]] || fail "target bundle must not be a symbolic link: $target_bundle"
canonical_source_bundle="${source_bundle:A}"
canonical_target_bundle="${target_bundle:A}"
[[ "$canonical_source_bundle" != "$canonical_target_bundle" ]] || fail "source and target bundles must differ"
open_file_prefix="n${canonical_target_bundle}/"

if ! /bin/mkdir "$lock_directory" 2>/dev/null; then
  fail "another install attempt holds: $lock_directory"
fi
lock_acquired=1
trap cleanup EXIT

[[ ! -e "$staging_bundle" && ! -L "$staging_bundle" ]] || fail "staging bundle already exists: $staging_bundle"
[[ ! -e "$backup_bundle" && ! -L "$backup_bundle" ]] || fail "rollback bundle already exists: $backup_bundle"
[[ ! -e "$failed_bundle" && ! -L "$failed_bundle" ]] || fail "failed-install bundle already exists: $failed_bundle"

if ! open_files="$(/usr/sbin/lsof -Fn)"; then
  fail "could not inspect active file handles before replacing the target bundle"
fi
if [[ "$open_files" == "${open_file_prefix}"* || "$open_files" == *$'\n'"${open_file_prefix}"* ]]; then
  fail "target bundle is running; refusing to replace it: $target_bundle"
fi

verify_bundle "$source_bundle"
if ! /usr/bin/codesign --verify --deep --strict "$target_bundle"; then
  print -u2 -- "warning: existing target signature is invalid; preserving it as the rollback bundle"
fi

/usr/bin/ditto "$source_bundle" "$staging_bundle"
staging_created=1
verify_bundle "$staging_bundle"

/bin/mv "$target_bundle" "$backup_bundle"
rollback_required=1
/bin/mv "$staging_bundle" "$target_bundle"
staging_created=0
if [[ "${BB_SAFE_INSTALL_TEST_FAIL_AFTER_PROMOTION:-}" == "1" ]]; then
  fail "injected post-promotion verification failure"
fi
verify_bundle "$target_bundle"
rollback_required=0

/bin/rmdir "$lock_directory"
lock_acquired=0
trap - EXIT

print -r -- "installed_bundle=$target_bundle"
print -r -- "rollback_bundle=$backup_bundle"
print -r -- "node_pty_version=$expected_node_pty_version"
