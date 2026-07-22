#!/usr/bin/env bash
# Lightweight, dependency-free consistency audit for the WealthOS AI monorepo.
# Checks: duplicate Prisma enum/model names, brace balance across all TS/TSX files,
# JSON validity of every package.json, and (best-effort) route parity between
# apps/web/lib/api-client.ts calls and apps/api backend controllers.
#
# Exit code is non-zero if any check fails, so this is safe to wire into CI later.
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
pass() { echo "  OK   $1"; }
fail() { echo "  FAIL $1"; FAIL=1; }

echo "== 1. Duplicate Prisma enum/model names =="
DUPES=$(grep -n "^enum \|^model " packages/db/prisma/schema.prisma | awk '{print $2}' | sort | uniq -d)
if [ -z "$DUPES" ]; then pass "no duplicate enum/model declarations"; else fail "duplicate declarations found:"; echo "$DUPES"; fi

echo
echo "== 2. Brace balance (all .ts/.tsx, excluding node_modules) =="
BRACE_ISSUES=0
while IFS= read -r f; do
  o=$(grep -o "{" "$f" | wc -l); c=$(grep -o "}" "$f" | wc -l)
  if [ "$o" != "$c" ]; then
    fail "$f ({=$o }=$c)"
    BRACE_ISSUES=1
  fi
done < <(find apps packages -name "*.ts" -o -name "*.tsx" | grep -v node_modules)
[ "$BRACE_ISSUES" = "0" ] && pass "all files balanced"

echo
echo "== 3. package.json validity =="
for f in package.json apps/api/package.json apps/web/package.json packages/db/package.json packages/types/package.json; do
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" 2>/dev/null; then
    pass "$f"
  else
    fail "$f is not valid JSON"
  fi
done

echo
echo "== 4. api-client.ts calls vs backend controller routes (best-effort) =="
# Extract every path literal passed to request()/requestFormData()/downloadFile() in the client,
# then cut at the first "$" so a template interpolation like `/expenses${month}` reduces to
# "expenses" rather than leaking the interpolation expression into the path.
CLIENT_PATHS=$(grep -oP '(?:request|requestFormData|downloadFile)(?:<[^>]*>)?\(`?"?/\K[a-zA-Z0-9/_${}.:-]*' apps/web/lib/api-client.ts \
  | sed 's/\$.*//' | sed 's#/$##' | sed 's#^/##' | sort -u)
# Extract every controller prefix + route literal declared across all controllers, always
# without a leading slash so it compares consistently regardless of whether the controller
# has an empty (root) prefix or a named one.
CONTROLLER_ROUTES=$(
  for f in $(find apps/api/src -name "*.controller.ts"); do
    prefix=$(grep -oP '@Controller\("\K[^"]*' "$f" | head -1)
    { grep -oP '@(Get|Post|Patch|Delete)\("\K[^"]*' "$f"; grep -oP '@(Get|Post|Patch|Delete)\(\)' "$f" | sed 's/.*/\ /'; } \
      | sed "s#^#${prefix}/#" | sed 's#/:[a-zA-Z]*#/*#g' | sed 's#//*#/#g' | sed 's#/$##' | sed 's#^/##'
  done | sort -u
)
MISMATCH=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  base=$(echo "$p" | cut -d/ -f1)
  if ! echo "$CONTROLLER_ROUTES" | grep -qE "^($p|${p}/\*)$" && ! echo "$CONTROLLER_ROUTES" | grep -q "^${base}"; then
    fail "client calls '/$p' — no controller with prefix '$base' found"
    MISMATCH=1
  fi
done <<< "$CLIENT_PATHS"
[ "$MISMATCH" = "0" ] && pass "every client call's route prefix has a matching controller (loose check — verify exact param routes manually)"

echo
if [ "$FAIL" = "0" ]; then
  echo "AUDIT PASSED"
else
  echo "AUDIT FAILED — see FAIL lines above"
fi
exit $FAIL
