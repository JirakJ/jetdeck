#!/bin/sh
# Enables / disables power and thermal readings (CPU, GPU, ANE, package W) for JetDeck.
#
#   sh scripts/power.sh enable    # asks for your password once
#   sh scripts/power.sh disable
#   sh scripts/power.sh status
#
# Installs a sudoers rule that allows exactly ONE command without a password, with its arguments pinned:
#   /usr/bin/powermetrics --samplers cpu_power,gpu_power,ane_power,thermal -i 1000 -f plist
# Any other powermetrics invocation (e.g. `-o FILE`, which writes files as root) still needs your password.
set -eu

RULE_FILE=/etc/sudoers.d/jetdeck-powermetrics
CMD='/usr/bin/powermetrics --samplers cpu_power,gpu_power,ane_power,thermal -i 1000 -f plist'
# Commas inside sudoers command arguments must be escaped.
CMD_ESCAPED='/usr/bin/powermetrics --samplers cpu_power\,gpu_power\,ane_power\,thermal -i 1000 -f plist'
USER_NAME=$(id -un)

case "${1:-}" in
enable)
	tmp=$(mktemp)
	trap 'rm -f "$tmp"' EXIT
	printf '# Managed by JetDeck (scripts/power.sh). Remove with: sh scripts/power.sh disable\n%s ALL=(root) NOPASSWD: %s\n' \
		"$USER_NAME" "$CMD_ESCAPED" >"$tmp"
	sudo /usr/sbin/visudo -c -q -f "$tmp"
	sudo /usr/bin/install -m 0440 -o root -g wheel "$tmp" "$RULE_FILE"
	sudo /usr/sbin/visudo -c -q
	echo "installed $RULE_FILE"
	"$0" status
	;;
disable)
	sudo /bin/rm -f "$RULE_FILE"
	echo "removed $RULE_FILE"
	;;
status)
	# shellcheck disable=SC2086
	if sudo -n -l $CMD >/dev/null 2>&1; then
		echo "power readings: enabled (passwordless powermetrics allowed for $USER_NAME)"
	else
		echo "power readings: disabled"
		exit 1
	fi
	;;
*)
	echo "usage: sh scripts/power.sh enable|disable|status" >&2
	exit 2
	;;
esac
