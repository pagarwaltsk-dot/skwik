import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Modal, FlatList,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { readPickedFile } from '../lib/pickfile';

import { supabase, allRows as pageAll } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { useApp } from '../AppContext';
import { fmt0, today } from '../lib/money';
import {
  sniff, itemsFromCsv, partiesFromCsv, itemsFromTallyXml, partiesFromTallyXml, planImport,
  priceLevelsInTally, applyPriceLevel,
  itemsToCsv, partiesToCsv, billsToCsv, billLinesToCsv, tallyVouchersXml, goesToTally,
  paymentsToCsv, expensesToCsv, balancesToCsv, stockToCsv, bookToCsv,
  looksMangled, base64ToBytes, decodeBytes,
  buildBackup, readBackup, backupVoucherPayload,
  ITEMS_TEMPLATE, PARTIES_TEMPLATE,
} from '../lib/transfer';
import { BackButton, Bar, Foot, Head, MoreButton, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// BRINGING BOOKS IN, AND SENDING THEM OUT.
//
// A shopkeeper with 800 items in Tally will not retype them, and his
// accountant wants the month back in Tally at the end of it. Both directions
// live here.

const RANGES = [
  { k: 'all',   label: 'Everything' },
  { k: 'month', label: 'This month' },
  { k: 'last',  label: 'Last month' },
  { k: 'fy',    label: 'This year' },
];

const firstOfMonth = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

// READING THE FILE HE PICKED.
//
function rangeDates(k) {
  const now = new Date();
  if (k === 'month') return [firstOfMonth(now), null];
  if (k === 'last') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end   = new Date(now.getFullYear(), now.getMonth(), 0);
    return [firstOfMonth(start), today(end)];
  }
  if (k === 'fy') {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return [`${y}-04-01`, null];
  }
  return [null, null];
}


// A ROW DECLARED INSIDE THE SCREEN IS A NEW COMPONENT ON EVERY RENDER.
//
// React compares components by identity. Written inside TransferScreen, this
// arrow function was a brand new type each time anything on the screen
// changed, so React threw the whole list away and built it again from
// nothing — with five hundred imported rows sitting in state, every single
// tap. That is the freeze that makes a button look dead.
const Row = ({ label, note, onPress, busyKey, tone, busy }) => (
  <TouchableOpacity onPress={onPress} disabled={!!busy}
    style={{ paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: C.line,
             opacity: busy && busy !== busyKey ? 0.4 : 1 }}>
    <View style={S.row}>
      <Text style={{ flex: 1, fontSize: 16, fontWeight: '700',
                     color: tone === 'quiet' ? C.ink : C.accent }}>{label}</Text>
      {busy === busyKey && <ActivityIndicator size="small" color={C.accent} />}
    </View>
    {!!note && <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 18 }}>{note}</Text>}
  </TouchableOpacity>
);


