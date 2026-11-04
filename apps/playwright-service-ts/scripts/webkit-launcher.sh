#!/bin/sh
set -eu
test "$(id -u)" = 0
test -r /run/firecrawl-webkit/policy.json
test -n "${FIRECRAWL_WEBKIT_EXECUTABLE:-}"
test -f "$FIRECRAWL_WEBKIT_EXECUTABLE"
test "$(stat -c %u "$FIRECRAWL_WEBKIT_EXECUTABLE")" = 0 || {
  echo 'WebKit executable must be root-owned; install it as root in the optional image' >&2
  exit 64
}

for argument in "$@"; do
  case "$argument" in
    --user-data-dir=*)
      directory=${argument#--user-data-dir=}
      name=${directory#/tmp/}
      case "$name" in playwright_webkitdev_profile-*) ;; *) exit 65;; esac
      case "$name" in *[!A-Za-z0-9_-]*) exit 65;; esac
      test "$directory" = "/tmp/$name"
      test -d "$directory" && test ! -L "$directory"
      test "$(stat -c %u "$directory")" = 0
      chown -R --no-dereference 1000:1000 "$directory"
      ;;
  esac
done

exec setpriv --reuid=1000 --regid=1000 --clear-groups \
  --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  "$FIRECRAWL_WEBKIT_EXECUTABLE" "$@"
