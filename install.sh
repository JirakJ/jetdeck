#!/bin/sh
# JetDeck installer — https://github.com/JirakJ/jetdeck
#
#   curl -fsSL https://raw.githubusercontent.com/JirakJ/jetdeck/main/install.sh | sh
#
# Installs (or updates) the latest JetDeck release into ~/.jetdeck/src, builds it, links it into Stream Deck,
# registers the agent hooks and, on a Stream Deck XL, adds the ready-made JetDeck page.
#
# Environment:
#   JETDECK_DIR=<path>      install location (default ~/.jetdeck/src)
#   JETDECK_REF=<tag|branch> version to install (default: latest release tag)
#   JETDECK_PROFILE=0       do not add the XL page
set -eu

REPO="https://github.com/JirakJ/jetdeck"
DIR="${JETDECK_DIR:-$HOME/.jetdeck/src}"

bold=$(printf '\033[1m') dim=$(printf '\033[2m') red=$(printf '\033[31m') green=$(printf '\033[32m') reset=$(printf '\033[0m')
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
fail() {
	printf '%serror:%s %s\n' "$red" "$reset" "$*" >&2
	exit 1
}

step "Checking prerequisites"
[ "$(uname -s)" = "Darwin" ] || fail "JetDeck runs on macOS only."
for tool in git curl; do
	command -v "$tool" >/dev/null 2>&1 || fail "$tool is required."
done
command -v node >/dev/null 2>&1 || fail "Node.js 24+ is required (https://nodejs.org)."
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "Node.js 24+ is required (found $(node --version))."
xcrun --find clang >/dev/null 2>&1 || fail "Xcode Command Line Tools are required: run 'xcode-select --install'."
streamdeck_app=$(mdfind 'kMDItemCFBundleIdentifier == "com.elgato.StreamDeck"' 2>/dev/null | head -n 1)
[ -n "$streamdeck_app" ] || [ -d "/Applications/Elgato Stream Deck.app" ] || [ -d "$HOME/Applications/Elgato Stream Deck.app" ] ||
	fail "Stream Deck app not found. Install it from https://www.elgato.com/downloads and run this again."
ok "macOS, Node.js $(node --version), Xcode tools, Stream Deck app"

ref="${JETDECK_REF:-}"
if [ -z "$ref" ]; then
	ref=$(git ls-remote --tags --refs --sort=-v:refname "$REPO" 'v*' | head -n 1 | sed 's#.*refs/tags/##')
	[ -n "$ref" ] || ref="main"
fi

step "Fetching JetDeck $ref"
if [ -d "$DIR/.git" ]; then
	git -C "$DIR" fetch --quiet --tags --force origin
	if git -C "$DIR" show-ref --verify --quiet "refs/remotes/origin/$ref"; then
		git -C "$DIR" checkout --quiet --force -B "$ref" "origin/$ref"
	else
		git -C "$DIR" checkout --quiet --force "$ref"
	fi
else
	mkdir -p "$(dirname "$DIR")"
	git clone --quiet --branch "$ref" "$REPO" "$DIR"
fi
ok "$DIR"

cd "$DIR"
step "Building"
npm ci --include=dev --no-audit --no-fund --loglevel=error
npm run --silent build >/dev/null
ok "plugin bundle and native metrics sampler"

step "Linking into Stream Deck"
npx --no-install streamdeck link com.jakubjirak.jetdeck.sdPlugin >/dev/null
ok "com.jakubjirak.jetdeck"

step "Installing agent hooks"
npm run --silent hooks:install | sed 's/^/  /'

if [ "${JETDECK_PROFILE:-1}" != "0" ]; then
	step "Adding the JetDeck page (Stream Deck XL)"
	if npm run --silent profile:install 2>/dev/null; then
		ok "page added and opened"
	else
		printf '  %sskipped: no Stream Deck XL profile yet — connect the XL, open Stream Deck once and run npm run profile:install%s\n' "$dim" "$reset"
	fi
fi

npx --no-install streamdeck restart com.jakubjirak.jetdeck >/dev/null 2>&1 || true

printf '\n%sJetDeck %s is installed.%s\n' "$bold" "$ref" "$reset"
cat <<EOF
  • Restart agent sessions that were already running so they pick up the hooks.
  • Allow "Stream Deck wants to control Ghostty/Terminal" on the first key press.
  • Optional power readings (CPU/GPU/ANE watts, thermals): cd $DIR && npm run power:enable
EOF
