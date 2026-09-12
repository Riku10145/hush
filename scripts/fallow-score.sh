#!/usr/bin/env bash
# Frozen hillclimb harness. fallow@3.22.0 published 2026-09-01, more than 7 days
# before this run. Do not bump the pin without re-baselining.
set -euo pipefail
cd "$(dirname "$0")/.."
npx --yes fallow@3.22.0 health --score --format json --quiet "$@"
