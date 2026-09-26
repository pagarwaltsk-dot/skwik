#!/bin/bash
# This used to look for a marker in each file, version by version, and it went
# stale the moment 1.9.2 shipped. The real checks now live in tools/check.mjs:
# every rule in there was a genuine fault once, written down so it cannot come
# back quietly. This file just runs them.
cd "$(dirname "$0")" || exit 1
exec node tools/check.mjs
