// THE SUMS, CHECKED.
//
// Everything in src/lib is plain arithmetic over plain objects — the tax on a
// bill, the shares a discount is split into, what goes in which table of the
// return, what a supplier's 2B says against the books. None of it needs a
// phone to run, and all of it is the kind of thing that is wrong by one paisa
// or one table for months before anybody notices.
//
// So it is checked here, and the checks read as sentences: what the rule is,
// and what the answer has to be. A rule that changes should break a line in
// this file before it reaches a shop.
//
//   npm test
//
// (It bundles the ES modules to something Node can run, with esbuild fetched
// on the spot. Nothing is added to what the app ships.)

import { computeBill, n2, amountInWords, fmt, qty, pct, taxModeFor,
         purchaseTaxMode, saleRate, itemsGross } from '../src/lib/money.js';
import { buildGstr1 } from '../src/lib/gstr1.js';
import { reconcile, parse2b, normNo } from '../src/lib/gstr2b.js';
import { parseCsv, itemsFromCsv, partiesFromCsv } from '../src/lib/transfer.js';
import { searchItems, parseQuery, highlightParts } from '../src/lib/search.js';
import { checkHsn } from '../src/lib/hsn.js';
import { codeForState, STATES } from '../src/lib/states.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++;
  console.log(`FAIL  ${name}\n        got    ${a}\n        wanted ${b}`);
};
const ok = (name, cond) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`FAIL  ${name}`);
};

/* ---------- rounding ---------- */
eq('n2 half away from zero', n2(1.005), 1.01);
eq('n2 negative', n2(-1.005), -1.01);
eq('n2 nan', n2('abc'), 0);

/* ---------- a plain intra-state bill ---------- */
const L=[{item_name:'Thali', qty:10, rate:100, gst_rate:18, hsn:'7323', unit:'PCS'}];
let b=computeBill(L,'cgst_sgst',{});
eq('taxable', b.taxable, 1000);
eq('cgst', b.cgst, 90); eq('sgst', b.sgst, 90); eq('igst', b.igst, 0);
eq('total', b.total, 1180);
eq('lines add up', n2(b.taxable+b.cgst+b.sgst+b.igst+b.round_off), b.total);

/* ---------- discount is shared and taxed after ---------- */
b=computeBill([{item_name:'A',qty:1,rate:1000,gst_rate:5},
               {item_name:'B',qty:1,rate:3000,gst_rate:18}],'cgst_sgst',{discount:400});
eq('share small', b.lines[0].disc, 100);
eq('share big',   b.lines[1].disc, 300);
eq('taxable after discount', b.taxable, 3600);
eq('tax on discounted value', n2(b.cgst+b.sgst), n2(900*0.05 + 2700*0.18));
eq('shares equal the figure typed', b.discount, 400);

/* a discount bigger than the bill cannot exceed it */
b=computeBill(L,'cgst_sgst',{discount:99999});
eq('discount capped at the bill', b.discount, 1000);
ok('taxable never negative', b.taxable >= 0);

/* a discount of 0 really is zero, not "absent" */
b=computeBill([{item_name:'A',qty:1,rate:100,gst_rate:0,disc:30}],'cgst_sgst',{discount:0});
eq('an explicit 0 beats the line discount', b.discount, 0);

/* ---------- reverse charge collects nothing ---------- */
b=computeBill(L,'cgst_sgst',{reverseCharge:true});
eq('rcm cgst', b.cgst, 0); eq('rcm sgst', b.sgst, 0);
eq('rcm total is the value only', b.total, 1000);

/* ---------- nil / exempt / non-GST are carried, not taxed ---------- */
b=computeBill([{item_name:'Milk',qty:2,rate:50,gst_rate:5,supply:'nil'},
               {item_name:'Pen',qty:1,rate:100,gst_rate:18}],'cgst_sgst',{});
eq('nil bucket', b.nil_rated, 100);
eq('only the taxable line taxed', n2(b.cgst+b.sgst), 18);
eq('the rate the shopkeeper typed is kept', b.lines[0].gst_rate, 5);

/* ---------- freight is part of the supply ---------- */
b=computeBill(L,'igst',{amount:100,gst_rate:18});
eq('freight in taxable', b.taxable, 1100);
eq('freight taxed', b.igst, 198);

/* ---------- where the supply takes place ---------- */
const org={is_gst_registered:true,state_code:'18'};
eq('counter sale to an out-of-state stranger is local',
   taxModeFor(org,{state_code:'27'},true), 'cgst_sgst');
eq('a registered out-of-state buyer is IGST',
   taxModeFor(org,{state_code:'27',gstin:'27AAA'},true), 'igst');
eq('composition collects nothing',
   taxModeFor({...org,is_composition:true},{state_code:'18'}), 'none');
eq('an unregistered supplier charged no tax',
   purchaseTaxMode(org,{state_code:'27'}), 'none');
