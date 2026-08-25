#!/bin/bash
# Bootstraps the tooling the Clyra Apple Host needs — everything short of
# full Xcode itself, which this script deliberately never installs (it's a
# multi-GB download requiring Apple ID sign-in; that step stays a manual,
# human-controlled action, shown by the setup wizard, never run silently
# here). Safe to re-run: every step checks what's already present first.
set -euo pipefail

ARCH="$(uname -m)"
MACOS="$(sw_vers -productVersion)"
CLYRA_BREW="$HOME/.homebrew"

echo "Clyra Apple Host bootstrap"
echo "  Architecture: $ARCH"
echo "  macOS: $MACOS"
echo

# --- Homebrew -----------------------------------------------------------
# Prefer a system Homebrew if the user already has one (respects their
# existing setup); only fall back to a user-owned, no-sudo checkout at
# ~/.homebrew when neither exists — the official installer requires admin
# rights this account may not have.
if command -v brew >/dev/null 2>&1; then
  BREW_BIN="$(command -v brew)"
  echo "✓ Homebrew found: $BREW_BIN"
elif [ -x "$CLYRA_BREW/bin/brew" ]; then
  BREW_BIN="$CLYRA_BREW/bin/brew"
  echo "✓ Homebrew found (Clyra-managed, no-sudo): $BREW_BIN"
else
  echo "→ No Homebrew found. Installing a user-owned copy at $CLYRA_BREW (no admin rights required)…"
  mkdir -p "$CLYRA_BREW"
  curl -fsSL https://github.com/Homebrew/brew/tarball/master | tar xz --strip-components 1 -C "$CLYRA_BREW"
  BREW_BIN="$CLYRA_BREW/bin/brew"
  echo "✓ Homebrew installed: $BREW_BIN"
fi
export PATH="$(dirname "$BREW_BIN"):$PATH"

# --- xcodes ---------------------------------------------------------------
if command -v xcodes >/dev/null 2>&1; then
  echo "✓ xcodes already installed: $(command -v xcodes)"
else
  echo "→ Installing xcodes…"
  # brew install builds from source when no bottle matches this host, which
  # itself needs a working Xcode — circular on a CLT-only Mac. Fall back to
  # the precompiled GitHub release in that case.
  if ! "$BREW_BIN" install xcodesorg/made/xcodes 2>/dev/null; then
    echo "  Homebrew build failed (needs Xcode to build from source) — using the precompiled release instead."
    TMP_ZIP="$(mktemp -d)/xcodes.zip"
    LATEST_URL="$(curl -fsSL https://api.github.com/repos/XcodesOrg/xcodes/releases/latest | grep -o '"browser_download_url": *"[^"]*xcodes\.zip"' | head -1 | sed -E 's/.*"(https[^"]+)"/\1/')"
    curl -fsSL -o "$TMP_ZIP" "$LATEST_URL"
    mkdir -p "$(dirname "$BREW_BIN")"
    unzip -o "$TMP_ZIP" -d "$(dirname "$BREW_BIN")" >/dev/null
    chmod +x "$(dirname "$BREW_BIN")/xcodes"
  fi
  echo "✓ xcodes installed: $(command -v xcodes)"
fi

# --- sim-use ----------------------------------------------------------------
if command -v sim-use >/dev/null 2>&1; then
  echo "✓ sim-use already installed: $(command -v sim-use) ($(sim-use --version 2>/dev/null || echo unknown))"
else
  echo "→ Installing sim-use…"
  "$BREW_BIN" tap lycorp-jp/tap || true
  "$BREW_BIN" install lycorp-jp/tap/sim-use
  echo "✓ sim-use installed: $(command -v sim-use)"
fi

echo
echo "Host tooling ready. Remaining step (human-controlled, not run by this script):"
echo "  Install full Xcode from the App Store, then run:"
echo "    xcodes install \"<version Clyra's setup wizard recommends>\""
echo "    sudo xcode-select -s \"<installed Xcode>/Contents/Developer\""
echo "    xcodebuild -runFirstLaunch"
