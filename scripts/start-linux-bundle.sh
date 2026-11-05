#!/bin/sh
# This template is filled by the builder; hashes detect accidental corruption,
# not a malicious party able to replace this script and the bundle together.
set -eu
umask 077
case "$#:$*" in 0:|1:--kindle|1:--resume-kindle|1:--self-check|1:--headless-self-check|1:--login|1:--anonymous-profile-check|1:--distribution-gui-smoke|1:--portable-limited-pilot) ;; *) echo '許可されない引数です。' >&2; exit 1;; esac
for key in NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_V8_COVERAGE PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH KTZ_USER_DATA_DIR KTZ_TEMP_DIR KTZ_CONTROLLER_PATH KTZ_PORTABLE_ROOT LD_PRELOAD LD_LIBRARY_PATH CHROMIUM_FLAGS DEBUG PWDEBUG; do
  if /usr/bin/printenv "$key" >/dev/null 2>&1; then echo "環境変数 $key は指定できません。" >&2; exit 1; fi
done
case "$0" in */*) directory=${0%/*} ;; *) echo 'パス付きで起動してください。' >&2; exit 1;; esac
[ ! -L "$0" ] || { echo '起動ファイルのリンクは使用できません。' >&2; exit 1; }
root=$(CDPATH= cd -P -- "$directory" && pwd -P)
[ ! -e "$root/anonymous-maintenance.lock" ] && [ ! -L "$root/anonymous-maintenance.lock" ] || { echo '匿名候補の更新中または完了不明です。起動を保留します。' >&2; exit 1; }
for directory in runtime scripts; do
  [ -d "$root/$directory" ] && [ ! -L "$root/$directory" ] || { echo 'バンドルのリンクは使用できません。' >&2; exit 1; }
done
check() {
  [ -f "$root/$1" ] && [ ! -L "$root/$1" ] || { echo 'バンドルに不足があります。' >&2; exit 1; }
  sum=$(/usr/bin/sha256sum -- "$root/$1"); sum=${sum%% *}
  [ "$sum" = "$2" ] || { echo 'バンドルのハッシュが一致しません。' >&2; exit 1; }
}
check runtime/node '@NODE_SHA256@'
check scripts/linux-bundle-launch.mjs '@LAUNCH_SHA256@'
check scripts/linux-distribution.mjs '@VERIFY_SHA256@'
check receipt.json '@RECEIPT_SHA256@'
# Do not pass arbitrary Node, application or browser overrides. Keep desktop
# addresses needed by the ordinary window and the existing Snap preflight.
exec /usr/bin/env -i PATH=/usr/bin:/bin:/snap/bin HOME="${HOME-}" USER="${USER-}" LOGNAME="${LOGNAME-}" \
  DISPLAY="${DISPLAY-}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY-}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR-}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS-}" XAUTHORITY="${XAUTHORITY-}" LANG="${LANG-C.UTF-8}" \
  "$root/runtime/node" "$root/scripts/linux-bundle-launch.mjs" "$@"