eq('a registered out-of-state supplier charged IGST',
   purchaseTaxMode(org,{state_code:'27',gstin:'27AAA'}), 'igst');

/* ---------- nothing leaves at nothing ---------- */
eq('cost plus a tenth', saleRate({purchase_price:100}), 110);
eq('its own price wins', saleRate({sale_price:150,purchase_price:100}), 150);

/* ---------- words ---------- */
eq('words', amountInWords(1180), 'Indian Rupees One Thousand One Hundred Eighty Only');
eq('words with paise', amountInWords(122.5,true),
   'Indian Rupees One Hundred Twenty Two and Fifty Paise Only');
eq('indian grouping', fmt(1234567), '12,34,567.00');
eq('a rate is not rounded', pct(2.5), '2.5');
eq('half a kilo', qty(0.5), '0.50');

/* ---------- the printed column adds up ---------- */
b=computeBill([{item_name:'A',qty:1,rate:1000,gst_rate:5},
               {item_name:'B',qty:1,rate:3000,gst_rate:18}],'cgst_sgst',{discount:400});
eq('gross of the lines', itemsGross(b.lines), 4000);
eq('gross less discount is the taxable value', n2(itemsGross(b.lines)-b.discount), b.taxable);



/* ---------------- GSTR-1 ---------------- */
const gstOrg={gstin:'18AABCS1234F1Z5',state_code:'18'};
const line=(o)=>({taxable:0,cgst:0,sgst:0,igst:0,qty:1,gst_rate:18,hsn:'7323',unit:'PCS',item_name:'Thali',...o});
const V={
  b2b:{id:'1',vtype:'sale',vdate:'2026-09-05',voucher_no:'1',total:1180,taxable:1000,
       cgst:90,sgst:90,igst:0,tax_mode:'cgst_sgst',parties:{gstin:'18AAAAA0000A1Z5',state_code:'18'}},
  counter:{id:'2',vtype:'sale',vdate:'2026-09-06',voucher_no:'2',total:118,taxable:100,
       cgst:9,sgst:9,igst:0,tax_mode:'cgst_sgst',parties:null},
  big:{id:'3',vtype:'sale',vdate:'2026-09-07',voucher_no:'3',total:150000,taxable:127119,
       cgst:0,sgst:0,igst:22881,tax_mode:'igst',place_of_supply_code:'27',parties:null},
  note:{id:'4',vtype:'sale_return',vdate:'2026-09-20',voucher_no:'CN-1',total:20000,taxable:16949,
       cgst:0,sgst:0,igst:3051,tax_mode:'igst',place_of_supply_code:'27',
       ref_voucher_id:'3',parties:null},
  cancelled:{id:'5',vtype:'sale',vdate:'2026-09-08',voucher_no:'4',total:500,taxable:500,
       cancelled_at:'2026-09-08T10:00:00Z',tax_mode:'cgst_sgst',parties:null},
};
const lines={
  '1':[line({taxable:1000,cgst:90,sgst:90})],
  '2':[line({taxable:100,cgst:9,sgst:9})],
  '3':[line({taxable:127119,igst:22881,gst_rate:18})],
  '4':[line({taxable:16949,igst:3051,gst_rate:18})],
  '5':[line({taxable:500})],
};
const r=buildGstr1({org: gstOrg,vouchers:Object.values(V),linesByVoucher:lines,year:2026,month:9});
eq('b2b buyers', r.json.b2b.length, 1);
eq('b2b invoice', r.json.b2b[0].inv[0].inum, '1');
eq('b2cl listed one by one', r.json.b2cl[0].inv[0].inum, '3');
ok('b2cs holds the counter sale', r.json.b2cs.some((e)=>e.pos==='18'&&e.rt===18));
ok('a note against a b2cl invoice goes to cdnur, not b2cs',
   r.json.cdnur && r.json.cdnur.length===1 && r.json.cdnur[0].typ==='B2CL');
eq('cancelled bills are not sales', r.summary.bills, 3);
eq('cancelled counted in documents issued',
   r.json.doc_issue.doc_det.find((d)=>d.doc_num===1).docs[0].cancel, 1);
eq('credit notes are document type 5',
   r.json.doc_issue.doc_det.find((d)=>d.doc_num===5).docs[0].totnum, 1);
ok('hsn table present', r.json.hsn.data.length>0);
ok('no negative hsn row', r.json.hsn.data.every((e)=>e.txval>=0&&e.qty>=0));

/* numbers sort as numbers, not as text */
const many={};
const vs=[];
for (let i=1;i<=12;i++){ vs.push({id:'x'+i,vtype:'sale',vdate:'2026-09-01',voucher_no:String(i),
  total:10,taxable:10,tax_mode:'none',parties:null}); many['x'+i]=[line({taxable:10,gst_rate:0})]; }
