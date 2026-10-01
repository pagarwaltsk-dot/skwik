// =========================================================================
//  WHAT THE READER DOES, PUT TO REAL FIGURES.
//
//  RUN IT:   node tools/reader-check.mjs
//
//  WHY THIS EXISTS AND WHY IT IS NOT tools/check.mjs.
//
//  check.mjs reads the SOURCE and looks for shapes -- "this file must not
//  contain that pattern". That catches a mistake coming back the way it left,
//  and it is cheap, and it is not proof. Rename a variable and a pattern rule
//  goes quiet on code that no longer works.
//
//  This runs the reader instead and looks at the ANSWER. It survives any
//  rewrite, because it never looks at the source at all.
//
//  NOTHING HERE IS HIS BOOK. Every file below is invented. His own day book
//  now reads clean, which is the right outcome and proves nothing -- a test
//  that only passes on one shop's data is not a test, it is a coincidence.
//
//  NO DATABASE, NO NETWORK, NO INSTALL. It shims the handful of src/lib files
//  it needs into a temp folder as .mjs (package.json has no "type": "module",
//  so node will not import the .js ones directly) and imports those.
// =========================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEED = ['money.js', 'states.js', 'uqc.js', 'transfer.js', 'tallybook.js'];

const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'skwik-reader-'));
for (const f of NEED) {
  const from = path.join(ROOT, 'src', 'lib', f);
  if (!fs.existsSync(from)) { console.error(`missing ${from}`); process.exit(2); }
  // './money.js' -> './money.mjs', so the copies find each other
  const code = fs.readFileSync(from, 'utf8')
    .replace(/(from\s+['"]\.\/[a-zA-Z0-9_-]+)\.js(['"])/g, '$1.mjs$2');
  fs.writeFileSync(path.join(shim, f.replace(/\.js$/, '.mjs')), code);
}
const tb = await import(path.join(shim, 'tallybook.mjs'));
const mo = await import(path.join(shim, 'money.mjs'));

let pass = 0; const bad = [];
const ok = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok    ${label}`); }
  else { bad.push(label); console.log(`  FAIL  ${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`); }
};
const says = (label, lines, needle) => {
  if ((lines || []).some((s) => String(s).toLowerCase().includes(needle.toLowerCase()))) {
    pass++; console.log(`  ok    ${label}`);
  } else { bad.push(label); console.log(`  FAIL  ${label}\n          said ${JSON.stringify(lines)}`); }
};

/* ---------- little builders for invented Tally files ---------- */
const GRP = (n, p) => `<GROUP NAME="${n}"><NAME>${n}</NAME><PARENT>${p}</PARENT></GROUP>`;
const LED = (n, p) => `<LEDGER NAME="${n}"><NAME>${n}</NAME><PARENT>${p}</PARENT></LEDGER>`;
const VT  = (n, p) => `<VOUCHERTYPE NAME="${n}"><NAME>${n}</NAME><PARENT>${p}</PARENT></VOUCHERTYPE>`;
// `flag` is Tally's own reverse-charge mark. It really is written with a &#4;
// control character in front of the word, and matching the raw string finds
// nothing at all -- which is how it was first measured as absent from a file
// that had twenty-seven of them.
const BILL = ({ type = 'Purc', no = '1', party = 'A Supplier', legs = [], flag = null, rate = null }) =>
  `<VOUCHER VCHTYPE="${type}"><DATE>20260801</DATE>
     <VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${no}</VOUCHERNUMBER>
     <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
     ${flag ? `<ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>Some Item</STOCKITEMNAME>
        <GSTOVRDNISREVCHARGEAPPL>&#4; ${flag}</GSTOVRDNISREVCHARGEAPPL>
        ${rate ? `<RATEDETAILS.LIST><GSTRATE>${rate}</GSTRATE><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD></RATEDETAILS.LIST>` : ''}
        <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${legs[0] ? legs[0][0] : 'X'}</LEDGERNAME>
          <AMOUNT>${legs[0] ? legs[0][1] : 0}</AMOUNT>
          ${rate ? `<RATEDETAILS.LIST><GSTRATE>${rate}</GSTRATE><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD></RATEDETAILS.LIST>` : ''}
        </ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>` : ''}
     ${legs.map(([n, a]) => `<LEDGERENTRIES.LIST><LEDGERNAME>${n}</LEDGERNAME><AMOUNT>${a}</AMOUNT></LEDGERENTRIES.LIST>`).join('')}
   </VOUCHER>`;
const FILE = (...bits) => `<ENVELOPE>${bits.join('')}</ENVELOPE>`;
const billFor = (xml, no) => (tb.vouchersFromTallyXml(xml).vouchers || []).find((v) => String(v.no) === String(no));

console.log('\nTHE TAX ON A REVERSE-CHARGE BILL  (money.js)');
{
  ok('5% inter-state is all IGST',
     mo.reverseChargeTax(3340, 5, 'igst'), { cgst: 0, sgst: 0, igst: 167, total: 167 });
  ok('5% intra-state splits in half',
     mo.reverseChargeTax(2400, 5, 'cgst_sgst'), { cgst: 60, sgst: 60, total: 120, igst: 0 });
  // 1,234.56 at 5% is 61.728 -> 61.73, and half of that is 30.865. Rounded on
  // its own that is 30.87 twice, which is 61.74 -- a paisa MORE than the tax.
  // The second half is the remainder for exactly this reason.
  // 1,234.56 at 5% is 61.728 -> 61.73, and half of that is 30.865. Rounded on
  // its own that is 30.87 twice, which is 61.74 -- a paisa MORE than the tax.
  // The second half is the remainder for exactly this reason.
  //
  // Compared ROUNDED, because 30.87 + 30.86 is 61.730000000000004 in
  // javascript and comparing that to 61.73 fails. I wrote this assertion the
  // naive way first and it reported a sound function as broken.
  ok('the two halves add back to the whole, to the paisa',
     (() => { const t = mo.reverseChargeTax(1234.56, 5, 'cgst_sgst');
              return [Math.round((t.cgst + t.sgst) * 100) / 100 === t.total, t.total]; })(),
     [true, 61.73]);
  ok('no rate means no tax, never a guess', mo.reverseChargeTax(5000, 0, 'igst'),
     { cgst: 0, sgst: 0, igst: 0, total: 0 });
  ok('no split known means no tax, never a guess', mo.reverseChargeTax(5000, 5, 'none'),
     { cgst: 0, sgst: 0, igst: 0, total: 0 });
  ok('nothing to tax means nothing', mo.reverseChargeTax(0, 5, 'igst'),
     { cgst: 0, sgst: 0, igst: 0, total: 0 });
  ok('a 12% supply halves to 6 and 6',
     mo.reverseChargeTax(1200, 12, 'cgst_sgst'), { cgst: 72, sgst: 72, total: 144, igst: 0 });
}

console.log("\nFINDING A REVERSE-CHARGE BILL  (tallybook.js)");
{
  // The one his own book missed: three legs all called FREIGHT INTRA STATE,
  // nothing anywhere saying "R.Charge", and Tally's flag set.
  const xml = FILE(VT('Purc', 'Purchase'), GRP('Sundry Creditors', 'Current Liabilities'),
    LED('SHREE SHYAM ROADWAYS', 'Sundry Creditors'), LED('FREIGHT INTRA STATE', 'Indirect Expenses'),
    BILL({ no: '102-56419', party: 'SHREE SHYAM ROADWAYS', flag: 'Applicable', rate: 5,
           legs: [['FREIGHT INTRA STATE', -1430], ['SHREE SHYAM ROADWAYS', 1430]] }));
  ok("Tally's own flag marks it, with no such word in any name",
     !!billFor(xml, '102-56419').reverse_charge, true);
}
{
  // An older export with no flag at all still works off the name.
  const xml = FILE(VT('Purc', 'Purchase'), LED('Transport Freight & R.Charge', 'Indirect Expenses'),
    BILL({ no: '2', legs: [['Transport Freight & R.Charge', -500], ['A Supplier', 500]] }));
  ok('and the name still finds it when the flag is absent',
     !!billFor(xml, '2').reverse_charge, true);
  // THIS ONE IS THE ACCOUNTS-ONLY SHAPE, and it is why the suite exists.
  // Every bill in his own book carries an inventory entry, so the freight
  // arrives as a charge riding on a stock item. A shop running Tally without
  // inventory has it as a plain ledger leg instead -- and the name test ran
  // over the stock-item charges and over `others`, never over that leg. It was
  // missed on his live build too; a made-up file is the only thing that could
  // have shown it.
}
{
  const xml = FILE(VT('Purc', 'Purchase'), LED('Ordinary Freight', 'Indirect Expenses'),
    BILL({ no: '3', flag: 'Not Applicable',
           legs: [['Ordinary Freight', -500], ['A Supplier', 500]] }));
  ok('an ordinary freight bill is NOT marked', !!billFor(xml, '3').reverse_charge, false);
}

console.log("\nFOLLOWING A LEDGER'S GROUP UP  (tallybook.js)");
{
  // Nobody files a supplier straight under Sundry Creditors. They make a group
  // for a trade or a town: his own are Transport and Umarpur Plastic Party.
  const xml = FILE(GRP('Lorry People', 'Sundry Creditors'), GRP('Sundry Creditors', 'Current Liabilities'),
    LED('Bilty Wallah', 'Lorry People'));
  ok('a supplier two groups down is still a supplier',
     tb.ledgersIn(xml)['bilty wallah'].role, 'supplier');
}
{
  const xml = FILE(GRP('Town Customers', 'Sundry Debtors'), GRP('Sundry Debtors', 'Current Assets'),
    LED('A Shop', 'Town Customers'));
  ok('and a customer two groups down is a customer',
     tb.ledgersIn(xml)['a shop'].role, 'customer');
}
{
  // THE GUARD THIS WAS DISARMING. A ledger the group has placed is never put
  // through the tax-name test -- "a customer called GST TRADERS is not a tax
  // ledger". A role of 'other' switches that guard off, so a supplier under a
  // custom group with a tax word in his name was read as tax.
  const xml = FILE(GRP('Local Traders', 'Sundry Creditors'), GRP('Sundry Creditors', 'Current Liabilities'),
    LED('CGST Trading Company', 'Local Traders'));
  ok('a supplier with a tax word in his name is still a supplier',
     tb.ledgersIn(xml)['cgst trading company'].role, 'supplier');
}
{
  const xml = FILE(GRP('A', 'B'), GRP('B', 'A'), LED('Round And Round', 'A'));
  ok('a group that is its own ancestor does not hang it',
     tb.ledgersIn(xml)['round and round'].role, 'other');
}
{
  const xml = FILE(LED('Nobody Grouped Him', 'Some Group Not In This File'));
  ok('a group the file does not carry gives up quietly',
     tb.ledgersIn(xml)['nobody grouped him'].role, 'other');
}

console.log('\nA BILL WITH NO STOCK ON IT  (tallybook.js)');
{
  // A bill with no inventory has its purchase ledger read AS the goods, which
  // is right -- there is nothing else it could be. But the fallback was "any
  // leg not definitely something else is the goods", and Indirect Expenses came
  // back 'other', so an insurance bill with no purchase ledger on it had the
  // insurance turned into a STOCK ITEM holding one unit:
  //
  //     Fire Insurance (Godown)   1 unit   14,846.00   in closing stock
  //     Shop Insurance            1 unit    8,651.00   in closing stock
  //
  // The total was right, the tax was right and GSTR-1 was right, so nothing
  // complained, and 23,497.00 of insurance sat in the stock as goods.
  const xml = FILE(VT('Purc', 'Purchase'),
    GRP('Sundry Creditors', 'Current Liabilities'), LED('An Insurer', 'Sundry Creditors'),
    LED('Fire Insurance (Godown)', 'Indirect Expenses'), LED('Round Off', 'Indirect Expenses'),
    LED('CGST', 'Duties & Taxes'), LED('SGST', 'Duties & Taxes'),
    BILL({ no: '8', party: 'An Insurer', legs: [['An Insurer', 17518],
      ['Fire Insurance (Godown)', -14846], ['CGST', -1336.14], ['SGST', -1336.14],
      ['Round Off', 0.28]] }));
  const v = billFor(xml, '8');
  ok('an expense does not become a line of goods', v.lines.length, 0);
  ok('it is carried as a charge instead', v.charge, 14846);
  // AND THE ROUND OFF IS STILL THE ROUND OFF.
  //
  // Adding 'expense' as a role broke this the same afternoon it was written.
  // The guard that keeps a ledger the group has placed away from the tax-name
  // test read "any role except tax and other", which quietly meant "anything
  // Skwik has a word for" -- so Round Off, sitting under Indirect Expenses,
  // stopped being recognised and its 0.28 went into the charge. The bill still
  // added up. The taxable was 28 paise light and nothing said so.
  ok('and the round off is still the round off, not part of the charge',
     v.round_off, -0.28);
  ok('the bill still comes to what Tally says', v.total, 17518);
}

console.log('\nWHAT A VOUCHER TYPE BECOMES  (tallybook.js)');
{
  const xml = FILE(VT('Cash Memo', 'Sales'), BILL({ type: 'Cash Memo', no: '9',
    legs: [['A Customer', -100], ['Sales', 100]] }));
  ok('a renamed type is placed by its PARENT, not its name',
     tb.readingReport(xml).voucherTypes[0].becomes, 'sale');
}
{
  const xml = FILE(BILL({ type: 'Cash Memo', no: '9', legs: [['A Customer', -100]] }));
  const r = tb.readingReport(xml);
  ok('without the type masters it cannot be placed', r.unknownTypes.map((t) => t.name), ['Cash Memo']);
  says('and it says to export them too', r.say, 'no voucher-type masters');
}

console.log('\nWHAT THE READER HAD TO GUESS AT  (tallybook.js)');
{
  // NOT under Indirect Expenses -- Tally defines that group, so the chain
  // places it and no name test is needed. This is a ledger under a group the
  // file does not carry at all, which is the only case where a name decides.
  // (Written first with Indirect Expenses, which stopped being a name decision
  // the moment expenses were recognised. The improvement made the test stale,
  // not wrong.)
  const xml = FILE(VT('Purc', 'Purchase'), LED('LORRY CARTAGE', 'Some Group Nobody Exported'),
    BILL({ no: '4', legs: [['LORRY CARTAGE', -500], ['A Supplier', 500]] }));
  const r = tb.readingReport(xml);
  const l = r.ledgers.find((x) => x.name === 'LORRY CARTAGE');
  ok('a ledger no group placed is marked as judged by its name',
     [l.decidedBy, l.role], ['name', 'freight or charges on a bill']);
  says('and it is put in front of him', r.say, 'judged by their name');
}
{
  const xml = FILE(VT('Delivery Note', 'Delivery Note'),
    BILL({ type: 'Delivery Note', no: '5', legs: [['A Supplier', 1]] }));
  says('a type that is known AND thrown away is still reported',
       tb.readingReport(xml).say, 'left out');
}
{
  const xml = FILE(GRP('Sundry Debtors', 'Current Assets'), LED('A Customer', 'Sundry Debtors'),
    LED('Sales', 'Sales Accounts'), GRP('Sales Accounts', ''), VT('Inv', 'Sales'),
    BILL({ type: 'Inv', no: '6', party: 'A Customer', legs: [['A Customer', -100], ['Sales', 100]] }));
  const r = tb.readingReport(xml);
  ok('a clean book is told nothing at all', [r.say, r.worthALook], [[], false]);
}
{
  ok('the report rides along on the book',
     !!tb.vouchersFromTallyXml(FILE(VT('Inv', 'Sales'),
        BILL({ type: 'Inv', no: '7', legs: [['A', -1], ['Sales', 1]] }))).reading, true);
}

fs.rmSync(shim, { recursive: true, force: true });
console.log(`\n${pass} passed, ${bad.length} failed`);
if (bad.length) { console.log('\n' + bad.map((b) => '  - ' + b).join('\n')); process.exit(1); }
console.log('The reader does what it is supposed to, on books nobody in this shop has ever seen.');
