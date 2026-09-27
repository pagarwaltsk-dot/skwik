// PUTTING THE DAY BOOK INTO THE BOOKS.
//
// tallybook.js reads a Tally day book and checks it. This is the other half:
// it takes what was read and writes it — ninety bills, ninety-two receipts,
// six transfers — into a shop that may already hold some of it.
//
// Three rules govern everything here.
//
// NOTHING IS WRITTEN TWICE, EVER.
//
// A shopkeeper will import the same file twice. He will press the button
// again because the signal dropped halfway, or because he is not sure it
// worked, or because he exported a longer range and it overlaps the first.
// If that doubles his sales the books are ruined and there is no way back by
// hand. So every row carries an id worked out from Tally's own id for that
// voucher — the same voucher always produces the same id — and the database
// refuses a second write of an id it already has. Pressing the button twice
// costs him nothing but the wait.
//
// THE MASTERS COME FIRST, AND ONLY WHAT IS MISSING.
//
// A bill cannot be written until the customer and the items on it exist. Any
// name already in the shop is used as it stands and never touched; only what
// is genuinely absent is created.
//
// IT STOPS ON THE FIRST REAL REFUSAL.
//
// Carrying on after a failure leaves a half-imported month, which is worse
// than none: the totals are wrong and he has no way of knowing which half
// went in. It stops, says what failed and how far it got, and everything
// already written stays valid because each piece was written whole.

import { guessUqc } from './uqc.js';
import { STATES, codeForState } from './states.js';

/* ============== WHERE A NAME IS, AND WHETHER HE IS REGISTERED ==============
 *
 * Every party an import created used to be given the shop's own state and no
 * GST number. His fourteen Delhi suppliers all came in as Assam, and because
 * a supplier with no GST number cannot have charged any, the next purchase he
 * passed to one of them took no tax at all. Two lines of code, and his input
 * credit was gone.
 *
 * THE GST NUMBER IS THE BETTER ANSWER WHEN THERE IS ONE. Its first two digits
 * ARE the state, by law, so 07BFKPB0689A1ZS is Delhi whatever the file says
 * elsewhere. Failing that, the state Tally wrote. Failing both, the shop's own
 * state, which is what a walk-in customer is.
 */

// The two digits at the front of a GST number, when they are a real state.
const codeInGstin = (g) => {
  const two = String(g || '').trim().slice(0, 2);
  return /^\d\d$/.test(two) && STATES[two] ? two : '';
};

// A state's code from the name Tally wrote, e.g. "Delhi" -> "07".
const codeFor = (name) => {
  const c = codeForState(name);
  return c && STATES[c] ? String(c) : '';
};

// Where a party is, in the order the answers are worth trusting.
const stateOf = (gstin, stateName, org) =>
  codeInGstin(gstin) || codeFor(stateName) || String(org?.state_code || '');

// A GST NUMBER, AND NEVER THE SHOP'S OWN.
//
// Tally writes the shop's own registration on every voucher, more than once and
// under more than one name, and a number that is the shop's is not the party's
// -- it is only proof that the file is this shop's file. Writing it onto a
// customer would make him look registered, make his state the shop's, and put
// the shop's own number on his bill.
const cleanGstin = (g, ownGstin, org) => {
  const t = String(g || '').trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(t)) return '';
  const mine = [String(ownGstin || '').trim().toUpperCase(),
                String(org?.gstin || '').trim().toUpperCase()].filter(Boolean);
  return mine.includes(t) ? '' : t;
};

/* ===================== the same id, every time ===================== */

// A TALLY GUID IS ALMOST A UUID ALREADY.
//
// Tally writes "8cba5cbd-ced9-4cce-9ed4-2aebb7e2b7f5-0000ed39": a company
// uuid, then a dash, then the voucher's own number in hex. The company part
// is the same on every voucher in the file, so it alone identifies nothing —
// the tail is what makes it unique.
//
// Folding the tail into the last field gives a real uuid that is unique per
// voucher and identical every time the same file is read. That is the whole
// mechanism behind "import it twice, nothing happens".
//
// `salt` keeps the kinds apart, so a voucher and a payment that somehow came
// from the same Tally id can never collide.
const HEX = /^[0-9a-f]+$/i;

