#!/bin/sh
set -eu

# NSArgumentDomain overrides only this process, without writing user defaults.
# Disable AppKit window animations, not animations or timers inside web pages.
exec "${SWIFTTUI_WEBKIT_EXECUTABLE:?Playwright must supply its pinned WebKit executable}" \
  -NSAutomaticWindowAnimationsEnabled NO "$@"
