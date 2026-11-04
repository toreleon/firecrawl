#!/bin/sh
set -eu
test "$(id -u)" = 0 || { echo 'WebKit requires --user root and container-local NET_ADMIN at startup' >&2; exit 64; }
test -f /.dockerenv || { echo 'WebKit UID filtering is supported only in a dedicated Docker container' >&2; exit 64; }
filter_port=${BROWSER_FILTER_PORT:-3004}
case "$filter_port" in ''|0*|*[!0-9]*) exit 64;; esac
test "${#filter_port}" -le 5 && test "$filter_port" -ge 1024 && test "$filter_port" -le 65535
test "${PORT:-3003}" != "$filter_port"

# Only the startup process configures the owned container namespace. Any missing
# capability/tool/IPv6 policy is fatal, before a browser or API listener starts.
iptables -w 2 -N FC_WEBKIT
iptables -w 2 -A FC_WEBKIT -p tcp -d 127.0.0.1/32 --dport "$filter_port" -j RETURN
iptables -w 2 -A FC_WEBKIT -j REJECT
iptables -w 2 -I OUTPUT 1 -m owner --uid-owner 1000 -j FC_WEBKIT
ip6tables -w 2 -N FC_WEBKIT
ip6tables -w 2 -A FC_WEBKIT -j REJECT
ip6tables -w 2 -I OUTPUT 1 -m owner --uid-owner 1000 -j FC_WEBKIT
install -d -m 700 -o root -g root /run/firecrawl-webkit
umask 077
printf '{"version":1,"browserUid":1000,"filterPort":%s}\n' "$filter_port" > /run/firecrawl-webkit/policy.json

# Keep only the privileges needed for fresh profile ownership, UID/GID/capability
# drop and browser cleanup. NET_ADMIN/NET_RAW are absent from the API and child
# bounding set. The browser launcher removes the remaining capabilities too.
if [ "${BROWSER_HEADLESS:-true}" = "false" ]; then
  exec setpriv --no-new-privs --bounding-set=-all,+chown,+dac_override,+fowner,+kill,+setgid,+setuid,+setpcap --inh-caps=-all --ambient-caps=-all \
    xvfb-run -a -e /dev/stderr -s '-screen 0 1365x900x24 -ac -nolisten tcp' "$@"
fi
exec setpriv --no-new-privs --bounding-set=-all,+chown,+dac_override,+fowner,+kill,+setgid,+setuid,+setpcap --inh-caps=-all --ambient-caps=-all "$@"