const r2=buildGstr1({org: gstOrg,vouchers:vs,linesByVoucher:many,year:2026,month:9});
const dr=r2.json.doc_issue.doc_det[0].docs[0];
eq('range from', dr.from, '1'); eq('range to', dr.to, '12'); eq('range count', dr.totnum, 12);

/* Table 8 never goes negative */
const t8=buildGstr1({org: gstOrg, year:2026, month:9,
  vouchers:[{id:'n1',vtype:'sale_return',vdate:'2026-09-02',voucher_no:'CN-9',total:100,
             taxable:100,tax_mode:'none',parties:null}],
  linesByVoucher:{n1:[line({taxable:100,gst_rate:0,supply:'nil'})]}});
ok('a negative Table 8 figure is held back and named',
   !t8.json.nil && t8.problems.some((p)=>/Table 8/.test(p)));

/* ---------------- GSTR-2B ---------------- */
eq('numbers normalise', normNo('SGS/26-27/007'), normNo('sgs-26-27-7'));
const books=[{id:'b1',vtype:'purchase',vdate:'2026-09-02',supplier_invoice_no:'INV/001',
  supplier_invoice_date:'2026-09-01',taxable:1000,cgst:90,sgst:90,igst:0,total:1180,
  parties:{gstin:'18AAAAA0000A1Z5',name:'Bharat'}}];
// a real GSTR-2B file, read the way the screen reads it
const TWOB = JSON.stringify({ data: { rtnprd: '092026', docdata: { b2b: [{
  ctin:'18AAAAA0000A1Z5', trdnm:'Bharat Traders',
  inv:[{ inum:'INV/1', idt:'01-09-2026', val:1180, itcavl:'Y', rev:'N',
         items:[{ num:1, txval:1000, rt:18, camt:90, samt:90, csamt:0 }] }] }] } } });
const file = parse2b(TWOB);
eq('the portal file read', file.problem, null);
eq('one invoice in it', file.rows.length, 1);
const one=reconcile({purchases:books,portal:file.rows.map((p)=>({...p}))});
eq('a padded number still matches', one.summary.matched, 1);
// the SAME row objects, run twice: the second run must not see the first
// run's pairings still written on them
const shared=file.rows;
const a=reconcile({purchases:books,portal:shared});
const bb=reconcile({purchases:books,portal:shared});
eq('reconcile is repeatable (run 1)', a.summary.matched, 1);
eq('reconcile is repeatable (run 2)', bb.summary.matched, 1);
eq('and nothing is left dangling', bb.summary.onlyBooks, 0);
eq('the credit that is safe to claim', bb.summary.safe, 180);

/* ---------------- CSV in ---------------- */
eq('quoted commas', parseCsv('a,"b,c",d\n1,2,3'), [['a','b,c','d'],['1','2','3']]);
const it=itemsFromCsv('Item Name,HSN,Unit,Rate\nSteel Thali,7323,Pieces,120\n');
eq('item name', it.rows[0].name, 'Steel Thali');
eq('unit turned into a portal code', it.rows[0].unit, 'PCS');
eq('rate read', it.rows[0].sale_price, 120);
const pt=partiesFromCsv('Name,State,Opening balance,Owed by\nRamesh,Maharashtra,500,them\n');
eq('state name became a code', pt.rows[0].state_code, '27');
eq('direction read from its own column', pt.rows[0].opening_type, 'owes_you');

/* ---------------- search ---------------- */
const items=[{id:1,name:'Thali 10 inch',unit:'PCS'},{id:2,name:'Bucket 15L',unit:'PCS'},
             {id:3,name:'Rice',unit:'KGS'}];
eq('trailing number is a quantity', parseQuery('thali 12').qty, 12);
eq('a sum at the end is worked out', parseQuery('thali 45x2').qty, 90);
eq('one and a half', parseQuery('rice 1 1/2').qty, 1.5);
eq('and the product is still rice', parseQuery('rice 1 1/2').base, 'rice');
eq('search finds it', searchItems(items,'thali 12')[0].p.id, 1);
eq('weighed goods float up on a fraction', searchItems(items,'.75 kg').length, 0);
eq('highlight of an empty name', highlightParts('',['a']), []);

/* ---------------- HSN ---------------- */
eq('hsn needed on a gst bill', checkHsn('', {is_gst_registered:true}),
   'HSN code is needed on a GST bill.');
eq('four digits are enough below 5 crore', checkHsn('7323',{is_gst_registered:true}), null);
ok('six needed above 5 crore',
   /6 digits/.test(checkHsn('7323',{is_gst_registered:true,turnover_above_5cr:true})));
eq('nothing asked of an unregistered shop', checkHsn('',{is_gst_registered:false}), null);

/* ---------------- states ---------------- */
eq('orissa', codeForState('Orissa'), '21');
eq('other territory is on the list', STATES['97'], 'Other Territory');


console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