export function idFor(ref, salt = '') {
  const t = String(ref || '').trim().toLowerCase();
  const m = t.match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})(?:-([0-9a-f]+))?$/);
  if (m) {
    const tail = (m[6] || '').padStart(8, '0').slice(-8);
    const node = (m[5].slice(0, 4) + tail).slice(0, 12);
    const bumped = salt ? bump(m[1], salt) : m[1];
    return `${bumped}-${m[2]}-${m[3]}-${m[4]}-${node}`;
  }
  // No usable id in the file — a hand-made export, or a Tally that wrote
  // none. Hashing whatever identity the voucher does have is still stable
  // for the same file, which is what matters.
  return fromHash(t + '|' + salt);
}

// shift the first field by a few bits so two kinds cannot land on one id
const bump = (hex8, salt) => {
  let s = 0;
  for (let i = 0; i < salt.length; i++) s = (s * 33 + salt.charCodeAt(i)) >>> 0;
  const n = (parseInt(hex8, 16) ^ (s & 0xffff)) >>> 0;
  return n.toString(16).padStart(8, '0');
};

// A plain, stable, non-cryptographic hash, laid out as a uuid. It is not
// trying to be unguessable — only to be the same every time and different
// for different input.
function fromHash(text) {
  const t = String(text);
  const h = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  for (let i = 0; i < t.length; i++) {
    for (let k = 0; k < 4; k++) {
      h[k] ^= t.charCodeAt(i) + k;
      h[k] = Math.imul(h[k], 16777619) >>> 0;
    }
  }
  const x = h.map((n) => n.toString(16).padStart(8, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export { fromHash as _hashId };

/* ===================== matching names to what is here ===================== */

export const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const indexBy = (rows, key = 'name') => {
  const m = new Map();
  (rows || []).forEach((r) => { const k = norm(r[key]); if (k && !m.has(k)) m.set(k, r); });
  return m;
};

/* ===================== what the import will do ===================== */

// Worked out before anything is written, so the screen can say exactly what
// is about to happen and he can stop.
export function planLoad(book, have = {}) {
  const items = indexBy(have.items);
  const parties = indexBy(have.parties);
  const godowns = indexBy(have.godowns);
  const accounts = indexBy(have.accounts);

  // ONE ITEM MAY APPEAR ON TWENTY BILLS. The first line that mentions it is
  // the one that decides its unit, its HSN and its GST rate, because they are
  // the same on every line of a real file — and if they are not, the first is
  // as good an answer as any and he can correct the item afterwards.
  const newItems = new Map();
  const newParties = new Map();
  const newGodowns = new Map();

  const wantGodown = (name) => {
    const k = norm(name);
    if (!k || godowns.has(k) || newGodowns.has(k)) return;
    newGodowns.set(k, { name });
  };
  // WHAT THE FILE KNOWS ABOUT A NAME, whether or not the name is new.
  //
  // A name already in the shop is never overwritten -- but it can be FILLED
  // IN, and it has to be: he has already imported once with the old code, so
  // the names are all sitting there with no GST number and the shop's own
  // state. So the details are collected for every name the file mentions, and
  // the writer decides what to do with them.
  const knownParties = new Map();
  const noteParty = (name, v) => {
    const k = norm(name);
    if (!k) return;
    const on = knownParties.get(k) || { name };
    // The first GST number and the first state win; a later voucher for the
    // same man says the same thing.
    if (!on.gstin && v?.party_gstin) on.gstin = v.party_gstin;
    if (!on.state_name && v?.party_state) on.state_name = v.party_state;
    if (!on.own_gstin && v?.own_gstin) on.own_gstin = v.own_gstin;
    knownParties.set(k, on);
  };
  const wantParty = (name, kind, v) => {
    const k = norm(name);
    noteParty(name, v);
    if (!k || parties.has(k)) return;
    if (newParties.has(k)) return;
    newParties.set(k, { name, kind: kind || 'customer' });
  };
  const wantItem = (l) => {
    const k = norm(l.item_name);
    if (!k || items.has(k) || newItems.has(k)) return;
    newItems.set(k, {
      name: l.item_name,
      unit: guessUqc(l.unit) || 'PCS',
      hsn: l.hsn || '',
      gst_rate: Number(l.gst_rate) || 0,
      // The rate on the bill is what it sold for, which is the best first
      // guess at a selling price for a shop that has none yet.
      sale_price: Number(l.rate) || 0,
    });
  };

  for (const v of book.vouchers) {
    wantParty(v.party, v.vtype === 'purchase' || v.vtype === 'purchase_return'
      ? 'supplier' : 'customer', v);
    v.lines.forEach((l) => { wantItem(l); wantGodown(l.godown); });
  }
  for (const p of book.payments) {
    wantParty(p.party, p.party_role === 'supplier' ? 'supplier'
      : p.ptype === 'payment' ? 'supplier' : 'customer');
  }
  for (const t of book.transfers) {
    wantGodown(t.from); wantGodown(t.to);
    t.lines.forEach((l) => { wantItem(l); wantGodown(l.from); wantGodown(l.to); });
  }

  // THE ACCOUNT HE BANKED IT INTO, which may not be in Skwik yet. A deposit
  // with nowhere to land would sit on the sheet as money that left the till
  // and arrived nowhere, so the account is made if the file names one Skwik
  // has never heard of.
  const newAccounts = new Map();
  for (const m of (book.cashMoves || [])) {
    const k = norm(m.account);
    if (!k || accounts.has(k) || newAccounts.has(k)) continue;
    newAccounts.set(k, { name: m.account });
  }

  // Whatever the file said about each name, carried onto the ones being made
  // so they are born with it rather than mended a moment later.
  for (const [k, np] of newParties) {
    const known = knownParties.get(k);
    if (known) {
      np.gstin = known.gstin || '';
      np.state_name = known.state_name || '';
      np.own_gstin = known.own_gstin || '';
    }
  }

  // ---------------------------------------------------------------------
  //  A FILE WITH NO BILLS IN IT, WHICH IS STILL A FILE WORTH BRINGING IN.
  //
  //  Tally exports masters and vouchers by separate commands, so a shopkeeper
  //  told to "export the day book and the masters" ends up with a file that
  //  holds five hundred stock items and not one voucher. Everything above
  //  counts what the BILLS mention, so such a file came out as nought of
  //  everything -- and a screen of noughts tells him he did something wrong
  //  when he did not.
  //
  //  So when the reader found nothing at all, the masters the file DOES hold
  //  are folded in here, in the shape the writer below already knows. Only
  //  then: a day book that also carries masters keeps working exactly as it
  //  was tested, because the bills are the better authority on an item that
  //  was actually billed.
  // ---------------------------------------------------------------------
  //  The caller decides what counts as masters -- and only ever hands over
  //  masters out of a file that held no bills, so a day book's own stock item
  //  blocks never get a say over the bills beside them. Everything the bills
  //  mentioned is already in the two maps above, and neither loop below
  //  overwrites a name that is in them: THE BILLS WIN, always.
  const nothingBilled = !book.vouchers.length && !book.payments.length
    && !(book.transfers || []).length;
  if (book.masters) {
    for (const r of (book.masters.items || [])) {
      const k = norm(r.name);
      if (!k || items.has(k) || newItems.has(k)) continue;
      newItems.set(k, {
        name: r.name,
        unit: guessUqc(r.unit) || 'PCS',
        hsn: r.hsn || '',
        gst_rate: Number(r.gst_rate) || 0,
        // what he sells at if the file says so, otherwise what he bought at,
        // which is a better first guess than nothing
        sale_price: Number(r.sale_price) || Number(r.purchase_price) || 0,
      });
    }
    for (const r of (book.masters.parties || [])) {
      const k = norm(r.name);
      if (!k) continue;
      noteParty(r.name, { party_gstin: r.gstin, party_state: r.state_name });
      if (parties.has(k) || newParties.has(k)) continue;
      newParties.set(k, {
        name: r.name,
        kind: r.kind === 'supplier' ? 'supplier' : 'customer',
        gstin: r.gstin || '',
        state_name: r.state_name || '',
      });
    }
  }

  return {
    newItems: [...newItems.values()],
    newParties: [...newParties.values()],
    newGodowns: [...newGodowns.values()],
    // every name the file mentions, new or not, with what the file knows
    knownParties: [...knownParties.values()],
    newAccounts: [...newAccounts.values()],
    bills: book.vouchers.length,
    payments: book.payments.length,
    transfers: book.transfers.length,
    cashMoves: (book.cashMoves || []).length,
    // true when there were no bills at all and everything above came out of
    // the masters instead
    fromMasters: nothingBilled && !!book.masters
      && !!(newItems.size || newParties.size),
  };
}

/* ===================== the writing ===================== */

// Every name, every item, every store the shop has. Paged, because a shop
// past a thousand items is handed only the first thousand without a word,
// and an item it could not see would be created all over again.
export async function readMasters(supabase) {
  const page = async (table, sel, extra) => {
    const out = [];
    for (let from = 0; ; from += 1000) {
      let q = supabase.from(table).select(sel).range(from, from + 999);
      if (extra) q = extra(q);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data || [];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  };
  const [items, parties, godowns, accounts] = await Promise.all([
    page('items', 'id, name', (q) => q.eq('is_active', true)),
    page('parties', 'id, name'),
    page('godowns', 'id, name'),
    // the bank accounts too, so a deposit can find the one it went into
    page('bank_accounts', 'id, name'),
  ]);
  return { items, parties, godowns, accounts };
}

// `onStep({ done, total, what })` is called as it goes, so a shopkeeper on a
// slow pack sees it moving rather than wondering whether the phone has hung.
export async function loadBook({ supabase, org, book, have = {}, onStep = () => {},
                                 note = 'Tally day book' }) {
  // WHAT THE SHOP HOLDS RIGHT NOW, ASKED FOR HERE AND NOT TAKEN ON TRUST.
  //
  // The screen already knows what the shop had when it drew the preview, and
  // it hands it over — but that was a minute ago, and the one case that
  // matters is a run that FAILED halfway and is being tried again. On that
  // second run the shop already holds the names and items the first run
  // created, and a list gathered before the first run does not know it. The
  // masters were then written a second time: measured on his own file, 185
  // items became 370 and 60 customers became 120.
  //
  // So the lists are read again, now, immediately before anything is created.
  // The bills, the money and the transfers were always safe — each carries an
  // id the database refuses twice — and this is the last piece that was not.
  const fresh = await readMasters(supabase).catch(() => null);
  if (fresh) have = fresh;

  const plan = planLoad(book, have);
  const total = plan.newGodowns.length + plan.newParties.length + plan.newItems.length
              + plan.newAccounts.length
              + plan.bills + plan.payments + plan.transfers + plan.cashMoves;
  let done = 0;
  const step = (what) => { done += 1; onStep({ done, total, what }); };

  // ONE RUN, AND EVERY ROW MARKED WITH IT.
  //
  // Without this an import can be pressed but never taken back out, and the
  // only way to undo a file that went in wrong is by hand, a bill at a time.
  // The mark costs nothing and makes one button possible.
  let run = null;
  {
    const { data, error } = await supabase.rpc('import_begin',
      { p_kind: 'daybook', p_note: note });
    // AN APP THAT HAS GOT AHEAD OF ITS DATABASE SAYS SO IN WORDS HE CAN ACT ON.
    //
    // If the SQL files have not been run yet, this is the first thing that
    // fails, and "function public.import_begin does not exist" tells a
    // shopkeeper nothing. It stops rather than going ahead, on purpose: an
    // import that cannot be marked is an import that cannot be taken back
    // out, and that is exactly the press you want to be able to undo.
    if (error) {
      const missing = /does not exist|schema cache|42883|PGRST202/i.test(
        `${error.message || ''} ${error.code || ''}`);
      throw new Error(missing
        ? 'This copy of Skwik is newer than your database. Run the SQL files under '
          + 'supabase/migrations first \u2014 in the order in RUN-THESE-IN-ORDER.txt \u2014 '
          + 'then try the import again. Nothing has been written.'
        : `Could not start the import: ${error.message}`);
    }
    run = data || null;
  }

  const made = { godowns: 0, parties: 0, items: 0, bills: 0, already: 0, payments: 0,
                 transfers: 0, accounts: 0, banked: 0, run };
  const fail = (what, e) => {
    const err = new Error(`${what}: ${e?.message || e}`);
    err.made = made; err.done = done; err.total = total;
    throw err;
  };

  const godowns = indexBy(have.godowns);
  const parties = indexBy(have.parties);
  const items   = indexBy(have.items);
  const accounts = indexBy(have.accounts);

  /* ---- the stores ---- */
  for (const g of plan.newGodowns) {
    const { data, error } = await supabase.from('godowns')
      .insert({ org_id: org.id, name: g.name, is_main: godowns.size === 0, import_run: run })
      .select().single();
    if (error) fail(`could not add the store ${g.name}`, error);
    godowns.set(norm(g.name), data);
    made.godowns += 1; step(`store ${g.name}`);
  }

  /* ---- the names ---- */
  // In blocks, because ninety round trips on a mobile pack is a minute of
  // staring at a spinner and one dropped request away from stopping.
  for (let i = 0; i < plan.newParties.length; i += 50) {
    const block = plan.newParties.slice(i, i + 50).map((p) => {
      const gstin = cleanGstin(p.gstin, p.own_gstin, org);
      const code = stateOf(gstin, p.state_name, org);
      return {
        org_id: org.id, name: p.name, kind: p.kind,
        gstin: gstin || null,
        state_code: code,
        state_name: STATES[code] || org.state_name,
      };
    });
    const { data, error } = await supabase.from('parties').insert(block.map((x) => ({ ...x, import_run: run }))).select();
    if (error) fail('could not add the customers and suppliers', error);
    (data || []).forEach((r) => parties.set(norm(r.name), r));
    made.parties += block.length;
    block.forEach((p) => step(`name ${p.name}`));
  }

  /* ---- and the names that were already here, but bare ---- */
  //
  // A NAME ALREADY IN THE SHOP IS NEVER OVERWRITTEN -- except that a blank is
  // not a fact. He has already imported once with the old code, so fifty-nine
  // names sit in his books with no GST number and the wrong state. Asking him
  // to find and retype them is not an answer; importing the same file again
  // fills them in, and the bills themselves are skipped as already written.
  //
  // Only ever a blank being filled. A number he has typed himself, or a state
  // he has corrected by hand, is left exactly as it is.
  {
    const mend = [];
    for (const p of plan.knownParties || []) {
      const on = parties.get(norm(p.name));
      if (!on) continue;
      const gstin = cleanGstin(p.gstin, p.own_gstin, org);
      const code = stateOf(gstin, p.state_name, org);
      const patch = {};
      if (gstin && !String(on.gstin || '').trim()) patch.gstin = gstin;
      // The state only moves when it is still sitting on the shop's own and we
      // now know better -- never off a state he set himself.
      if (code && code !== String(on.state_code || '')
          && String(on.state_code || '') === String(org.state_code || '')
          && code !== String(org.state_code || '')) {
        patch.state_code = code; patch.state_name = STATES[code] || on.state_name;
      }
      if (Object.keys(patch).length) mend.push({ id: on.id, ...patch });
    }
    for (const m of mend) {
      const { id, ...patch } = m;
      const { error } = await supabase.from('parties').update(patch).eq('id', id);
      if (error) fail('could not fill in a customer or supplier', error);
      made.mended = (made.mended || 0) + 1;
    }
    if (mend.length) step(`${mend.length} name${mend.length === 1 ? '' : 's'} filled in`);
  }

  /* ---- the items ---- */
  for (let i = 0; i < plan.newItems.length; i += 50) {
    const block = plan.newItems.slice(i, i + 50).map((it) => ({
      org_id: org.id, name: it.name, unit: it.unit,
      hsn: it.hsn || null, gst_rate: it.gst_rate || 0,
      sale_price: it.sale_price || 0, is_active: true,
    }));
    const { data, error } = await supabase.from('items').insert(block.map((x) => ({ ...x, import_run: run }))).select();
    if (error) fail('could not add the items', error);
    (data || []).forEach((r) => items.set(norm(r.name), r));
    made.items += block.length;
    block.forEach((it) => step(`item ${it.name}`));
  }

  const idOf = (map, name) => (map.get(norm(name)) || {}).id || null;

  /* ---- the bills ---- */
  for (const v of book.vouchers) {
    const lines = v.lines.map((l) => {
      const rate = Number(l.rate) || 0;
      const qty = Number(l.qty) || 0;
      const taxable = Number(l.amount) || round2(qty * rate);
      const gst = Number(l.gst_rate) || 0;
      // Which way the tax splits is decided by the bill, not by the line:
      // a bill that carried IGST carried it on every line.
      const inter = v.igst > 0;
      const tax = round2(taxable * gst / 100);
      return {
        item_id: idOf(items, l.item_name),
        item_name: l.item_name,
        hsn: l.hsn || null,
        unit: guessUqc(l.unit) || null,
        qty, rate, gst_rate: gst,
        taxable,
        cgst: inter ? 0 : round2(tax / 2),
        sgst: inter ? 0 : round2(tax / 2),
        igst: inter ? tax : 0,
        // THE TAX COUNTED TWICE, ON EVERY IMPORTED BILL.
        //
        // This was `taxable + tax`. Everywhere else in Skwik a line's `amount`
        // IS its taxable value -- computeBill writes `amount: t` where t is the
        // line net of discount, and the printed bill puts that in the amount
        // column and then adds the tax rows underneath it. So a line with the
        // tax already inside it was taxed a second time by the paper:
        //
        //     10 pc at 500      goods 5,000
        //     stored as          amount 5,250     <- tax already in
        //     printed as         5,250 + 125 + 125 = 5,500
        //     Tally says                            5,250
        //
        // Measured on his own day book: 74 of his 90 bills printed wrong, his
        // bill 1380 at 41,632.79 against Tally's 38,855.00. The bill's own
        // stored total was right all along, which is why his reports looked
        // fine and only the paper was wrong.
        amount: taxable,
        batch: l.batch || null,
        godown_id: idOf(godowns, l.godown),
      };
    });

    const payload = {
      id: idFor(v.ref || `${v.vtype}|${v.no}|${v.vdate}|${v.party}`, 'voucher'),
      vtype: v.vtype,
      vdate: v.vdate,
      voucher_no: v.no || null,
      party_id: v.is_cash ? null : idOf(parties, v.party),
      printed_name: v.party || 'CASH',
      is_cash: !!v.is_cash,
      // THE BILL'S TAXABLE VALUE INCLUDES WHAT RIDES ON IT.
      //
      // computeBill folds freight into the bill's taxable value, because under
      // section 15(2) it is part of the value of the supply. The import did not,
      // so a bill with freight on it stored a taxable value short by the
      // freight -- which is the figure the profit report and GSTR-1 both read.
      // And any other charge loaded onto a stock item was counted in `total`
      // and stored nowhere at all, so the bill did not add up to itself.
      taxable: round2(Number(v.taxable || 0) + Number(v.charge || 0)),
      cgst: v.cgst, sgst: v.sgst, igst: v.igst,
      round_off: v.round_off, total: v.total,
      extra_amount: v.charge || 0,
      extra_gst_rate: v.charge_rate || 0,
      extra_note: v.charge ? (v.freight ? 'Freight' : 'Charges') : null,
      // A TRANSPORTER'S BILL IS NOT A BILL WITH NO TAX ON IT.
      // Sixteen of his purchases are freight under reverse charge: the party's
      // leg equals the bill and there is no tax ledger, because the tax is his
      // own to pay. Read as an ordinary bill it looked untaxed; marked here, it
      // reaches GSTR-3B where it belongs.
      reverse_charge: !!v.reverse_charge,
      tax_mode: v.igst > 0 ? 'igst' : (v.cgst || v.sgst) ? 'cgst_sgst'
              : v.reverse_charge ? (stateOf(cleanGstin(v.party_gstin, v.own_gstin, org), v.party_state, org) === String(org.state_code || '')
                                     ? 'cgst_sgst' : 'igst')
              : 'none',
      // Place of supply, which no imported bill had.
      place_of_supply_code: codeFor(v.place_of_supply)
        || (v.vtype === 'purchase' ? String(org.state_code || '')
            : stateOf(cleanGstin(v.party_gstin, v.own_gstin, org), v.party_state, org)) || null,
      notes: v.narration || null,
      // A purchase keeps the supplier's own bill number where it belongs.
      supplier_invoice_no: v.vtype === 'purchase' ? (v.no || null) : null,
      supplier_invoice_date: v.vtype === 'purchase' ? v.vdate : null,
      lines,
    };

    const { data, error } = await supabase.rpc('save_voucher', { p: { ...payload, import_run: run } });
    if (error) fail(`could not write ${v.tally_type} ${v.no} of ${v.vdate}`, error);
    if (data && data.already) made.already += 1; else made.bills += 1;
    step(`bill ${v.no}`);
  }

  /* ---- the money ---- */
  for (let i = 0; i < book.payments.length; i += 50) {
    const block = book.payments.slice(i, i + 50).map((p) => ({
      id: idFor(p.ref || `${p.ptype}|${p.no}|${p.vdate}|${p.party}|${p.amount}`, 'payment'),
      org_id: org.id,
      ptype: p.ptype,
      party_id: idOf(parties, p.party),
      pdate: p.vdate,
      mode: p.mode === 'cash' ? 'cash' : 'bank',
      amount: p.amount,
      note: p.narration || (p.account ? `From Tally · ${p.account}` : 'From Tally'),
      import_run: run,
    }));
    // ignoreDuplicates is what makes a second import a no-op rather than a
    // second set of receipts.
    const { error } = await supabase.from('payments')
      .upsert(block, { onConflict: 'id', ignoreDuplicates: true });
    if (error) fail('could not write the receipts and payments', error);
    made.payments += block.length;
    block.forEach((p) => step(`${p.ptype} of ${p.pdate}`));
  }

  /* ---- the goods moved between stores ---- */
  for (const t of book.transfers) {
    const from = idOf(godowns, t.from);
    const to = idOf(godowns, t.to);
    if (!from || !to) { step('transfer'); continue; }
    const lines = t.lines
      .map((l) => ({ item_id: idOf(items, l.item_name), qty: Number(l.qty) || 0,
                     batch: l.batch || null }))
      .filter((l) => l.item_id && l.qty > 0);
    if (!lines.length) { step('transfer'); continue; }
    const { error } = await supabase.rpc('transfer_stock', {
      p: { from_godown: from, to_godown: to, mdate: t.vdate, lines,
           ref: idFor(t.ref || `${t.vdate}|${t.from}|${t.to}`, 'transfer'),
           import_run: run },
    });
    if (error) fail(`could not move the goods of ${t.vdate}`, error);
    made.transfers += 1;
    step(`transfer of ${t.vdate}`);
  }

  /* ---- the money he banked, and took back out ---- */
  //
  // A deposit is one movement with two ends -- out of the till, into the
  // account -- so it is one row, and the database refuses the same day, amount,
  // account and direction twice. That is what makes pressing the import again
  // safe: the bills are already skipped by their own ids, and a deposit is
  // skipped by being the same deposit.
  for (const a of plan.newAccounts) {
    const { data, error } = await supabase.from('bank_accounts')
      .insert({ org_id: org.id, name: a.name, opening: 0,
                is_active: true, is_default: accounts.size === 0 })
      .select().single();
    if (error) fail(`could not add the bank account ${a.name}`, error);
    accounts.set(norm(a.name), data);
    made.accounts += 1; step(`account ${a.name}`);
  }

  for (const m of (book.cashMoves || [])) {
    const acc = idOf(accounts, m.account);
    const { error } = await supabase.from('cash_moves').insert({
      org_id: org.id,
      direction: m.direction,
      mdate: m.vdate,
      amount: m.amount,
      account_id: acc,
      note: m.narration || (m.direction === 'deposit' ? 'paid into bank' : 'taken from bank'),
      import_run: run,
    });
    // THE SAME DEPOSIT TWICE IS NOT AN ERROR, it is the second press of a
    // button that is meant to be safe to press twice. The database says no by
    // its own unique index, and that no is the right answer, not a failure.
    if (error && !/duplicate key|unique constraint|23505/i.test(
        `${error.message || ''} ${error.code || ''}`)) {
      fail(`could not record the money banked on ${m.vdate}`, error);
    }
    if (!error) made.banked += 1;
    step(`banked ${m.amount}`);
  }

  // THE RUN IS CLOSED, with what it actually brought in written on it. That
  // is what the History tab reads back, and what the undo button counts.
  if (run) {
    await supabase.rpc('import_end', { p_run: run, p_counts: {
      bills: made.bills, already: made.already, money: made.payments,
      moves: made.transfers, items: made.items, names: made.parties,
      godowns: made.godowns, banked: made.banked,
      accounts: made.accounts } }).catch(() => {});
  }

  return { ...made, total, done };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
