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
import { fileURLToPath, pathToFileURL } from 'url';

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
// A FILE URL, NOT A PATH.
//
// On Windows the shim folder is C:\Users\...\skwik-reader-xxxx, and node reads
// the leading "C:" as a URL scheme -- import() then refuses it outright with
// ERR_UNSUPPORTED_ESM_URL_SCHEME. A posix path happens to work, which is the
// only reason this passed where it was written. He develops on Windows, so it
// would have failed on his very first run of npm run check.
const load = (f) => import(pathToFileURL(path.join(shim, f)).href);
const tb = await load('tallybook.mjs');
const mo = await load('money.mjs');
const tr = await load('transfer.mjs');

let pass = 0; const bad = [];
const ok = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok    ${label}`); }
  else { bad.push(label); console.log(`  FAIL  ${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`); }
};
// A MISSING EXPORT IS A FAILED CHECK, NOT A STACK TRACE.
//
// The first version of the dated-rows section called tr.regRowsIn straight
// out. Run against the reader as it was before those helpers existed, node
// threw TypeError at the nineteenth check and the twenty-six after it never
// ran -- so the one run that most needed to be readable was a stack trace with
// no list in it. Whatever is missing is now named and the rest still runs.
const have = (label, mod, ...names) => {
  const missing = names.filter((n) => typeof mod[n] !== 'function');
  if (!missing.length) return true;
  missing.forEach((n) => {
    bad.push(`${label}: ${n} is gone`);
    console.log(`  FAIL  ${label}\n          ${n} is not exported any more, so nothing below could be checked`);
  });
  return false;
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

console.log("\nWHAT TALLY KNOWS ABOUT A PARTY, AND WHEN  (transfer.js)");
if (have("Tally's dated GST rows", tr, 'regRowsIn', 'regOn', 'registrationNow', 'partiesFromTallyXml')) {
  // Tally keeps a party's GST details as a DATED LIST and keeps every old row.
  // These are Greatx's real rows: registered in Delhi from 2024, then
  // corrected to an unregistered Assam party on 1 April 2026.
  const REG = (from, type, gstin, pos) => `<LEDGSTREGDETAILS.LIST>
      <APPLICABLEFROM>${from}</APPLICABLEFROM>
      <GSTREGISTRATIONTYPE>${type}</GSTREGISTRATIONTYPE>
      ${gstin ? `<GSTIN>${gstin}</GSTIN>` : ''}
      <PLACEOFSUPPLY>${pos}</PLACEOFSUPPLY>
    </LEDGSTREGDETAILS.LIST>`;
  const PARTY = (name, rows, legacy = {}) => `<LEDGER NAME="${name}"><NAME>${name}</NAME>
      <PARENT>Sundry Creditors</PARENT>
      ${legacy.gstin ? `<PARTYGSTIN>${legacy.gstin}</PARTYGSTIN>` : ''}
      ${legacy.state ? `<LEDSTATENAME>${legacy.state}</LEDSTATENAME>` : ''}
      <CLOSINGBALANCE>-1000</CLOSINGBALANCE>
      ${rows.join('')}
    </LEDGER>`;

  const rows = [REG('20240401', 'Regular', '18ADUPG0561F1ZI', 'Delhi'),
                REG('20260401', 'Unregistered/Consumer', '', 'Assam')];
  const parsed = tr.regRowsIn(PARTY('Greatx', rows));

  ok('both dated rows are read, oldest first',
     parsed.map((r) => r.from), ['20240401', '20260401']);
  ok('a bill before the second row gets the first',
     (tr.regOn(parsed, '2026-03-31') || {}).state, 'Delhi');
  ok('a bill on the day it changes gets the new row',
     (tr.regOn(parsed, '2026-04-01') || {}).state, 'Assam');
  ok('a bill after it gets the new row too',
     (tr.regOn(parsed, '2026-08-24') || {}).state, 'Assam');
  // A bill dated before anything Tally holds still gets the earliest row --
  // answering "nothing" would send the party to the shop's own state, which is
  // the fault this whole thing exists to fix.
  ok('a bill older than every row still gets the earliest one',
     (tr.regOn(parsed, '2019-01-01') || {}).state, 'Delhi');
  ok('with no date at all, the latest row Tally holds',
     (tr.regOn(parsed, '') || {}).state, 'Assam');
  ok('no rows means no answer, not a wrong one', tr.regOn([], '2026-04-01'), null);

  // THE NUMBER IS DROPPED WHEN TALLY DROPS IT. Greatx's retired row and the
  // legacy top-level tag both still carry 18ADUPG0561F1ZI. Copying it would
  // make an unregistered transporter look registered, put him on a B2B
  // invoice, and have the return rejected on a dead number.
  const greatx = tr.registrationNow(PARTY('Greatx', rows, { gstin: '18ADUPG0561F1ZI' }));
  ok('a party Tally calls unregistered keeps no GST number, however many places still carry one',
     [greatx.gstin, greatx.state, greatx.composition], ['', 'Assam', false]);

  // The other way: made with Tally's default state and no number, filled in
  // later. Fourteen of his names are this, and the LEGACY TAGS SEE NONE OF IT
  // -- tagTop strips .LIST blocks, so the old reader got "" and fell back to
  // the shop's own state.
  const gaurav = tr.registrationNow(PARTY('Gaurav Traders', [
    REG('20260401', 'Regular', '', 'Assam'),
    REG('20260602', 'Regular', '24BJKPM9583L1ZE', 'Gujarat')]));
  ok('a number and state typed in later are the ones used',
     [gaurav.gstin, gaurav.state], ['24BJKPM9583L1ZE', 'Gujarat']);

  ok('Composition is read off the row in force',
     tr.registrationNow(PARTY('A Composition Shop', [
       REG('20260401', 'Composition', '18AGRPP5097K2ZD', 'Assam')])).composition, true);

  // AN OLDER EXPORT HAS NO DATED ROWS AT ALL, and those files must keep
  // working exactly as they did.
  const plain = tr.registrationNow(PARTY('Old Style', [], { gstin: '19AADFB0196P1Z1', state: 'West Bengal' }));
  ok('a ledger with no dated rows still reads the legacy tags',
     [plain.gstin, plain.state], ['19AADFB0196P1Z1', 'West Bengal']);
  ok('a 14-character number is not a GST number',
     tr.registrationNow(PARTY('Typo', [], { gstin: '19AADFB0196P1Z' })).gstin, '');

  // THE TWO READERS MUST AGREE. partiesFromTallyXml writes the names into his
  // book; ledgersIn decides each bill. Reading the same ledger two ways is how
  // this got through the first time.
  const xml = FILE(GRP('Sundry Creditors', 'Current Liabilities'),
                   PARTY('Gaurav Traders', [REG('20260401', 'Regular', '', 'Assam'),
                                            REG('20260602', 'Regular', '24BJKPM9583L1ZE', 'Gujarat')]));
  const asParty = (tr.partiesFromTallyXml(xml).rows || []).find((r) => r.name === 'Gaurav Traders') || {};
  const asLedger = tb.ledgersIn(xml)['gaurav traders'] || {};
  ok('the names reader and the bill reader say the same thing about one ledger',
     [asParty.gstin, asParty.state_name, asParty.state_code],
     [asLedger.gstin, asLedger.state, '24']);
}

console.log("\nWHEN THE BILL AND THE LEDGER DISAGREE  (tallybook.js)");
if (have('the bill against its ledger', tb, 'readingReport', 'ledgersIn')) {
  const REG = (from, type, gstin, pos) => `<LEDGSTREGDETAILS.LIST>
      <APPLICABLEFROM>${from}</APPLICABLEFROM><GSTREGISTRATIONTYPE>${type}</GSTREGISTRATIONTYPE>
      ${gstin ? `<GSTIN>${gstin}</GSTIN>` : ''}<PLACEOFSUPPLY>${pos}</PLACEOFSUPPLY>
    </LEDGSTREGDETAILS.LIST>`;
  const led = `<LEDGER NAME="Greatx"><NAME>Greatx</NAME><PARENT>Sundry Creditors</PARENT>
      ${REG('20240401', 'Regular', '18ADUPG0561F1ZI', 'Delhi')}
      ${REG('20260401', 'Unregistered/Consumer', '', 'Assam')}</LEDGER>`;
  // A Tally voucher FREEZES the party's details as they stood the day it was
  // typed, so his April bill still says Delhi though he corrected the ledger
  // to Assam on 1 April. There is no way to tell from the file which of the two
  // is meant, so the reader leaves the bill alone and names it.
  const vch = (no, date, state) => `<VOUCHER><DATE>${date}</DATE>
      <VOUCHERTYPENAME>Purc</VOUCHERTYPENAME><VOUCHERNUMBER>${no}</VOUCHERNUMBER>
      <PARTYLEDGERNAME>Greatx</PARTYLEDGERNAME><STATENAME>${state}</STATENAME></VOUCHER>`;
  const base = [GRP('Sundry Creditors', 'Current Liabilities'), led, VT('Purc', 'Purchase')];

  const r = tb.readingReport(FILE(...base,
    vch('926202X210', '20260420', 'Delhi'),   // entered before he fixed it
    vch('949856', '20260824', 'Assam'),       // after, and agrees
    vch('OLD-1', '20250601', 'Delhi')));      // before, and agrees
  ok('only the bill that disagrees with its own ledger is named',
     (r.frozen || []).map((f) => [f.bill, f.onBill, f.inLedger]),
     [['926202X210', 'Delhi', 'Assam']]);
  says('and he is told which way round it is', r.say, 'Delhi on the bill, Assam in the ledger');
  says('a withdrawn number is reported, never quietly copied', r.say, 'Tally withdrew it on 1 Apr 2026');
  says('the dated rows are said to have been honoured', r.say, 'in force on its own date');

  // COMPOSITION IS A SUPPLIER'S PROBLEM, NOT A CUSTOMER'S.
  //
  // A composition dealer you BUY from charges no GST, so there is no input tax
  // to claim. A composition dealer you SELL to changes nothing for you at all.
  // The first version of this did not look at the role, and on his book it
  // announced that eleven names charge no claimable tax -- every one of them a
  // CUSTOMER under Sundry Debtors. Two books, one of each, so the distinction
  // cannot quietly collapse again.
  const compBook = (group, parentGroup) => tb.readingReport(FILE(
    GRP(group, parentGroup),
    `<LEDGER NAME="A Comp Shop"><NAME>A Comp Shop</NAME><PARENT>${group}</PARENT>
       ${REG('20260401', 'Composition', '18AGRPP5097K2ZD', 'Assam')}</LEDGER>`,
    VT('Purc', 'Purchase'),
    `<VOUCHER><DATE>20260801</DATE><VOUCHERTYPENAME>Purc</VOUCHERTYPENAME>
       <VOUCHERNUMBER>11</VOUCHERNUMBER><PARTYLEDGERNAME>A Comp Shop</PARTYLEDGERNAME>
       <STATENAME>Assam</STATENAME></VOUCHER>`));
  ok('a Composition SUPPLIER is named, because there is no tax to claim on him',
     (compBook('Sundry Creditors', 'Current Liabilities').composition || []), ['A Comp Shop']);
  ok('a Composition CUSTOMER is not, because nothing about him changes what you do',
     (compBook('Sundry Debtors', 'Current Assets').composition || []), []);
  says('and the supplier line says why', compBook('Sundry Creditors', 'Current Liabilities').say,
       'no input tax to claim');

  // A BOOK WHERE NOTHING CHANGED SAYS NOTHING. The report earns its place by
  // being quiet when there is nothing to look at.
  const quiet = tb.readingReport(FILE(GRP('Sundry Creditors', 'Current Liabilities'),
    `<LEDGER NAME="Steady"><NAME>Steady</NAME><PARENT>Sundry Creditors</PARENT>
       ${REG('20240401', 'Regular', '18AHXPA8555E1ZY', 'Assam')}</LEDGER>`,
    VT('Purc', 'Purchase'),
    `<VOUCHER><DATE>20260801</DATE><VOUCHERTYPENAME>Purc</VOUCHERTYPENAME>
       <VOUCHERNUMBER>9</VOUCHERNUMBER><PARTYLEDGERNAME>Steady</PARTYLEDGERNAME>
       <STATENAME>Assam</STATENAME></VOUCHER>`));
  ok('one steady ledger is told nothing at all',
     [(quiet.frozen || []).length, (quiet.withdrawn || []).length,
      (quiet.changed || []).length], [0, 0, 0]);
}

console.log('\nONE PARTY, THE FLAG SET BOTH WAYS  (tallybook.js)');
{
  // Tally's reverse-charge mark is set BY HAND on each bill. In his April and
  // May day books, five transporter bills worth 45,450.00 have it off while
  // other bills from the SAME transporter have it on -- 2,272.50 of tax his
  // return does not carry, and nothing in Tally shows it to him.
  //
  // The rule guesses no words: this party's other bills are reverse charge and
  // this one is not. Checked here on books that have no transporters in them at
  // all, so a rule that had quietly gone back to matching "freight" would fail.
  const PUR = (no, party, amount, rc, tax = 0) => `<VOUCHER VCHTYPE="Purc">
      <DATE>20260801</DATE><VOUCHERTYPENAME>Purc</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${no}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Some Item</STOCKITEMNAME>
        ${rc ? '<GSTOVRDNISREVCHARGEAPPL>&#4; Applicable</GSTOVRDNISREVCHARGEAPPL>' : ''}
        <RATEDETAILS.LIST><GSTRATE>5</GSTRATE><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD></RATEDETAILS.LIST>
        <AMOUNT>${amount}</AMOUNT></ALLINVENTORYENTRIES.LIST>
      <LEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><AMOUNT>-${amount}</AMOUNT></LEDGERENTRIES.LIST>
      ${tax ? `<LEDGERENTRIES.LIST><LEDGERNAME>IGST</LEDGERNAME><AMOUNT>${tax}</AMOUNT></LEDGERENTRIES.LIST>` : ''}
    </VOUCHER>`;
  const read = (...vs) => tb.vouchersFromTallyXml(FILE(VT('Purc', 'Purchase'), ...vs)).reading;

  const mixed = read(PUR('A1', 'Nondescript Udyog', 5000, true),
                     PUR('A2', 'Nondescript Udyog', 1200, false));
  ok('a name with the mark on one bill and off another is named, with the value',
     (mixed.oddFlag || []).map((o) => [o.name, o.marked, o.value, o.bills.map((b) => b.no)]),
     [['Nondescript Udyog', 1, 1200, ['A2']]]);
  says('and he is told the mark is set by hand', mixed.say, 'set by hand on each bill');
  says('and that a wider range finds more', mixed.say, 'wider date range');

  // EVERY BILL THE SAME WAY IS NOT A SLIP, either way round.
  ok('a name whose every bill is marked is left alone',
     (read(PUR('B1', 'All Marked', 100, true), PUR('B2', 'All Marked', 200, true)).oddFlag || []), []);
  // And this is the one his April file could not catch on its own: Gayatri had
  // no marked bill in April, so nothing disagreed. Guessing from the name is
  // exactly what he is right to distrust, so it stays silent.
  ok('a name whose every bill is unmarked is left alone, and no word is guessed at',
     (read(PUR('C1', 'None Marked', 100, false), PUR('C2', 'None Marked', 200, false)).oddFlag || []), []);
  ok('one bill on its own cannot disagree with anything',
     (read(PUR('D1', 'Only Once', 100, false)).oddFlag || []), []);

  // A SUPPLIER WHO SELLS GOODS *AND* BILLS THE LORRY. The goods bill carries
  // the supplier's own tax, so it is not a missed mark and must not be named --
  // a reverse-charge bill carries no supplier tax at all, by definition.
  const both = read(PUR('E1', 'Sells And Carts', 5000, true),
                    PUR('E2', 'Sells And Carts', 8000, false, 1440));
  ok('a taxed purchase from the same name is not called a missed mark',
     (both.oddFlag || []), []);
}

console.log('\nWHERE THE TRANSPORTER IS  (money.js)');
if (have('the reverse-charge head', mo, 'rcmTaxMode', 'headPointsTo')) {
  const org = { state_code: '18' };            // Assam
  // HIS OWN ANSWER WINS. This is the whole point of the row on the bill: the
  // one fact that decides which cash ledger the tax goes into was being worked
  // out from a party's state_code, and a reverse-charge party is the party most
  // likely to have no GST number and so no reliable state at all.
  ok('he says same state, and the party record says Delhi',
     mo.rcmTaxMode(org, { state_code: '07' }, 'cgst_sgst'), 'cgst_sgst');
  ok('he says other state, and the party record says Assam',
     mo.rcmTaxMode(org, { state_code: '18' }, 'igst'), 'igst');
  // WITH NO ANSWER, exactly what it did before -- every old call passes two
  // arguments and none of them may move.
  ok('no answer, party in Assam', mo.rcmTaxMode(org, { state_code: '18' }), 'cgst_sgst');
  ok('no answer, party in Delhi', mo.rcmTaxMode(org, { state_code: '07' }), 'igst');
  ok('no answer and no state falls back to local, as it always did',
     mo.rcmTaxMode(org, {}), 'cgst_sgst');
  ok('a word that is not a head is not an answer',
     mo.rcmTaxMode(org, { state_code: '07' }, 'maybe'), 'igst');

  // THE LEDGER NAME, WHICH IS A HINT AND NOT A VERDICT. On his own books it is
  // wrong on 7 of 87 reverse-charge bills, all of them Assam suppliers booked
  // under the "Interstate" ledger.
  ok('a ledger named intra state points at CGST+SGST',
     mo.headPointsTo('FREIGHT INTRA STATE'), 'cgst_sgst');
  ok('a ledger named interstate points at IGST',
     mo.headPointsTo('Transport Freight Interstate & R.Charge'), 'igst');
  ok('a ledger whose name says neither points nowhere',
     [mo.headPointsTo('Carriage Inward'), mo.headPointsTo('')], [null, null]);
}

console.log('\nTHE LEDGER NAME AGAINST THE REAL STATE  (tallybook.js)');
if (have('the heading clash', tb, 'readingReport')) {
  const REG = (from, type, gstin, pos) => `<LEDGSTREGDETAILS.LIST>
      <APPLICABLEFROM>${from}</APPLICABLEFROM><GSTREGISTRATIONTYPE>${type}</GSTREGISTRATIONTYPE>
      ${gstin ? `<GSTIN>${gstin}</GSTIN>` : ''}<PLACEOFSUPPLY>${pos}</PLACEOFSUPPLY>
    </LEDGSTREGDETAILS.LIST>`;
  // 18 is Assam, so this shop is in Assam and Tally says so in the export.
  const SHOP = '<GSTREGNUMBER>18AHXPA8555E1ZX</GSTREGNUMBER>';
  const CARRIER = (name, pos) => `<LEDGER NAME="${name}"><NAME>${name}</NAME>
      <PARENT>Sundry Creditors</PARENT>${REG('20260401', 'Regular', '', pos)}</LEDGER>`;
  const FBILL = (no, party, state, ledger, amount) => `<VOUCHER VCHTYPE="Purc">
      <DATE>20260519</DATE><VOUCHERTYPENAME>Purc</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${no}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
      ${state ? `<STATENAME>${state}</STATENAME>` : ''}
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Some Item</STOCKITEMNAME>
        <GSTOVRDNISREVCHARGEAPPL>&#4; Applicable</GSTOVRDNISREVCHARGEAPPL>
        <RATEDETAILS.LIST><GSTRATE>5</GSTRATE><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD></RATEDETAILS.LIST>
        <AMOUNT>${amount}</AMOUNT></ALLINVENTORYENTRIES.LIST>
      <LEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><AMOUNT>${amount}</AMOUNT></LEDGERENTRIES.LIST>
      <LEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><AMOUNT>-${amount}</AMOUNT></LEDGERENTRIES.LIST>
    </VOUCHER>`;
  const INTER = 'Transport Freight Interstate & R.Charge';
  const INTRA = 'FREIGHT INTRA STATE';
  const look = (...bits) => tb.vouchersFromTallyXml(
    FILE(SHOP, GRP('Sundry Creditors', 'Current Liabilities'), VT('Purc', 'Purchase'), ...bits)).reading;

  // His real case: an ASSAM transporter booked under the "Interstate" ledger.
  const clash = look(CARRIER('A Carrier', 'Assam'),
                     FBILL('923007', 'A Carrier', 'Assam', INTER, 6135));
  ok('an Assam supplier under an "interstate" ledger is named',
     (clash.headClash || []).map((h) => [h.bill, h.state, h.hint, h.real]),
     [['923007', 'Assam', 'igst', 'cgst_sgst']]);
  says('and he is told the state was used, not the name', clash.say, 'went by the state, not the name');

  // THE NAME AGREEING IS NOT NEWS.
  ok('an Assam supplier under an "intra state" ledger is left alone',
     (look(CARRIER('B Carrier', 'Assam'),
           FBILL('1', 'B Carrier', 'Assam', INTRA, 1000)).headClash || []), []);
  ok('a Delhi supplier under an "interstate" ledger is left alone',
     (look(CARRIER('C Carrier', 'Delhi'),
           FBILL('2', 'C Carrier', 'Delhi', INTER, 1000)).headClash || []), []);
  // NOTHING KNOWN, NOTHING TO DISAGREE WITH. This is the one case where the
  // name is allowed to decide the head, so it must not also be reported.
  ok('a supplier with no state at all is not a disagreement',
     (look(CARRIER('D Carrier', ''), FBILL('3', 'D Carrier', '', INTER, 1000)).headClash || []), []);
  // AND WITHOUT THE SHOP'S OWN REGISTRATION there is no "inter" to speak of.
  // The first version compared against a field no voucher carries, which made
  // every local supplier under an intra-state ledger look wrong.
  const noShop = tb.vouchersFromTallyXml(FILE(
    GRP('Sundry Creditors', 'Current Liabilities'), VT('Purc', 'Purchase'),
    CARRIER('E Carrier', 'Assam'), FBILL('4', 'E Carrier', 'Assam', INTRA, 1000))).reading;
  ok('with no company registration in the file, nothing is claimed either way',
     (noShop.headClash || []), []);
}

fs.rmSync(shim, { recursive: true, force: true });
console.log(`\n${pass} passed, ${bad.length} failed`);
if (bad.length) { console.log('\n' + bad.map((b) => '  - ' + b).join('\n')); process.exit(1); }
console.log('The reader does what it is supposed to, on books nobody in this shop has ever seen.');
