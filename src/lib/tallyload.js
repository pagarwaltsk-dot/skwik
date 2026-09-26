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

import { guessUqc } from './uqc';

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
  const wantParty = (name, kind) => {
    const k = norm(name);
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
      ? 'supplier' : 'customer');
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

  return {
    newItems: [...newItems.values()],
    newParties: [...newParties.values()],
    newGodowns: [...newGodowns.values()],
    bills: book.vouchers.length,
    payments: book.payments.length,
    transfers: book.transfers.length,
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
  const [items, parties, godowns] = await Promise.all([
    page('items', 'id, name', (q) => q.eq('is_active', true)),
    page('parties', 'id, name'),
    page('godowns', 'id, name'),
  ]);
  return { items, parties, godowns };
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
              + plan.bills + plan.payments + plan.transfers;
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
    if (error) throw new Error(`Could not start the import: ${error.message}`);
    run = data || null;
  }

  const made = { godowns: 0, parties: 0, items: 0, bills: 0, already: 0, payments: 0,
                 transfers: 0, run };
  const fail = (what, e) => {
    const err = new Error(`${what}: ${e?.message || e}`);
    err.made = made; err.done = done; err.total = total;
    throw err;
  };

  const godowns = indexBy(have.godowns);
  const parties = indexBy(have.parties);
  const items   = indexBy(have.items);

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
    const block = plan.newParties.slice(i, i + 50).map((p) => ({
      org_id: org.id, name: p.name, kind: p.kind,
      state_code: org.state_code, state_name: org.state_name,
    }));
    const { data, error } = await supabase.from('parties').insert(block.map((x) => ({ ...x, import_run: run }))).select();
    if (error) fail('could not add the customers and suppliers', error);
    (data || []).forEach((r) => parties.set(norm(r.name), r));
    made.parties += block.length;
    block.forEach((p) => step(`name ${p.name}`));
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
        amount: round2(taxable + tax),
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
      taxable: v.taxable, cgst: v.cgst, sgst: v.sgst, igst: v.igst,
      round_off: v.round_off, total: v.total,
      extra_amount: v.freight || 0,
      extra_note: v.freight ? 'Freight' : null,
      tax_mode: v.igst > 0 ? 'igst' : (v.cgst || v.sgst) ? 'cgst_sgst' : 'none',
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

  // THE RUN IS CLOSED, with what it actually brought in written on it. That
  // is what the History tab reads back, and what the undo button counts.
  if (run) {
    await supabase.rpc('import_end', { p_run: run, p_counts: {
      bills: made.bills, already: made.already, money: made.payments,
      moves: made.transfers, items: made.items, names: made.parties,
      godowns: made.godowns } }).catch(() => {});
  }

  return { ...made, total, done };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
