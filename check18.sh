ok=0; bad=0
while IFS='|' read -r f m; do
  [ -z "$f" ] && continue
  if grep -qF -- "$m" "$f" 2>/dev/null
    then echo "  ok       $f"; ok=$((ok+1))
    else echo "  MISSING  $f"; bad=$((bad+1)); fi
done <<'LIST'
src/AppContext.js|owner_id === session
src/components/Chrome.js|useTabSwipe
src/components/Pickers.js|StateField
src/lib/gstr1.js|hsnB2b
src/lib/invoice.js|compband
src/lib/money.js|purchaseTaxMode
src/lib/pdf.js|pdfName
src/lib/receipt.js|voucher.discount
src/lib/sample.js|linesWanted
src/lib/states.js|codeForState
src/lib/transfer.js|codeForState
src/screens/BillScreen.js|taxIsCost
src/screens/BillsScreen.js|useTabSwipe
src/screens/BooksScreen.js|setNewest
src/screens/ForgotScreen.js|ForgotScreen
src/screens/HomeScreen.js|shiftDay
src/screens/ItemsScreen.js|where proceed exists
src/screens/LedgerScreen.js|askWriteOff
src/screens/PartiesScreen.js|StateField
src/screens/ReportsScreen.js|cancelled_at
src/screens/ReturnScreen.js|lineKey
src/screens/SampleScreen.js|b.lines.discount
src/screens/StaffScreen.js|close_join
src/screens/TransferScreen.js|allRows
src/screens/UdharScreen.js|whenWas
src/screens/WelcomeScreen.js|Forgot
App.js|ForgotScreen
app.json|1.8.0
supabase/schema.sql|Skwik 1.8.0
supabase/migrations/1.7-audit-fixes.sql|SKWIK 1.7
supabase/migrations/1.8-twelve-changes.sql|SKWIK 1.8
LIST
echo
for f in src/screens/LoginScreen.js MoreScreen.js OnboardScreen.js supabase/update.sql; do
  if [ -e "$f" ]
    then echo "  STILL THERE  $f"; bad=$((bad+1))
    else echo "  deleted      $f"; ok=$((ok+1)); fi
done
echo
echo "   $ok right, $bad wrong"
[ "$bad" -eq 0 ] && echo "   All good. Commit, then pull, then build." \
                 || echo "   Copy me the MISSING / STILL THERE lines."