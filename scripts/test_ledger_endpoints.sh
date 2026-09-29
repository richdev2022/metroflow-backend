#!/bin/bash
# Verify the admin ledger + virtual-account endpoints against the seeded DB.
# Requires the backend running on localhost:3999 with the seed applied.
set -u
BASE="http://localhost:3999/api"
PASS=0; FAIL=0
check() { # name, condition
  if [ "$2" = "1" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1"; FAIL=$((FAIL+1)); fi
}

# 1. Admin login
LOGIN=$(curl -s -X POST "$BASE/admin/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"ledger-admin@test.local","password":"TestAdmin!123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token') or d.get('access_token') or '')" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "LOGIN RESPONSE: $LOGIN" | head -c 500; echo
  check "admin login issued token" 0
  echo "PASS=$PASS FAIL=$FAIL"; exit 1
fi
check "admin login issued token" 1
AUTH="Authorization: Bearer $TOKEN"

# 2. revenue/history includes the legacy 'revenue' row
REV=$(curl -s "$BASE/admin/revenue/history?page=1&limit=25" -H "$AUTH")
echo "$REV" | python3 -c "
import sys, json
d = json.load(sys.stdin)
rows = d.get('transactions') or []
legacy = [r for r in rows if r.get('transaction_type') == 'revenue' and r['reference'] == 'FLW-VA-2097975288-REVENUE']
ok = d.get('success') and legacy and legacy[0]['type'] == 'credit' and float(legacy[0]['amount']) == 50.0
sys.exit(0 if ok else 1)
" && R=1 || R=0
check "revenue/history returns legacy revenue row as credit" $R
echo "$REV" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('  revenue/history rows:', len(d.get('transactions') or []), 'total:', d.get('pagination',{}).get('total'))
" 2>/dev/null

# 3. wallet/history shows platform rows
WH=$(curl -s "$BASE/admin/wallet/history" -H "$AUTH")
echo "$WH" | python3 -c "
import sys, json
d = json.load(sys.stdin)
rows = d.get('transactions') or []
refs = {r['reference'] for r in rows}
ok = d.get('success') and 'FLW-VA-2097975288-REVENUE' in refs
sys.exit(0 if ok else 1)
" && R=1 || R=0
check "wallet/history shows platform ledger rows" $R

# 4. virtual-accounts list returns 200 with both providers
VA=$(curl -s "$BASE/admin/virtual-accounts?page=1&limit=15" -H "$AUTH")
echo "$VA" | python3 -c "
import sys, json
d = json.load(sys.stdin)
data = d.get('data') or []
provs = {r['payment_provider'] for r in data}
ok = d.get('success') and {'squad','flutterwave'} <= provs and all('is_active' in r for r in data)
sys.exit(0 if ok else 1)
" && R=1 || R=0
check "virtual-accounts list returns both VAs (is_active ok)" $R

# 5. provider filter works
VAF=$(curl -s "$BASE/admin/virtual-accounts?page=1&limit=15&provider=flutterwave" -H "$AUTH")
echo "$VAF" | python3 -c "
import sys, json
d = json.load(sys.stdin)
data = d.get('data') or []
ok = d.get('success') and len(data) == 1 and data[0]['payment_provider'] == 'flutterwave'
sys.exit(0 if ok else 1)
" && R=1 || R=0
check "virtual-accounts provider filter" $R

# 6. clear ALL squad VAs (provider-only scope)
CLR=$(curl -s -X POST "$BASE/admin/virtual-accounts/clear" -H "$AUTH" -H 'Content-Type: application/json' -d '{"provider":"squad"}')
echo "$CLR" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ok = d.get('success') and d.get('data',{}).get('deleted_va_records') == 1
sys.exit(0 if ok else 1)
" && R=1 || R=0
check "clear deletes all squad VAs (provider-only scope)" $R

# 7. squad VA gone, flutterwave VA remains
VA2=$(curl -s "$BASE/admin/virtual-accounts?page=1&limit=15" -H "$AUTH")
echo "$VA2" | python3 -c "
import sys, json
d = json.load(sys.stdin)
provs = {r['payment_provider'] for r in (d.get('data') or [])}
ok = 'squad' not in provs and 'flutterwave' in provs
sys.exit(0 if ok else 1)
" && R=1 || R=0
check "squad VA deleted, flutterwave VA kept" $R

# 8. clear with no scope -> 400
CLR2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/virtual-accounts/clear" -H "$AUTH" -H 'Content-Type: application/json' -d '{}')
[ "$CLR2" = "400" ] && R=1 || R=0
check "clear without scope returns 400" $R

echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
