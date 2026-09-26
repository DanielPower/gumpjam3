#!/bin/sh

set -eu

channel="html5"
archive=".itch/tripping-hazard.zip"
target="danielpower/tripping-hazard"

if ! command -v butler >/dev/null 2>&1; then
  echo "Error: butler is not installed or is not on PATH." >&2
  echo "Install it from https://itchio.itch.io/butler, then run 'butler login'." >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: zip is not installed or is not on PATH." >&2
  exit 1
fi

pnpm build

rm -rf .itch
mkdir -p .itch
(
  cd dist
  zip -qr "../${archive}" .
)

butler push "${archive}" "${target}:${channel}"
