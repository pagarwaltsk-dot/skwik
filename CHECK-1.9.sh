#!/bin/bash
# Run this in your Codespace terminal from the skwik folder:  bash CHECK-1.9.sh
# It looks for one marker in each file that only 1.9 has.
cd "$(dirname "$0")"
ok=0; bad=0
chk () { if grep -q "$2" "$1" 2>/dev/null; then echo "  ok   $1"; ok=$((ok+1));
         else echo "  MISS $1   (looking for: $2)"; bad=$((bad+1)); fi; }
echo "Skwik 1.9.2 — file check"
chk src/lib/money.js            'SUPPLY_KINDS'
chk src/lib/money.js            'lineGross'
chk src/lib/money.js            'reverseCharge'
chk src/lib/money.js            'taxAt'
chk src/lib/invoice.js          'lineGross(l)'
chk src/lib/invoice.js          'rcband'
chk src/lib/receipt.js          'itemsGross'
chk src/lib/gstr1.js            'nilBag'
chk src/lib/gstr1.js            "typ: 'B2CL'"
chk src/lib/gstr1.js            'againstValue'
chk src/lib/gstr1.js            'b2csGood'
chk src/lib/hsn.js              'hsnSupply'
chk src/lib/hsn.js              'dedupe'
chk src/lib/supabase.js         'export async function allRows'
chk src/lib/transfer.js         'cancelled_at: v.cancelled_at'
chk src/AppContext.js           'could not be linked to your login'
chk src/screens/BillScreen.js   'allRows(() => supabase'
chk src/screens/BillScreen.js   'SUPPLY_KINDS\['
chk src/screens/ItemsScreen.js  'KIND OF SUPPLY'
chk src/screens/PartiesScreen.js 'allRows'
chk src/screens/MoneyScreen.js  'allRows'
chk src/screens/MoneyScreen.js  'catch'
chk src/screens/ReconScreen.js  'allRows'
chk src/screens/TransferScreen.js 'pageAll'
chk src/screens/TransferScreen.js 'cameFromBill'
chk src/screens/ReportsScreen.js 'gstLateNotes'
chk src/screens/ReturnScreen.js 'supplyOf(r)'
chk src/screens/SettingsScreen.js 'Open the email to finish'
chk src/screens/StaffScreen.js  'set_staff_role'
chk src/screens/WelcomeScreen.js 'login_email_for_phone'
chk supabase/migrations/1.9-fixes.sql 'assert_can_write'
chk supabase/migrations/1.9-fixes.sql "Paid on %"
chk supabase/migrations/1.9-fixes.sql 'vouchers_vtype_known'
chk supabase/migrations/1.9-fixes.sql 'check_voucher_line'
echo
echo "$ok in place, $bad missing."
[ $bad -eq 0 ] && echo "All 1.9 files are in." || echo "Replace the files marked MISS and run this again."