export default function TransferScreen({ navigation }) {
  const { org, reloadOrg } = useApp();
  const [busy, setBusy]   = useState('');
  const [range, setRange] = useState('month');
  const [ready, setReady] = useState(null);   // what was read, waiting to be confirmed
  const [seeAll, setSeeAll] = useState(false); // the whole list of it, not five rows
  const [basisOk, setBasisOk] = useState(false); // he has told us these ARE closing figures

  /* ---------------- out ---------------- */

  // Everything leaves the same way: write the file, then hand it to whatever
  // the phone uses to share — WhatsApp, Gmail, Drive, the accountant.
  const send = async (name, text, mime) => {
    const file = new File(Paths.cache, name);
    try { if (file.exists) file.delete(); } catch (e) { /* first time through */ }
    file.create();
    file.write(text);
    if (!(await Sharing.isAvailableAsync())) {
      return Alert.alert('Nothing to share with', 'This phone has no app set up to receive files.');
    }
    await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: name });
  };

  // EVERY ROW, NOT THE FIRST THOUSAND.
  //
  // Supabase answers with at most a thousand rows and says nothing about the
  // rest. Every export on this screen asked once and sent whatever came back,
  // so a shop with more than a thousand bills, items or customers handed its
  // accountant a file that stopped in the middle and looked complete. The
  // reports screen already did this properly; this one did not.
  const allRows = async (build) => {
    const out = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await build().range(from, from + size - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < size) return out;
    }
  };

  const exportItems = async () => {
    setBusy('items');
    try {
      const data = await allRows(() => supabase.from('items').select('*').order('name').order('id'));
      if (!data?.length) return Alert.alert('Nothing to send', 'There are no items yet.');
      await send('skwik-items.csv', itemsToCsv(data), 'text/csv');
    } catch (e) { Alert.alert('Could not send', sayPlainly(e)); }
    finally { setBusy(''); }
  };

  const exportParties = async () => {
    setBusy('parties');
    try {
      const data = await allRows(() => supabase.from('parties').select('*').order('name').order('id'));
      if (!data?.length) return Alert.alert('Nothing to send', 'There are no customers yet.');
      await send('skwik-customers.csv', partiesToCsv(data), 'text/csv');
    } catch (e) { Alert.alert('Could not send', sayPlainly(e)); }
    finally { setBusy(''); }
  };

  const fetchBills = async () => {
    const [from, to] = rangeDates(range);
    return allRows(() => {
      let qy = supabase.from('vouchers')
        .select('*, parties(name, gstin, state_name, state_code)')
        // id as a tie-break: two bills on one date have no order of their own,
        // and a page boundary between them would drop one and repeat another.
        .order('vdate').order('id');
      if (from) qy = qy.gte('vdate', from);
      if (to)   qy = qy.lte('vdate', to);
      return qy;
    });
  };

  const exportBills = async () => {
    setBusy('bills');
    try {
      const vs = await fetchBills();
      if (!vs.length) return Alert.alert('Nothing in that period', 'No bills were found.');
      await send('skwik-bills.csv', billsToCsv(vs), 'text/csv');
    } catch (e) { Alert.alert('Could not send', sayPlainly(e)); }
    finally { setBusy(''); }
  };

  const exportBillLines = async () => {
    setBusy('lines');
    try {
      const vs = await fetchBills();
      if (!vs.length) return Alert.alert('Nothing in that period', 'No bills were found.');
      const ids = vs.map((v) => v.id);
      const ls = [];
      for (let i = 0; i < ids.length; i += 200) {
        ls.push(...await allRows(() => supabase.from('voucher_lines')
          .select('*').in('voucher_id', ids.slice(i, i + 200)).order('id')));
      }
      const byId = Object.fromEntries(vs.map((v) => [v.id, v]));
      const rows = (ls || []).map((l) => ({
        ...l,
        vdate: byId[l.voucher_id]?.vdate,
        voucher_no: byId[l.voucher_id]?.voucher_no,
        who: byId[l.voucher_id]?.parties?.name || byId[l.voucher_id]?.printed_name || '',
      })).sort((a, b) => String(a.vdate).localeCompare(String(b.vdate)));
      await send('skwik-bill-lines.csv', billLinesToCsv(rows), 'text/csv');
    } catch (e) { Alert.alert('Could not send', sayPlainly(e)); }
    finally { setBusy(''); }
  };

  /* ---------------- everything, organised ---------------- */

  // ONE JOURNEY, NOT NINE.
  //
  // An accountant asking for "the books" wants sale bills, purchase bills,
  // what is on each line, the money in and out, the expenses, what every
  // party stands at, the items and the stock — and he wants them as separate
  // sheets with their own headings, not one file to be untangled.
  //
  // The phone's sharing sheet will carry several files at once, so they are
  // written together and handed over in one go, each named for what is in it.
  const exportEverything = async () => {
    setBusy('all');
    try {
      const [from, to] = rangeDates(range);
      const tag = from ? `${from}_to_${to || today()}` : 'all';

      const vs = await fetchBills();
      const ids = vs.map((v) => v.id);

      // the lines behind those bills, in pages, so a busy shop is not truncated
      const lines = [];
      for (let i = 0; i < ids.length; i += 200) {
        lines.push(...await allRows(() => supabase.from('voucher_lines')
          .select('*').in('voucher_id', ids.slice(i, i + 200)).order('id')));
      }
      const byId = Object.fromEntries(vs.map((v) => [v.id, v]));
      const lineRows = lines.map((l) => ({
        ...l,
        vdate: byId[l.voucher_id]?.vdate,
        voucher_no: byId[l.voucher_id]?.voucher_no,
        vtype: byId[l.voucher_id]?.vtype,
        who: byId[l.voucher_id]?.parties?.name || byId[l.voucher_id]?.printed_name || '',
      })).sort((a, b) => String(a.vdate).localeCompare(String(b.vdate)));

      const money = () => {
        let q = supabase.from('payments')
          .select('*, parties(name), bank_accounts(name)').order('pdate').order('id');
        if (from) q = q.gte('pdate', from);
        if (to)   q = q.lte('pdate', to);
        return q;
      };
      const spend = () => {
        let q = supabase.from('expenses')
          .select('*, bank_accounts(name)').order('edate').order('id');
        if (from) q = q.gte('edate', from);
        if (to)   q = q.lte('edate', to);
        return q;
      };

      const [pays, exps, items, { data: bal }, stock, { data: cashBook }] = await Promise.all([
        allRows(money), allRows(spend),
        allRows(() => supabase.from('items').select('*').order('name').order('id')),
        supabase.rpc('party_balances'),
        allRows(() => supabase.from('stock_in_hand').select('*').order('name').order('item_id')),
        // the cash book is asked for whole here: this is the accountant's
        // copy, not a screen, so the limit is lifted rather than paged
        supabase.rpc('money_book', { p_from: from || '2000-04-01', p_to: to || today(),
                                     p_account: null, p_cash: true, p_limit: 1000000 }),
      ]);

      const sale = vs.filter((v) => v.vtype === 'sale' || v.vtype === 'estimate');
      const buy  = vs.filter((v) => v.vtype === 'purchase');
      const rtn  = vs.filter((v) => v.vtype === 'sale_return' || v.vtype === 'purchase_return');

      const files = [
        [`skwik_${tag}_1-sale-bills.csv`,      billsToCsv(sale)],
        [`skwik_${tag}_2-purchase-bills.csv`,  billsToCsv(buy)],
        rtn.length && [`skwik_${tag}_3-returns.csv`, billsToCsv(rtn)],
        [`skwik_${tag}_4-bill-lines.csv`,      billLinesToCsv(lineRows)],
        [`skwik_${tag}_5-money-in-out.csv`,    paymentsToCsv(pays || [])],
        (exps || []).length && [`skwik_${tag}_6-expenses.csv`, expensesToCsv(exps || [])],
        [`skwik_${tag}_7-party-balances.csv`,  balancesToCsv(bal || [])],
        [`skwik_${tag}_8-cash-book.csv`,
          bookToCsv('Cash', cashBook?.opening || 0, cashBook?.rows || [])],
        [`skwik_${tag}_9-items.csv`,           itemsToCsv(items || [])],
        (stock || []).length && [`skwik_${tag}_10-stock.csv`, stockToCsv(stock || [])],
      ].filter(Boolean);

      const uris = [];
      for (const [name, text] of files) {
        const f = new File(Paths.cache, name);
        try { if (f.exists) f.delete(); } catch (err) { /* first time through */ }
        f.create();
        f.write(text);
        uris.push({ name, uri: f.uri });
      }

      if (!(await Sharing.isAvailableAsync())) {
        return Alert.alert('Nothing to share with',
          'This phone has no app set up to receive files.');
      }

      // The sharing sheet takes one file at a time on most phones, so they go
      // one after another and he is told how many are coming.
      Alert.alert('Ready — ' + uris.length + ' sheets',
        uris.map((u) => '· ' + u.name.replace('skwik_' + tag + '_', '').replace('.csv', ''))
          .join('\n')
        + '\n\nThe sharing box opens once for each one. Send them all to the '
        + 'same place — WhatsApp, Gmail or Drive — and they arrive as a set.',
        [{ text: 'Not now' },
         { text: 'Send them', onPress: async () => {
             for (const u of uris) {
               try {
                 await Sharing.shareAsync(u.uri, { mimeType: 'text/csv', dialogTitle: u.name });
               } catch (err) { /* he closed the sheet: stop quietly */ break; }
             }
           } }]);
    } catch (e) {
      Alert.alert('Could not put it together', sayPlainly(e));
    } finally { setBusy(''); }
  };

  const exportTally = async () => {
    setBusy('tally');
    try {
      // sales, purchases AND the credit and debit notes that reverse them.
      // Estimates are not accounting entries and cancelled bills are not
      // entries at all.
      const vs = (await fetchBills()).filter(goesToTally);
      if (!vs.length) {
        return Alert.alert('Nothing in that period',
          'Bills, purchases and the notes against them go to Tally. Estimates are '
          + 'not accounting entries, and a cancelled bill is not an entry at all.');
      }
      // EVERY LINE, AND NOT ALL IN ONE BREATH.
      //
      // This asked for the lines of every bill in one query: unpaged, so it
      // stopped at the thousandth line without a word, and with every id in
      // the URL, which a month of a busy shop is long enough to break. The
      // accountant's Tally then showed bills with items missing from them.
      // Two hundred bills at a time, each page read to the end — the same way
      // the CSV export and the backup already do it.
      const byV = {};
      for (let i = 0; i < vs.length; i += 200) {
        const part = vs.slice(i, i + 200).map((v) => v.id);
        const ls = await allRows(() => supabase.from('voucher_lines')
          .select('*').in('voucher_id', part).order('voucher_id').order('line_no'));
        (ls || []).forEach((l) => { (byV[l.voucher_id] = byV[l.voucher_id] || []).push(l); });
      }
      await send('skwik-tally.xml', tallyVouchersXml({ org, vouchers: vs, linesByVoucher: byV }),
                 'application/xml');
    } catch (e) { Alert.alert('Could not send', sayPlainly(e)); }
    finally { setBusy(''); }
  };

  /* ---------------- the whole book ---------------- */

  // Everything, in one file he keeps himself. Fetched in pieces so a big
  // book does not arrive as one enormous request.
  const saveBackup = async () => {
    setBusy('backup');
    try {
      // A PAGE NEEDS SOMETHING TO BE A PAGE OF.
      //
      // Asking for rows 0-999 and then 1000-1999 without saying in what order
      // lets the database answer in whatever order it likes, and it does not
      // have to be the same order twice. Rows near the boundary could come
      // back twice or not at all, and a backup that quietly loses rows is
      // worse than no backup. Ordering by id makes the pages line up.
      const grab = async (table, cols = '*') => {
        const out = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase.from(table).select(cols)
            .order('id').range(from, from + 999);
          if (error) throw error;
          out.push(...(data || []));
          if (!data || data.length < 1000) break;
        }
        return out;
      };

      const [items, parties, vouchers, lines, payments, expenses,
             godowns, banks, moves] = await Promise.all([
        grab('items'), grab('parties'), grab('vouchers'),
        grab('voucher_lines'), grab('payments'), grab('expenses'),
        // the three that were never in the file: see buildBackup
        grab('godowns'), grab('bank_accounts'), grab('stock_moves'),
      ]);

      const text = buildBackup({ org, items, parties, vouchers, lines, payments, expenses,
                                 godowns, banks, moves });
      const day = today();
      await send(`skwik-backup-${day}.json`, text, 'application/json');

      const ownMoves = (moves || []).filter((m) => !m.ref_voucher_id).length;
      Alert.alert('Backup made',
        `${vouchers.length} bills, ${items.length} items, ${parties.length} names, `
        + `${expenses.length} money-out entries.\n`
        + `${godowns.length} godown(s), ${banks.length} bank account(s), `
        + `${ownMoves} stock movement(s) no bill made.\n\n`
        + 'Keep it somewhere that is not this phone — Drive, or send it to '
        + 'yourself on WhatsApp.');
    } catch (e) {
      Alert.alert('Could not make the backup', sayPlainly(e));
    } finally { setBusy(''); }
  };

  // Putting a book back. Safe to run twice: a bill that is already there is
  // left alone rather than written again.
  const restoreBackup = async () => {
    setBusy('restore');
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: false, type: '*/*',
      });
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset?.uri) return;

      const b = readBackup(await readPickedFile(asset.uri));
      if (b.problem) return Alert.alert('Cannot use that file', b.problem);

      Alert.alert(
        `Restore ${b.firm || 'this book'}?`,
        `Taken ${String(b.taken_at).slice(0, 10)}.\n\n`
        + `${b.vouchers.length} bills, ${b.items.length} items, ${b.parties.length} names.\n\n`
        + 'Anything already here is left as it is. Nothing is deleted.',
        [{ text: 'Not now' },
         { text: 'Put it back', onPress: () => doRestore(b) }]);
    } catch (e) {
      Alert.alert('Could not read that file', sayPlainly(e));
    } finally { setBusy(''); }
  };

  const doRestore = async (b) => {
    setBusy('saving');
    try {
      const mine = (r) => ({ ...r, org_id: org.id });

      // THE GODOWNS AND THE BANK ACCOUNTS GO FIRST.
      //
      // Every bill carries a godown id and every receipt an account id, and
      // both have a foreign key behind them. Put a bill back before its
      // godown exists and the database refuses the whole row.
      for (let i = 0; i < (b.godowns || []).length; i += 100) {
        const { error } = await supabase.from('godowns')
          .upsert((b.godowns || []).slice(i, i + 100).map(mine), { onConflict: 'id' });
        if (error) throw error;
      }
      for (let i = 0; i < (b.banks || []).length; i += 100) {
        const { error } = await supabase.from('bank_accounts')
          .upsert((b.banks || []).slice(i, i + 100).map(mine), { onConflict: 'id' });
        if (error) throw error;
      }

      for (let i = 0; i < b.parties.length; i += 100) {
        const { error } = await supabase.from('parties')
          .upsert(b.parties.slice(i, i + 100).map(mine), { onConflict: 'id' });
        if (error) throw error;
      }
      for (let i = 0; i < b.items.length; i += 100) {
        const { error } = await supabase.from('items')
          .upsert(b.items.slice(i, i + 100).map(mine), { onConflict: 'id' });
        if (error) throw error;
      }

      const byVoucher = {};
      b.lines.forEach((l) => { (byVoucher[l.voucher_id] = byVoucher[l.voucher_id] || []).push(l); });

      // A CANCELLED BILL COMES BACK CANCELLED.
      //
      // save_voucher has no way to write cancelled_at, so a restore used to
      // bring every cancelled bill back to life — the number, the goods, the
      // tax and all. It is saved first, so its number is held, and then
      // cancelled again with the reason it carried.
      // A CREDIT NOTE CANNOT GO BACK BEFORE THE BILL IT IS AGAINST.
      //
      // The bills went back in whatever order the file listed them, and a
      // credit note carries the id of the bill it reverses. Arrive first and
      // the database refuses it — "violates foreign key constraint" — and the
      // restore stopped dead there, leaving the book half rebuilt and the
      // shopkeeper looking at a sentence in Postgres. On a real month's
      // backup that was five bills in a hundred and thirty.
      //
      // The ones that point at nothing go first. Anything still refused is
      // kept for the next round, and the rounds stop when a whole pass puts
      // nothing back — so a note against a note against a bill is fine too,
      // and a note whose bill is genuinely missing from the file is reported
      // instead of stopping everything.
      let bills = 0, already = 0, recancelled = 0;
      const putBack = async (v) => {
        const { data, error } = await supabase.rpc('save_voucher',
          { p: backupVoucherPayload(v, byVoucher[v.id]) });
        if (error) return error;
        if (data?.already) already++; else bills++;
        if (v.cancelled_at && data?.id && !data?.already) {
          const { error: cErr } = await supabase.rpc('delete_voucher',
            { p_id: data.id, p_reason: v.cancel_reason || 'Cancelled before this backup' });
          if (cErr) throw cErr;
          recancelled++;
        }
        return null;
      };

      let queue = [...b.vouchers].sort((x, y) =>
        (x.ref_voucher_id ? 1 : 0) - (y.ref_voucher_id ? 1 : 0));
      let lastErr = null;
      while (queue.length) {
        const again = [];
        for (const v of queue) {
          const err = await putBack(v);
          if (!err) continue;
          // a missing bill to point at: try again once the rest are in
          if (/foreign key|not present in table/i.test(err.message || '')) {
            again.push(v); lastErr = err;
          } else throw err;
        }
        if (again.length === queue.length) {          // a whole pass, no progress
          throw new Error(
            `${again.length} credit or debit note${again.length === 1 ? '' : 's'} in this `
            + 'backup point at a bill that is not in the file, so they could not be put '
            + 'back. Everything else has been restored.');
        }
        queue = again;
      }

      // Receipts and payments he entered himself. The ones a cash bill wrote
      // are left out — saving the bill writes those again by itself.
      //
      // The test is who MADE the row, not whether it points at a bill. A real
      // receipt can be tied to a bill afterwards, and testing on the link
      // alone dropped those from every restore.
      //
      // A BACKUP WRITTEN BEFORE 1.9 HAS NO from_voucher AT ALL, and undefined
      // is not false — every payment in it would have passed this filter and
      // been written back on top of the one save_voucher had just recreated,
      // doubling the cash on every restore anyone is holding today. When the
      // key is missing the old rule is the best guess there is.
      const cameFromBill = (pm) => (pm.from_voucher === undefined || pm.from_voucher === null
        ? !!pm.ref_voucher_id
        : !!pm.from_voucher);
      const manual = b.payments.filter((pm) => !cameFromBill(pm));
      for (let i = 0; i < manual.length; i += 100) {
        const { error } = await supabase.from('payments')
          .upsert(manual.slice(i, i + 100).map(mine), { onConflict: 'id' });
        if (error) throw error;
      }

      // Money out. Empty on a backup taken by an older Skwik.
      for (let i = 0; i < (b.expenses || []).length; i += 100) {
        const { error } = await supabase.from('expenses')
          .upsert(b.expenses.slice(i, i + 100).map(mine), { onConflict: 'id' });
        if (error) throw error;
      }

      // THE MOVEMENTS NO BILL MADE.
      //
      // Transfers between godowns and opening-stock rows are written straight
      // into stock_moves by their own routines, with no bill behind them, so
      // nothing in the restore recreated them. A transfer nets to zero, which
      // is why nobody noticed: the total stock came back right and the
      // godown-wise figures were wrong.
      //
      // The ones a bill made are deliberately not in the file — save_voucher
      // wrote them again a moment ago, and putting them back as well would
      // count every sale twice.
      const ownMoves = (b.moves || []).filter((m) => !m.ref_voucher_id);
      for (let i = 0; i < ownMoves.length; i += 200) {
        const { error } = await supabase.from('stock_moves')
          .upsert(ownMoves.slice(i, i + 200).map(mine), { onConflict: 'id' });
        if (error) throw error;
      }

      Alert.alert('Put back',
        `${bills} bills restored${already ? `, ${already} were already here` : ''}.\n`
        + `${b.items.length} items and ${b.parties.length} names checked.\n`
        + `${(b.godowns || []).length} godown(s), ${(b.banks || []).length} bank account(s), `
        + `${ownMoves.length} stock movement(s) put back.`
        + ((b.godowns || []).length || ownMoves.length ? '' :
            '\n\nThis file was made by an older Skwik, so it carries no godowns, '
            + 'no bank accounts and no transfers. Take a fresh backup.'));
    } catch (e) {
      Alert.alert('Stopped part way',
        `${sayPlainly(e)}\n\nWhat went back before the problem is saved. `
        + 'Running the restore again carries on from there without duplicating anything.');
    } finally { setBusy(''); }
  };

  /* ---------------- in ---------------- */

  const pick = async (what) => {
    setBusy(what === 'items' ? 'in-items' : 'in-parties');
    try {
      // Left where it is on purpose. Copying it into the app's cache is what
      // makes Expo Go refuse to read it, and Tally's XML is often reported as
      // a plain unknown file, so nothing is filtered out by type either.
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: false,
        type: '*/*',
      });
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset?.uri) return Alert.alert('Could not open that', 'No file came back.');

      const text = await readPickedFile(asset.uri);
      const kind = sniff(text);

      // A Tally file can hold a wholesale list and a retail list side by side.
      // The one he chose last time is remembered on his firm; if that level is
      // not in this file we start with none, and he picks below.
      const levels = kind === 'csv' || what !== 'items' ? [] : priceLevelsInTally(text);
      const saved  = levels.includes(org?.tally_price_level) ? org.tally_price_level : '';

      let read;
      if (what === 'items') {
        read = kind === 'csv' ? itemsFromCsv(text) : itemsFromTallyXml(text, { level: saved });
      } else {
        read = kind === 'csv' ? partiesFromCsv(text) : partiesFromTallyXml(text);
      }

      if (read.problem) return Alert.alert('Could not read that file', read.problem);
      if (!read.rows.length) return Alert.alert('Nothing found', 'That file had no rows we could use.');

      setBasisOk(false);
      setReady({ what, rows: read.rows, name: asset.name || 'the file',
                 noRate: read.noRate || 0, skipped: read.skipped || 0,
                 kind: kind === 'csv' ? 'a spreadsheet' : 'a Tally export',
                 // The file itself is no longer held: changing the price
                 // list works off the rates already read, and keeping a
                 // several-megabyte string alive in state on a phone with
                 // the import sheet open is memory for nothing.
                 columns: read.columns || null,
                 levels, level: saved, basis: read.basis || null });
    } catch (e) {
      const msg = String(e?.message || e);
      Alert.alert('Could not read that file',
        /permission/i.test(msg)
          ? 'Android would not let Skwik open that file. Copy it into your '
            + 'phone\'s Downloads folder and pick it from there.'
          : msg);
    } finally { setBusy(''); }
  };

  // A DIFFERENT PRICE LIST, WITHOUT READING THE FILE AGAIN.
  //
  // This used to re-parse the entire Tally export on every tap — half a
  // megabyte of XML, on the phone's one thread, with nothing on the screen
  // moving while it ran. The chip did not light up, the rates below did not
  // change, and a finger on the glass got no answer at all: a control that
  // works perfectly and looks broken. Every level's rate was already read
  // when the file was opened, so this is now arithmetic on what is in hand
  // and the chip lights the instant it is touched.
  //
  // The chosen list is still remembered on the firm, but quietly: reloading
  // the firm row here re-rendered the whole screen for nothing.
  const useLevel = (level) => {
    if (!ready) return;
    setReady((r) => {
      const rows = applyPriceLevel(r.rows, level);
      // The count of items with no rate belongs to the list he just picked,
      // not to the one the file was first read on.
      return { ...r, level, rows, noRate: rows.filter((x) => !x.sale_price).length };
    });
    supabase.from('orgs').update({ tally_price_level: level || null })
      .eq('id', org.id).then(() => {}, () => {});
  };

  // Names already in the book are updated, new ones are added. Nothing is
  // ever duplicated and nothing is ever removed.
  const commit = async () => {
    const { what, rows } = ready;
    setReady(null);
    setBusy('saving');
    try {
      const table = what === 'items' ? 'items' : 'parties';
      // THE DE-DUPLICATOR HAS TO SEE EVERYTHING.
      // It loads what is already there to decide what the file is adding. It
      // stopped at 1,000 rows, so a shop with more than that re-created every
      // item past row 1,000 as a duplicate on every import.
      const have = await pageAll(() => supabase.from(table)
        .select('id, name').order('id'));
      // What the file adds, changes and repeats is worked out by planImport in
      // lib/transfer.js, where it can be tested without a database. This does
      // only the writing.
      const plan = planImport({ rows, have, what, orgId: org.id });
      const { added, updated, repeated, noState } = plan;

      // the changes go in blocks too: one round trip per item was 800 round
      // trips for a shop bringing its Tally list over, which on a weak line is
      // minutes of a spinner
      for (let i = 0; i < plan.toUpdate.length; i += 100) {
        const { error } = await supabase.from(table)
          .upsert(plan.toUpdate.slice(i, i + 100).map((u) => ({ id: u.id, ...u.body })),
                  { onConflict: 'id' });
        if (error) throw error;
      }
      const toAdd = plan.toAdd;

      // new ones go in blocks, so one long list is not one long wait
      for (let i = 0; i < toAdd.length; i += 100) {
        const { error } = await supabase.from(table).insert(toAdd.slice(i, i + 100));
        if (error) throw error;
      }

      Alert.alert('Done',
        `${added} new, ${updated} updated. Nothing was removed.`
        + (repeated
            ? `\n\n${repeated} row${repeated === 1 ? '' : 's'} in that file `
              + `repeated a name already on it. Skwik kept the last one of each `
              + `rather than making two items with the same name — check the file `
              + `if that is not what you meant.`
            : '')
        + (noState
            ? `\n\n${noState} name${noState === 1 ? ' has' : 's have'} no State on the file. `
              + `Skwik has left ${noState === 1 ? 'it' : 'them'} blank rather than `
              + `assuming your own State — put it in before you bill ${noState === 1 ? 'him' : 'them'}, `
              + `or the tax will be worked out wrong.`
            : ''));
    } catch (e) {
      Alert.alert('Stopped part way', `${sayPlainly(e)}\n\nWhat went in before the `
        + `problem is saved. Fix the file and bring it in again — names already `
        + `here are updated, not duplicated.`);
    } finally { setBusy(''); }
  };

  /* ---------------- screen ---------------- */


  return (
    <Screen>
      <Bar>
        <BackButton navigation={navigation} />
        <View style={{ flex: 1 }}>
          <Text style={S.barName}>Import & export</Text>
          <Text style={S.barSub}>Tally and spreadsheets</Text>
        </View>
        <MoreButton navigation={navigation} />
      </Bar>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        <Text style={S.eyebrow}>Bring your book in</Text>
        <Text style={{ fontSize: 13, color: C.muted, marginBottom: 6, lineHeight: 19 }}>
          From Tally: Gateway → Display → List of Accounts → Export, and choose
          XML. Or any spreadsheet saved as CSV. A name already here is updated,
          never duplicated.
        </Text>

        <Row busy={busy} label="Items" busyKey="in-items" onPress={() => pick('items')}
          note="Name, HSN, unit, rates and GST. Headings need not match exactly — Particulars, Rate and Per are all understood." />
        <Row busy={busy} label="Customers and suppliers" busyKey="in-parties" onPress={() => pick('parties')}
          note="Name, GST number, phone and what they owed you before. The GST number fills in the state, which decides IGST." />

        <View style={{ height: 26 }} />

        <Text style={S.eyebrow}>Send your book out</Text>

        <View style={[S.row, { gap: 6, marginBottom: 12 }]}>
          {RANGES.map((r) => {
            const on = range === r.k;
            return (
              <TouchableOpacity key={r.k} onPress={() => setRange(r.k)}
                style={{ flex: 1, paddingVertical: 7, borderRadius: 9, alignItems: 'center',
                         borderWidth: 1, borderColor: on ? C.accent : C.line,
                         backgroundColor: on ? C.accentSoft : C.surface }}>
                <Text numberOfLines={1}
                  style={{ fontSize: 12, fontWeight: '600', color: on ? C.accent : C.muted }}>
                  {r.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Row busy={busy} label="Everything, in order" busyKey="all" onPress={exportEverything}
          note="Sale bills, purchase bills, returns, every line, money in and out, expenses, what each party stands at, the cash book, the items and the stock — each as its own numbered sheet. This is what to send your accountant." />

        <Row busy={busy} label="To Tally" busyKey="tally" onPress={exportTally}
          note={`Bills and purchases as a Tally XML your accountant imports with Gateway → Import → Vouchers. It uses the ledger names from Settings${org?.sales_ledger ? '' : ' — set those first, or it will use plain names like Sales and CGST'}.`} />
        <Row busy={busy} label="Bills, one row each" busyKey="bills" onPress={exportBills} tone="quiet"
          note="A spreadsheet of every bill with its tax split. For your own checking, or your accountant's." />
        <Row busy={busy} label="Bills, one row per item" busyKey="lines" onPress={exportBillLines} tone="quiet"
          note="Every line of every bill. This is the one to use for working out what sold." />
        <Row busy={busy} label="Items" busyKey="items" onPress={exportItems} tone="quiet"
          note="Your whole item list, in the same shape it can be brought back in." />
        <Row busy={busy} label="Customers and suppliers" busyKey="parties" onPress={exportParties} tone="quiet"
          note="Names, GST numbers, phones and balances." />

        <View style={{ height: 26 }} />

        <Text style={S.eyebrow}>Your own copy</Text>
        <Text style={{ fontSize: 13, color: C.muted, marginBottom: 6, lineHeight: 19 }}>
          Your book lives on Skwik's server. This is your own copy of all of
          it, in one file, that nobody can take away. Worth making one every
          month, and keeping it off this phone.
        </Text>

        <Row busy={busy} label="Save a full backup" busyKey="backup" onPress={saveBackup}
          note="Firm, items, customers, every bill and every line, receipts and payments." />
        <Row busy={busy} label="Put a backup back" busyKey="restore" onPress={restoreBackup} tone="quiet"
          note="Adds anything missing. Nothing here is deleted, and a bill already in your books is left alone." />

        <View style={{ height: 26 }} />

        <Text style={S.eyebrow}>Blank forms</Text>
        <Row busy={busy} label="Items form" tone="quiet" busyKey="t1"
          onPress={() => send('skwik-items-form.csv', ITEMS_TEMPLATE, 'text/csv')}
          note="Fill this in on a computer and bring it back." />
        <Row busy={busy} label="Customers form" tone="quiet" busyKey="t2"
          onPress={() => send('skwik-customers-form.csv', PARTIES_TEMPLATE, 'text/csv')} />

        <Text style={[S.hint, { marginTop: 22 }]}>
          Your whole book stays in Skwik. These files are copies — sending one
          out changes nothing here.
        </Text>
      </ScrollView>

      {/* ---------- what was read, before anything is saved ---------- */}
      <Modal visible={!!ready} transparent animationType="slide"
             onRequestClose={() => setReady(null)}>
        <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end' }}>
          {/* A SHEET THAT GREW TALLER THAN THE PHONE.
              Title, a chip for every price list in his Tally, how the columns
              were read, a note about the balances, five sample rows and two
              buttons — on a big screen it fits and on a small one it does not,
              and what does not fit runs off the edge. Anything off the edge is
              not drawn and cannot be touched: on his phone the whole thing
              looked dead, which is exactly what he reported.

              So the sheet is now capped at seven eighths of the screen,
              whatever screen that is, the middle scrolls, and the two buttons
              are pinned outside the scroll where they can always be reached. */}
          <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22,
                         maxHeight: '88%' }}>
            {!!ready && (
              <>
                <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
                  <Text style={{ fontSize: 21, fontWeight: '700', color: C.ink }}>
                    {fmt0(ready.rows.length)} {ready.what === 'items' ? 'items' : 'names'} read
                  </Text>
                  <Text style={{ fontSize: 13, color: C.muted, marginTop: 6, lineHeight: 19 }}>
                    From {ready.name}, which looks like {ready.kind}. Nothing is saved yet.
                  </Text>
                </View>

                <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }}>

                {ready.levels?.length > 1 && (
                  <View style={{ marginTop: 14 }}>
                    <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.ink }}>
                      Which price list is your selling rate?
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                      {['', ...ready.levels].map((lv) => {
                        const on = (ready.level || '') === lv;
                        return (
                          <TouchableOpacity key={lv || 'newest'} onPress={() => useLevel(lv)}
                            style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9,
                                     borderWidth: 1, borderColor: on ? C.accent : C.line,
                                     backgroundColor: on ? C.accentSoft : C.surface }}>
                            <Text style={{ fontSize: 13, fontWeight: '600',
                                           color: on ? C.accent : C.muted }}>
                              {lv || 'Newest rate'}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 6, lineHeight: 16 }}>
                      Check a rate below against Tally before you bring them in.
                    </Text>
                  </View>
                )}

                {/* WHICH COLUMN SKWIK DECIDED WAS WHICH.
                    Every spreadsheet names its columns differently, so the
                    importer has to guess. Guessing is fine; guessing silently
                    is not — a wholesale rate read as the selling price costs
                    money on every bill afterwards and nothing ever said so. */}
                {!!ready.columns?.length && (
                  <View style={{ marginTop: 14, padding: 12, borderWidth: 1,
                                 borderColor: C.line, borderRadius: 12,
                                 backgroundColor: C.surface }}>
                    <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.ink }}>
                      How Skwik read your columns
                    </Text>
                    {ready.columns.map((c) => (
                      <View key={c.field} style={[S.row, { marginTop: 5 }]}>
                        <Text style={{ flex: 1, fontSize: 12.5, color: C.muted }}>{c.says}</Text>
                        <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.ink }}>
                          {c.heading || '—'}
                        </Text>
                      </View>
                    ))}
                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 7, lineHeight: 16 }}>
                      If any of those went to the wrong place, rename the heading in
                      your file and pick it again. Nothing is saved yet.
                    </Text>
                  </View>
                )}

                {/* WHAT THE FILE DID NOT HAVE.
                    Both of these used to happen in silence — items arriving
                    with the purchase price standing in for a selling price,
                    and ledgers dropped because they sit in a group inside a
                    group. Counting them is the difference between an import
                    he can check and one he has to take on trust. */}
                {!!ready.noRate && (
                  <View style={{ marginTop: 14, padding: 12, backgroundColor: C.flagSoft,
                                 borderWidth: 1, borderColor: C.flagLine, borderRadius: 12 }}>
                    <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.flagInk }}>
                      {fmt0(ready.noRate)} of these have no selling rate
                      {ready.level ? ` on your “${ready.level}” list` : ' in the file'}
                    </Text>
                    <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 4, lineHeight: 17 }}>
                      They come in with the rate blank rather than with what you
                      PAID for them, which is what Skwik used to do — a bill
                      written off that price gives the goods away. Put a rate
                      against them in Items, or pick a different list above.
                      {ready.levels?.length > 1
                        ? ' Tally only holds a rate on the lists you actually set.'
                        : ''}
                    </Text>
                  </View>
                )}

                {!!ready.skipped && (
                  <View style={{ marginTop: 14, padding: 12, backgroundColor: C.surface,
                                 borderWidth: 1, borderColor: C.line, borderRadius: 12 }}>
                    <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.ink }}>
                      {fmt0(ready.skipped)} other ledgers left out
                    </Text>
                    <Text style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 17 }}>
                      Sales, purchase, tax, bank and cash ledgers are not people
                      and do not belong in your customer list. Only what sits
                      under Sundry Debtors or Sundry Creditors — at any depth,
                      inside your own groups — is brought over.
                    </Text>
                  </View>
                )}

                {/* SKWIK CANNOT TELL, AND IT WAS TALKING AS IF IT COULD.
                    Tally writes the stock figure into a tag called
                    OPENINGBALANCE. When you export masters with "make closing
                    balance as opening", Tally puts TODAY'S figure into that
                    same tag — the name does not change. So a file carrying
                    the right numbers looks identical to one carrying April's,
                    and Skwik flatly told him his were wrong. He had done
                    exactly what he was being told to do.

                    It is a question now, not a verdict, and answering it puts
                    it away. */}
                {!!ready.basis && ready.basis !== 'closing' && !basisOk && (
                  <View style={{ marginTop: 14, padding: 12, backgroundColor: C.flagSoft,
                                 borderWidth: 1, borderColor: C.flagLine, borderRadius: 12 }}>
                    <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.flagInk }}>
                      Is this stock as it stands today?
                    </Text>
                    <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 4, lineHeight: 17 }}>
                      Tally writes the stock figure under the heading
                      “opening balance” whichever one you exported, so Skwik
                      cannot tell them apart. Check one item below against
                      Tally.{'\n\n'}
                      If it is April's figure instead, export again with
                      “make closing balance as opening” turned on — Gateway →
                      Display → Stock Summary → Export (Trial Balance for
                      customers and suppliers).
                    </Text>
                    <View style={[S.row, { gap: 8, marginTop: 10 }]}>
                      <TouchableOpacity onPress={() => setBasisOk(true)}
                        style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9,
                                 borderWidth: 1.5, borderColor: C.flagLine }}>
                        <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.flagInk }}>
                          Yes, it is today's
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => setSeeAll(true)}
                        style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9,
                                 borderWidth: 1.5, borderColor: C.flagLine }}>
                        <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.flagInk }}>
                          Let me check
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                <View style={{ marginTop: 14, padding: 12, backgroundColor: C.surface,
                               borderWidth: 1, borderColor: C.line, borderRadius: 12 }}>
                  {ready.rows.slice(0, 5).map((r, i) => (
                    <Text key={i} numberOfLines={1}
                      style={{ fontSize: 13.5, color: C.ink, marginBottom: 4 }}>
                      {r.name}
                      <Text style={{ color: C.muted }}>
                        {ready.what === 'items'
                          ? `  ${r.hsn ? `HSN ${r.hsn} · ` : ''}₹${fmt0(r.sale_price)}`
                          : `  ${[r.gstin, r.phone].filter(Boolean).join(' · ')}`}
                      </Text>
                    </Text>
                  ))}
                  {ready.rows.length > 5 && (
                    <TouchableOpacity onPress={() => setSeeAll(true)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{ marginTop: 6 }}>
                      {/* HE TRIED TO TAP THIS. Of course he did — it is the
                          only thing on the sheet that names what he cannot
                          see, and it was a line of plain text. Checking five
                          rows out of five hundred is not checking. */}
                      <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.accent }}>
                        and {fmt0(ready.rows.length - 5)} more — see all of them
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
                </ScrollView>

                {/* Pinned. Whatever is above them and however small the phone,
                    these two are on the screen and can be pressed. */}
                <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24,
                               borderTopWidth: 1, borderTopColor: C.line,
                               backgroundColor: C.bg }}>
                  <TouchableOpacity style={S.btn} onPress={commit}>
                    <Text style={S.btnText}>
                      Bring in {fmt0(ready.rows.length)} {ready.what === 'items' ? 'items' : 'names'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setReady(null)}
                    style={{ marginTop: 10, alignItems: 'center', paddingVertical: 10 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>
                      Not now
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* ---------- everything that was read, before a rupee of it is saved ---- */}
      <Modal visible={!!seeAll && !!ready} animationType="slide"
             onRequestClose={() => setSeeAll(false)}>
        <Screen>
          <Head more={false} onBack={() => setSeeAll(false)}
                title={ready
                  ? `${fmt0(ready.rows.length)} ${ready.what === 'items' ? 'items' : 'names'}`
                  : ''} />
          <FlatList
            data={ready?.rows || []}
            keyExtractor={(r, i) => `${r.name}|${i}`}
            initialNumToRender={20}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
            ListHeaderComponent={
              <Text style={{ fontSize: 12.5, color: C.muted, paddingVertical: 12, lineHeight: 18 }}>
                {ready?.what === 'items'
                  ? `Rate, HSN and opening stock as Skwik read them${
                      ready?.level ? `, off your “${ready.level}” list` : ''}. `
                    + 'Nothing is saved until you tap Bring them in.'
                  : 'As Skwik read them. Nothing is saved until you tap Bring them in.'}
              </Text>
            }
            renderItem={({ item, index }) => (
              <View style={[S.row, { paddingVertical: 10, borderBottomWidth: 1,
                                     borderBottomColor: C.line, gap: 10 }]}>
                <Text style={[{ width: 34, fontSize: 11.5, color: C.faint }, S.num]}>
                  {index + 1}
                </Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1}
                    style={{ fontSize: 14.5, fontWeight: '700', color: C.ink }}>
                    {item.name}
                  </Text>
                  <Text numberOfLines={1} style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                    {ready?.what === 'items'
                      ? [item.hsn ? `HSN ${item.hsn}` : null,
                         item.unit,
                         item.gst_rate ? `${item.gst_rate}% GST` : null,
                         item.opening_stock ? `${item.opening_stock} in hand` : null]
                        .filter(Boolean).join(' · ')
                      : [item.gstin, item.phone, item.state_name].filter(Boolean).join(' · ')
                        || 'nothing else on the file'}
                  </Text>
                </View>
                <Text style={[{ fontSize: 14.5, fontWeight: '700', color: C.ink }, S.num]}>
                  {ready?.what === 'items'
                    ? `₹${fmt0(item.sale_price)}`
                    : (item.opening_balance ? `₹${fmt0(item.opening_balance)}` : '')}
                </Text>
              </View>
            )} />
        </Screen>
      </Modal>

      {busy === 'saving' && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
                       backgroundColor: '#3B3A35AA', alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700', marginTop: 12 }}>Saving…</Text>
        </View>
      )}
    </Screen>
  );
}
