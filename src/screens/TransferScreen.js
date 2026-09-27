import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Modal, FlatList,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';
import { readPickedFile } from '../lib/pickfile';
import { readFileLines } from '../lib/bigfile';
import { saveBook, bookLoader, sayWhatWentOut, sayWhatCameBack, totalOf } from '../lib/booksave';

import { supabase, allRows as pageAll } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { useApp } from '../AppContext';
import { fmt0, showDate, today } from '../lib/money';
import { vouchersFromTallyXml, checkBook } from '../lib/tallybook';
import { loadBook, planLoad } from '../lib/tallyload';
import {
  sniff, itemsFromCsv, partiesFromCsv, itemsFromTallyXml, partiesFromTallyXml, planImport,
  priceLevelsInTally, applyPriceLevel, mergeFiles,
  itemsToCsv, partiesToCsv, billsToCsv, billLinesToCsv, tallyVouchersXml, goesToTally,
  paymentsToCsv, expensesToCsv, balancesToCsv, stockToCsv, bookToCsv,
  looksMangled, base64ToBytes, decodeBytes,
  ITEMS_TEMPLATE, PARTIES_TEMPLATE,
} from '../lib/transfer';
import { BackButton, Bar, Foot, Head, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// ===========================================================================
//  WHAT HAS BEEN BROUGHT IN, AND TAKING ANY OF IT BACK OUT.
//
//  An import writes hundreds of rows in one press. Until now there was no way
//  to see that it had happened, and no way at all to undo it -- the wrong
//  file, the wrong period, or last week's file a second time meant unpicking
//  it by hand, a bill at a time, which is not a way at all.
//
//  Every row an import writes carries the mark of the run that wrote it, so
//  one press can take the whole run back out. It asks first, in figures: what
//  goes, and what stays behind and why.
// ===========================================================================

function History({ org, navigation }) {
  const [runs, setRuns] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = React.useCallback(() => {
    supabase.from('import_runs').select('*').order('started_at', { ascending: false }).limit(40)
      .then(({ data, error }) => setRuns(error ? [] : (data || [])));
  }, []);
  React.useEffect(load, [load]);

  // TWO SETS OF NAMES FOR THE SAME FIVE THINGS.
  // A Tally import counts what it wrote as bills, money, moves, items, names.
  // A book put back a page at a time counts by table, because that is what it
  // is sent one page of at a time. Both end up here, and reading only one set
  // meant a restored book showed in this list with no figures against it at
  // all -- which looks exactly like nothing having happened.
  const shape = (c = {}) => [
    (c.bills ?? c.vouchers) ? `${c.bills ?? c.vouchers} bills` : null,
    (c.money ?? c.payments) ? `${c.money ?? c.payments} money entries` : null,
    (c.moves ?? c.stock_moves) ? `${c.moves ?? c.stock_moves} movements` : null,
    c.items ? `${c.items} items` : null,
    (c.names ?? c.parties) ? `${c.names ?? c.parties} names` : null,
  ].filter(Boolean).join(' \u00b7 ');

  // A RESTORE THAT STOPPED HALF WAY IS NOT AN IMPORT, and import_undo is the
  // wrong tool for it: it was written to take out what a Tally import writes,
  // and a restore also writes bank accounts, expenses and opening balances,
  // every one of which undo leaves behind to be written a second time. The
  // server has a function that takes out exactly what a restore put in, so
  // that is the one used.
  const clearRestore = async (r) => {
    Alert.alert('Clear what went in?',
      'That restore did not finish. This takes out everything it did put in — '
      + 'every bill, name, item, bank account and expense — and leaves the firm '
      + 'empty again, ready to try the same file from the start.',
      [{ text: 'Leave it' },
       { text: 'Clear it out', style: 'destructive', onPress: async () => {
          setBusy(r.id);
          const { data, error } = await supabase.rpc('book_restore_clear', { p_run: r.id });
          setBusy(null);
          if (error) return Alert.alert('Could not clear it', sayPlainly(error));
          load();
          const n = data?.removed || {};
          Alert.alert('Cleared', `${shape(n) || 'Nothing'} removed. `
            + 'The firm is empty again — press Put a book back with the same file.');
       } }]);
  };

  const undo = async (r) => {
    if (r.kind === 'backup' && !r.done_at) return clearRestore(r);
    setBusy(r.id);
    const { data: plan, error } = await supabase.rpc('import_undo_plan', { p_run: r.id });
    setBusy(null);
    if (error) return Alert.alert('Could not read that import', sayPlainly(error));

    const goes = shape(plan.goes) || 'nothing';
    const st = plan.stays || {};
    const staying = [
      st.locked_bills ? `${st.locked_bills} bills sit in a month you have closed` : null,
      st.noted_bills ? `${st.noted_bills} bills have a credit note against them` : null,
      st.used_items ? `${st.used_items} items are used by something you wrote yourself` : null,
      st.used_names ? `${st.used_names} names are used by something you wrote yourself` : null,
    ].filter(Boolean);

    Alert.alert('Take it all back out?',
      `This removes ${goes} that came in from that file.\n\n`
      + 'Anything you have written yourself since stays exactly as it is.'
      + (staying.length ? `\n\nThese stay too:\n\u2022 ${staying.join('\n\u2022 ')}` : ''),
      [{ text: 'Leave it' },
       { text: 'Take it out', style: 'destructive', onPress: async () => {
          setBusy(r.id);
          const { data, error: e2 } = await supabase.rpc('import_undo', { p_run: r.id });
          setBusy(null);
          if (e2) return Alert.alert('Could not take it out', sayPlainly(e2));
          load();
          Alert.alert('Taken out', data?.already
            ? 'That one had already been taken out.'
            : `${shape(data?.removed) || 'Nothing'} removed. Your books are as they were before it.`);
       } }]);
  };

  if (runs === null) {
    return <ActivityIndicator color={C.accent} style={{ marginTop: 30 }} />;
  }
  if (!runs.length) {
    return (
      <View style={{ marginTop: 20 }}>
        <Text style={S.eyebrow}>Nothing has been brought in yet</Text>
        <Text style={{ fontSize: 13.5, color: C.muted, marginTop: 8, lineHeight: 20 }}>
          Every import you make is listed here afterwards, with what it brought and a
          button that takes the whole lot back out again. That is worth knowing before
          you press anything under Bring in: nothing you do there is one-way.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text style={S.eyebrow}>What has been brought in</Text>
      {runs.map((r) => {
        const done = !!r.done_at;
        const gone = !!r.undone_at;
        return (
          <View key={r.id} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 11,
                                    backgroundColor: C.surface, padding: 13, marginTop: 10 }}>
            <Text style={{ fontSize: 15, fontWeight: '700',
                           color: gone ? C.faint : C.ink }}>
              {r.note || (r.kind === 'daybook' ? 'Tally day book'
                        : r.kind === 'masters' ? 'Names and goods from Tally'
                        : r.kind === 'backup' ? 'A whole book put back' : 'A spreadsheet')}
            </Text>
            <Text style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 17 }}>
              {showDate(String(r.started_at).slice(0, 10))}
              {shape(r.counts) ? ` \u00b7 ${shape(r.counts)}` : ''}
              {!done && !gone ? ' \u00b7 did not finish' : ''}
            </Text>

            {gone ? (
              <Text style={{ fontSize: 12.5, color: C.faint, marginTop: 8 }}>
                Taken back out on {showDate(String(r.undone_at).slice(0, 10))}
                {r.undo_note ? ` \u2014 ${r.undo_note}` : ''}
              </Text>
            ) : (
              <TouchableOpacity onPress={() => undo(r)} disabled={busy === r.id}
                style={{ alignSelf: 'flex-start', marginTop: 11, paddingHorizontal: 12,
                         paddingVertical: 8, borderRadius: 9, borderWidth: 1,
                         borderColor: C.danger, opacity: busy === r.id ? 0.5 : 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: C.danger }}>
                  {busy === r.id ? 'One moment\u2026'
                    : (r.kind === 'backup' && !r.done_at) ? 'Clear what went in'
                    : 'Take it all back out'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
      <Text style={[S.hint, { marginTop: 18, lineHeight: 18 }]}>
        Taking an import out never touches a month you have closed, a bill a credit note
        has been raised against, or an item or a name that something you wrote yourself
        now uses. Those are listed before it goes ahead and left where they are.
      </Text>
    </View>
  );
}

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
// A TABLE NAME IS OURS, NOT HIS. While a book is moving he should see what is
// moving in his own words -- "customers and suppliers", not "parties".
const PLAIN = {
  godowns: 'Stores',
  bank_accounts: 'Bank accounts',
  parties: 'Customers and suppliers',
  items: 'Items',
  item_parts: 'What items are made of',
  standing_items: 'Opening balances',
  expense_heads: 'Expense heads',
  vouchers: 'Bills',
  voucher_lines: 'Bill lines',
  payments: 'Money in and out',
  expenses: 'Expenses',
  stock_moves: 'Stock movements',
  invoice_series: 'Bill numbers',
};

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

  // WHAT A DAY BOOK WOULD BRING IN, SHOWN BEFORE ANYTHING IS WRITTEN.
  //
  // Bringing a shop's whole history across is the one import that cannot be
  // undone by hand: ninety bills, ninety-two receipts and six transfers, into
  // books he is going to file returns from. So it is read, checked and laid
  // out in full FIRST, and nothing is written at all. He looks at the
  // figures, and only then is there anything to agree to.
  const [dayBook, setDayBook] = useState(null);
  const [bringing, setBringing] = useState(null);   // { done, total } while it runs

  // A WHOLE BOOK MOVING, WHICH TAKES LONG ENOUGH TO NEED A BAR.
  // { way: 'out' | 'in', label, done, total }
  const [copying, setCopying] = useState(null);
  const [range, setRange] = useState('month');
  const [tab, setTab] = useState('in');
  const [ready, setReady] = useState(null);   // what was read, waiting to be confirmed
  const [seeAll, setSeeAll] = useState(false); // the whole list of it, not five rows
  const [basisOk, setBasisOk] = useState(false); // he has told us these ARE closing figures
  // Rename Skwik's two price lists after the Tally levels he picked. On by
  // default when they differ, because "Wholesale / Retail" sitting over rates
  // that came off "Dealer / Counter" is a label that lies.
  const [renameLists, setRenameLists] = useState(true);

  // The preview lists ROWS, and for a many-file import the rows are the
  // products — the names are counted beside them. Every place that asked
  // "is this an item import?" has to answer yes for that case too, or the
  // products get shown in the shape of a customer: a GST number and a phone
  // where the HSN and the rate belong.
  const showsItems = ready ? (ready.what === 'items' || ready.what === 'both') : false;

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

  // THE WHOLE BOOK, IN A FORM SKWIK CAN READ BACK.
  //
  // Everything above this is a report: useful to a man and useless to a
  // machine. This is the rows themselves. A shop pays for Skwik by the year,
  // and it has to be able to leave with what it has written -- a new phone, a
  // firm started again, or the day it stops paying us.
  const exportBackup = async () => {
    setBusy('backup');
    setCopying({ way: 'out', label: 'Starting…', done: 0, total: 0 });
    try {
      const name = `skwik-backup-${(org?.name || 'shop').replace(/[^A-Za-z0-9]+/g, '-')}`
                 + `-${today()}.skwik.json`;

      // WRITTEN INTO THE FILE AS IT ARRIVES, NOT BUILT UP AND THEN WRITTEN.
      //
      // The old way asked the server for the whole book in one call and then
      // turned the answer into a file. Measured on a shop with two years in it
      // that is 105 MB of answer and about 340 MB of phone memory at the
      // moment the file is written -- more than a cheap Android gives one app,
      // and when it runs out it does not slow down, it dies. This asks for a
      // page, appends it, and lets it go. Measured on that same shop: 0.6 MB
      // held at the worst moment, for the same 105 MB file.
      // AND LAST MONTH'S COPY GOES FIRST.
      // A copy of a two-year book is 105 MB and it is written into the phone's
      // scratch folder. One a month, each named for its day, and a year later
      // there is a gigabyte of old copies on a phone that had 8 GB to begin
      // with. He asked about space; this is where it would have gone.
      try {
        for (const old of new Directory(Paths.cache).list()) {
          if (/^skwik-backup-.*\.skwik\.json$/.test(old.name || '')) old.delete();
        }
      } catch (e) { /* nothing there, or the folder will not list */ }

      const file = new File(Paths.cache, name);
      try { if (file.exists) file.delete(); } catch (e) { /* first time through */ }
      file.create();

      const { wrote } = await saveBook({
        supabase,
        put: (text) => { file.write(text, { append: true }); },
        onStep: ({ table, done, total }) =>
          setCopying({ way: 'out', label: PLAIN[table] || table, done, total }),
      });

      setCopying(null);
      if (!(await Sharing.isAvailableAsync())) {
        return Alert.alert('Nothing to share with',
          'This phone has no app set up to receive files. The copy is made — '
          + 'set up Drive or WhatsApp and try again.');
      }
      await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: name });

      Alert.alert('That is your whole book', `${sayWhatWentOut(wrote)}\n\n`
        + 'Keep it somewhere you will find it — not only on this phone. Skwik can put '
        + 'the whole thing back from this one file, into a firm with nothing in it.');
    } catch (e) {
      Alert.alert('Could not take the copy', sayPlainly(e));
    } finally { setCopying(null); setBusy(null); }
  };

  // AND PUTTING ONE BACK. Into a firm with nothing in it, and it says so
  // plainly rather than trying to be clever about what wins.
  //
  // THIS PICKED THE FILE WRONG AND HAD NEVER WORKED. It called the file reader
  // with the list of file types where the reader wants the file itself, so the
  // one button a shop presses on the worst day of its life -- a new phone,
  // everything riding on one file -- failed before it read a byte. The picker
  // is opened here, properly, the way every other import on this screen does.
  const restoreBackup = async () => {
    let asset;
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true, type: ['application/json', 'text/plain', '*/*'],
      });
      if (res.canceled) return;
      asset = res.assets?.[0];
      if (!asset?.uri) return;
    } catch (e) { return Alert.alert('Could not open the file picker', sayPlainly(e)); }

    // THE FIRST LINE ALONE, which says what kind of file this is and how much
    // of it there is -- read without touching the rest, so the question on
    // screen can be asked in figures before anything at all is written.
    let head = null;
    try {
      await readFileLines(asset.uri, (line) => {
        try { const o = JSON.parse(line); if (Number(o?.skwik_backup) === 2) head = o; }
        catch (e) { /* not a line-by-line backup */ }
        return 'stop';
      });
    } catch (e) { /* no streaming reader on this phone: fall through */ }

    if (head) return restoreInPages(asset, head);
    return restoreWholeFile(asset);
  };

  // A BOOK PUT BACK A PAGE AT A TIME. Nothing is ever held but the page.
  const restoreInPages = (asset, head) => {
    const many = head.how_many || {};
    Alert.alert('Put this book back?',
      `${sayWhatWentOut(many)}\n`
      + `Taken on ${showDate(String(head.taken_at || '').slice(0, 10))}`
      + `${head.org?.name ? ` from ${head.org.name}` : ''}.\n\n`
      + 'It goes into this firm, which must have nothing in it. Nothing you have '
      + 'written is ever written over.',
      [{ text: 'Not now' },
       { text: 'Put it back', onPress: async () => {
          setBusy('restore');
          setCopying({ way: 'in', label: 'Starting…', done: 0, total: totalOf(head) });
          try {
            const loader = bookLoader({
              supabase,
              onStep: ({ table, done, total }) =>
                setCopying({ way: 'in', label: PLAIN[table] || table, done, total }),
            });
            let n = 0, stop = false;
            const feed = async (line) => {
              n += 1;
              const what = await loader.line(line, n);
              if (what === 'not-ours') { stop = true; return 'stop'; }
              return undefined;
            };
            if (asset.lines) {
              for (const line of asset.lines) { if (await feed(line) === 'stop') break; }
            } else {
              const went = await readFileLines(asset.uri, feed);
              if (!went) throw new Error('This phone cannot read a file a piece at a time.');
            }
            if (stop) throw new Error('That file is not a Skwik backup.');
            const counts = await loader.finish();
            setCopying(null);
            await reloadOrg();
            Alert.alert('It is back', `${sayWhatCameBack(counts)}\n\n`
              + 'Check a few bills before you carry on. If something is wrong, '
              + 'this shows under What came in, and one press takes it all out again.');
          } catch (e) {
            Alert.alert('Could not put it back', sayPlainly(e));
          } finally { setCopying(null); setBusy(null); }
       } }]);
  };

  // AND THE OLDER KIND OF FILE -- one big document -- still goes in, the way
  // it always did. Nobody's backup stops working because we found a better
  // shape for the next one.
  const restoreWholeFile = async (asset) => {
    let text;
    try { text = await readPickedFile(asset.uri); }
    catch (e) { return Alert.alert('Could not open that file', sayPlainly(e)); }

    // A PAGE-BY-PAGE FILE ON A PHONE THAT CANNOT READ PIECES.
    //
    // A page-by-page backup is one page per line, so it is not one JSON
    // document and JSON.parse on the whole of it fails -- which would have told
    // him his own backup was "not a Skwik backup". It has already been read
    // whole by the time we are here, so the lines are simply fed through in
    // memory: no cheaper, and it works.
    const first = String(text).split('\n', 1)[0];
    if (/"skwik_backup"\s*:\s*2/.test(first)) {
      const lines = String(text).split('\n').filter((l) => l.trim());
      let head = null;
      try { head = JSON.parse(lines[0]); } catch (e) { head = null; }
      if (head) return restoreInPages({ uri: asset.uri, lines }, head);
    }

    let book;
    try { book = JSON.parse(text); } catch (e) {
      return Alert.alert('That is not a Skwik backup', 'The file could not be read as one.');
    }
    if (Number(book?.skwik_backup) !== 1) {
      return Alert.alert('That is not a Skwik backup',
        'A backup file is the one Skwik writes under Send out, named .skwik.json.');
    }

    Alert.alert('Put this book back?',
      `${(book.vouchers || []).length} bills, ${(book.payments || []).length} money entries, `
      + `${(book.items || []).length} items and ${(book.parties || []).length} names, `
      + `taken on ${showDate(String(book.taken_at || '').slice(0, 10))}.\n\n`
      + 'It goes into this firm, which must have nothing in it. Nothing is written over.',
      [{ text: 'Not now' },
       { text: 'Put it back', onPress: async () => {
          setBusy('restore');
          const { data, error } = await supabase.rpc('book_restore', { p: book });
          setBusy(null);
          if (error) return Alert.alert('Could not put it back', sayPlainly(error));
          await reloadOrg();
          const n = data?.put_back || {};
          Alert.alert('It is back',
            `${n.bills || 0} bills, ${n.money || 0} money entries, ${n.items || 0} items `
            + `and ${n.names || 0} names.`);
       } }]);
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

      // AN EXPORT THAT IS QUIETLY SHORT IS WORSE THAN ONE THAT FAILS.
      //
      // allRows() throws when the server says no, so the four paged reads
      // below stop the whole export if anything goes wrong. The two RPCs did
      // not: their error was dropped and the file was written anyway — a
      // party-balances sheet with no parties in it, a cash book with no cash
      // book, both looking exactly like a shop that has none. This is the copy
      // he hands his accountant and keeps as his backup, so a missing figure
      // has to stop it rather than pass unnoticed.
      const [pays, exps, items, balR, stock, bookR] = await Promise.all([
        allRows(money), allRows(spend),
        allRows(() => supabase.from('items').select('*').order('name').order('id')),
        supabase.rpc('party_balances'),
        allRows(() => supabase.from('stock_in_hand').select('*').order('name').order('item_id')),
        // the cash book is asked for whole here: this is the accountant's
        // copy, not a screen, so the limit is lifted rather than paged
        supabase.rpc('money_book', { p_from: from || '2000-04-01', p_to: to || today(),
                                     p_account: null, p_cash: true, p_limit: 1000000 }),
      ]);
      if (balR?.error) throw balR.error;
      if (bookR?.error) throw bookR.error;
      const bal = balR?.data;
      const cashBook = bookR?.data;

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

  // THIS USED TO BE DONE HERE, IN THE APP, AND IT COULD NOT WORK.
  //
  // It read every row out, wrote them to a file, and put them back by
  // upserting each one under THE ID IT LEFT WITH. An id is unique across
  // the whole of Skwik, so if the firm the file came from still exists --
  // which is the ordinary case, a new phone or a second firm -- every id in
  // the file is already taken. Each row either did nothing or tried to move
  // somebody else’s row into this firm, which row security then refused.
  // Either way the book did not come back.
  //
  // Both halves now happen in the database, in one call each. The copy is
  // the rows themselves; putting it back gives every row a fresh id and
  // rebuilds every reference through a map, so the book comes back whole
  // whether or not the firm it came from is still there. It goes into a
  // firm with nothing in it and says so rather than guessing what wins.
  // See exportBackup and restoreBackup above.

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

      // WHAT IT IS ABOUT TO DO, BEFORE IT DOES IT.
      //
      // The sheet said how many rows were READ and nothing about what would
      // become of them. So an import that quietly added five hundred new
      // items beside the five hundred he already had — because not one name
      // matched letter for letter — looked exactly like an import that
      // updated them. He found out days later, from the rates being wrong.
      //
      // The same plan the save uses is worked out here and shown to him. If
      // it says nothing will be updated, he knows before he taps anything.
      let plan = null;
      try {
        const table = what === 'items' ? 'items' : 'parties';
        const mine = await pageAll(() => supabase.from(table).select('id, name').order('id'));
        plan = planImport({ rows: read.rows, have: mine, what, orgId: org.id });
      } catch (e) { /* no signal: the sheet simply does not show the line */ }

      setReady({ what, rows: read.rows, name: asset.name || 'the file',
                 plan,
                 noRate: read.noRate || 0, skipped: read.skipped || 0,
                 level2: '',
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

  // EVERYTHING FROM TALLY, IN ONE GO.
  //
  // Which single Tally export carries the rates is a question with no stable
  // answer: All Masters gives the price list NAMES and, very often, not one
  // rate against them, because the levels are masters of their own and the
  // rates live in the Price List report. So stop asking for one file. He
  // exports what he likes — ledgers, stock items, the price list, XML or
  // spreadsheet — picks them all at once, and Skwik works out what each one
  // is and joins them together by name.
  // GATEWAY -> DISPLAY -> DAY BOOK -> EXPORT, which is where the history is.
  // The masters file he may already have imported holds the items and the
  // names; this one holds what happened.
  const pickDayBook = async () => {
    setBusy('in-book');
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: false, type: '*/*',
      });
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset?.uri) return Alert.alert('Could not open that', 'No file came back.');

      const text = await readPickedFile(asset.uri);
      if (!/<VOUCHER[\s>]/i.test(text)) {
        return Alert.alert('No transactions in that file',
          'That looks like a Tally file, but it holds only masters \u2014 the items '
          + 'and the names. The transactions come from Gateway \u2192 Display \u2192 '
          + 'Day Book, then Export as XML.');
      }

      const book = vouchersFromTallyXml(text);

      // WHAT THE SHOP ALREADY HAS, so the report can say how many names and
      // items would be NEW rather than listing all of them as if the shop
      // were empty. Asked for here rather than held on the screen, because
      // this is the only place that wants it and it is one read.
      const [mine, theirs, stores] = await Promise.all([
        pageAll(() => supabase.from('items').select('name').eq('is_active', true)).catch(() => []),
        pageAll(() => supabase.from('parties').select('name')).catch(() => []),
        supabase.from('godowns').select('name').then((r) => r.data || []).catch(() => []),
      ]);
      const report = checkBook(book, {
        items: (mine || []).map((x) => x.name),
        parties: (theirs || []).map((x) => x.name),
        godowns: (stores || []).map((x) => x.name),
      });
      setDayBook({ book, report, name: asset.name || 'your day book',
                   have: { items: mine || [], parties: theirs || [], godowns: stores || [] } });
    } catch (e) {
      Alert.alert('Could not read that file', sayPlainly(e));
    } finally { setBusy(''); }
  };

  // BRINGING IT IN, ONCE HE HAS SEEN WHAT IT IS.
  //
  // Everything written here carries an id worked out from Tally's own id for
  // that voucher, and the database refuses a second write of an id it already
  // holds — so pressing this twice costs nothing but the wait. That is worth
  // saying to him plainly, because the fear of pressing it twice is exactly
  // what makes a man press it twice.
  const bringItIn = () => {
    if (!dayBook) return;
    const { book, report } = dayBook;
    if (report.stop.length) {
      return Alert.alert('Put these right first',
        report.stop.slice(0, 5).join('\n')
        + (report.stop.length > 5 ? `\n+ ${report.stop.length - 5} more` : ''));
    }
    const plan = planLoad(book, {
      items: (dayBook.have?.items || []).map((x) => x.name),
      parties: (dayBook.have?.parties || []).map((x) => x.name),
      godowns: (dayBook.have?.godowns || []).map((x) => x.name),
    });
    Alert.alert('Put all this into your books?',
      `${plan.bills} bill${plan.bills === 1 ? '' : 's'}, ${plan.payments} money `
      + `entr${plan.payments === 1 ? 'y' : 'ies'}`
      + (plan.transfers ? `, ${plan.transfers} stock move${plan.transfers === 1 ? '' : 's'}` : '')
      + `.\n\n${plan.newItems.length} new item${plan.newItems.length === 1 ? '' : 's'} and `
      + `${plan.newParties.length} new name${plan.newParties.length === 1 ? '' : 's'} will be added. `
      + 'Anything already here is left alone.\n\nIf it stops halfway, press it again — '
      + 'nothing is ever written twice.',
      [{ text: 'Not yet' }, { text: 'Bring it in', onPress: doBring }]);
  };

  const doBring = async () => {
    setBringing({ done: 0, total: 0 });
    try {
      const out = await loadBook({
        supabase, org, book: dayBook.book,
        onStep: ({ done, total }) => setBringing({ done, total }),
      });
      setDayBook(null);
      Alert.alert('It is in your books',
        [out.bills && `${out.bills} bill${out.bills === 1 ? '' : 's'}`,
         out.already && `${out.already} already there`,
         out.payments && `${out.payments} money entries`,
         out.transfers && `${out.transfers} stock moves`,
         out.items && `${out.items} new items`,
         out.parties && `${out.parties} new names`]
          .filter(Boolean).join('\n')
        + '\n\nLook at Past bills and Ledgers to check it against Tally.');
    } catch (e) {
      // HOW FAR IT GOT, not just that it failed. Everything already written
      // is whole and correct; pressing it again carries on from there.
      const m = e && e.made;
      Alert.alert('It stopped partway',
        `${sayPlainly(e)}\n\n`
        + (m ? `Written so far: ${m.bills} bills, ${m.payments} money entries, `
             + `${m.items} items, ${m.parties} names.\n\n` : '')
        + 'Nothing written is wrong. Press Bring it in again and it will carry '
        + 'on from where it stopped.');
    } finally { setBringing(null); }
  };

  const pickMany = async () => {
    setBusy('in-all');
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: false, type: '*/*', multiple: true,
      });
      if (res.canceled) return;
      const assets = res.assets || [];
      if (!assets.length) return Alert.alert('Could not open that', 'No file came back.');

      const files = [];
      for (const a of assets) {
        if (!a?.uri) continue;
        try { files.push({ name: a.name || 'a file', text: await readPickedFile(a.uri) }); }
        catch (e) { files.push({ name: a.name || 'a file', text: '' }); }
      }

      const out = mergeFiles(files, { level: '', level2: '' });
      if (!out.items.length && !out.parties.length) {
        // RATES WITH NOTHING TO SIT ON. He picked the price list and only the
        // price list — which is not "nothing we could use", it is half the
        // job, and saying the wrong one of those wastes his morning.
        const gotRates = out.notes.some((n) => /rates for/.test(n.found));
        return Alert.alert(gotRates ? 'Only the price list' : 'Nothing we could use',
          out.notes.map((n) => `${n.file}: ${n.found}`).join('\n')
          + (gotRates
            ? '\n\nRates on their own cannot be brought in — there is nothing for '
              + 'them to sit on. Export the stock items from Tally as well, and pick '
              + 'both files here together.'
            : '')
          + '\n\nFrom Tally, export the ledgers, the stock items and the price '
          + 'list. XML and CSV both work, and so does Tally\'s own Export to Excel. '
          + 'A file saved as .xlsx from Excel itself cannot be opened here — save '
          + 'it as CSV and pick it again.');
      }

      let plan = null, planP = null;
      try {
        if (out.items.length) {
          const mine = await pageAll(() => supabase.from('items').select('id, name').order('id'));
          plan = planImport({ rows: out.items, have: mine, what: 'items', orgId: org.id });
        }
        if (out.parties.length) {
          const mine = await pageAll(() => supabase.from('parties').select('id, name').order('id'));
          planP = planImport({ rows: out.parties, have: mine, what: 'parties', orgId: org.id });
        }
      } catch (e) { /* no signal: the sheet simply does not show those lines */ }

      setBasisOk(false);
      setReady({
        what: 'both', rows: out.items, parties: out.parties,
        name: files.map((f) => f.name).join(', '),
        kind: `${files.length} file${files.length === 1 ? '' : 's'}`,
        notes: out.notes, levels: out.levels, level: '', level2: '',
        noRate: out.noRate, skipped: out.skipped, orphanRates: out.orphanRates,
        basis: out.basis, plan, planP,
      });
    } catch (e) {
      Alert.alert('Could not read those files', String(e?.message || e));
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
  const useLevel = (level, which = 1) => {
    if (!ready) return;
    setReady((r) => {
      const lv1 = which === 1 ? level : (r.level || '');
      const lv2 = which === 2 ? level : (r.level2 || '');
      const rows = applyPriceLevel(r.rows, lv1, lv2);
      // The count of items with no rate belongs to the list he just picked,
      // not to the one the file was first read on.
      return { ...r, level: lv1, level2: lv2, rows,
               noRate: rows.filter((x) => !x.sale_price).length };
    });
    if (which === 1) {
      supabase.from('orgs').update({ tally_price_level: level || null })
        .eq('id', org.id).then(() => {}, () => {});
    }
  };

  // Names already in the book are updated, new ones are added. Nothing is
  // ever duplicated and nothing is ever removed.
  const commit = async () => {
    const { what, rows, level, level2 } = ready;
    setReady(null);
    setBusy('saving');
    try {
      // THE NAMES OF THE LISTS, NOT JUST THE RATES OFF THEM.
      //
      // The rates arrived under headings that said Wholesale and Retail
      // whatever Tally called them, so the bill screen offered him two lists
      // whose names had nothing to do with the prices behind them. If he
      // picked Tally levels, Skwik takes their names as well.
      if ((what === 'items' || what === 'both') && renameLists && (level || level2)) {
        const patch = {};
        if (level)  patch.price1_name = String(level).trim().slice(0, 24);
        if (level2) patch.price2_name = String(level2).trim().slice(0, 24);
        try {
          await supabase.from('orgs').update(patch).eq('id', org.id);
          await reloadOrg?.();
        } catch (e) { /* the rates matter more than the labels */ }
      }

      // TWO TABLES IN ONE GO when he picked several files. Products first: a
      // name to sell to is no use without the goods to sell him.
      if (what === 'both') {
        const done = [];
        for (const pair of [['items', rows], ['parties', ready.parties || []]]) {
          const table2 = pair[0], list = pair[1];
          if (!list.length) continue;
          const mine = await pageAll(() => supabase.from(table2).select('id, name').order('id'));
          const pl = planImport({ rows: list, have: mine, what: table2, orgId: org.id });
          for (let i = 0; i < pl.toUpdate.length; i += 100) {
            const { error } = await supabase.from(table2)
              .upsert(pl.toUpdate.slice(i, i + 100).map((u) => ({ id: u.id, ...u.body })),
                      { onConflict: 'id' });
            if (error) throw error;
          }
          for (let i = 0; i < pl.toAdd.length; i += 100) {
            const { error } = await supabase.from(table2).insert(pl.toAdd.slice(i, i + 100));
            if (error) throw error;
          }
          done.push(`${table2 === 'items' ? 'Products' : 'Names'}: `
            + `${pl.added} new, ${pl.updated} updated`);
        }
        Alert.alert('Done', `${done.join('\n')}\n\nNothing was removed.`);
        return;
      }

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
      </Bar>

      {/* THREE JOBS, THREE TABS.
          This screen was one long scroll doing four unrelated things: reading
          a file in, writing files out, and no way at all to see what had been
          brought in before or to take any of it back out. Khata, Stock and
          Reports each got split and each got better; this is the same cut. */}
      <View style={[S.row, { gap: 6, paddingHorizontal: 16, paddingTop: 12,
                             paddingBottom: 4 }]}>
        {[['in', 'Bring in'], ['out', 'Send out'], ['log', 'History']].map(([k, label]) => {
          const on = tab === k;
          return (
            <TouchableOpacity key={k} onPress={() => setTab(k)}
              style={{ paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999,
                       borderWidth: 1, borderColor: on ? C.ink : C.line,
                       backgroundColor: on ? C.ink : 'transparent' }}>
              <Text style={{ fontSize: 13, fontWeight: '700',
                             color: on ? C.bg : C.muted }}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        {tab === 'log' && <History org={org} navigation={navigation} />}

        {tab === 'in' && (<>
        <Text style={S.eyebrow}>Bring your book in</Text>
        {/* WHAT HE ACTUALLY DID, AND WHAT CAME OF IT.
            He exported "Masters" whole, as the old wording invited, and what
            came out had nothing in it Skwik could use -- a Masters export is
            groups, voucher types, currencies and units, with the ledgers and
            the stock items somewhere inside it -- and it was big enough to run
            his phone out of memory besides. Export the two lists on their own
            and both problems go away. The menu was renamed in TallyPrime, so
            both names are given rather than one that half of them cannot
            find. */}
        <Text style={{ fontSize: 13, color: C.muted, marginBottom: 6, lineHeight: 19 }}>
          From Tally, export the lists one at a time, not Masters all together:
          Gateway → Chart of Accounts → Ledgers → Export → XML (in older Tally,
          Gateway → Display → List of Accounts). Stock items the same way.
          Or any spreadsheet saved as CSV. A name already here is updated,
          never duplicated.
        </Text>

        <Row busy={busy} label="Items" busyKey="in-items" onPress={() => pick('items')}
          note="Name, HSN, unit, rates and GST. Headings need not match exactly — Particulars, Rate and Per are all understood." />
        <Row busy={busy} label="Customers and suppliers" busyKey="in-parties" onPress={() => pick('parties')}
          note="Name, GST number, phone and what they owed you before. The GST number fills in the state, which decides IGST." />

        <Row busy={busy} label="Everything from Tally, in one go" busyKey="in-all"
          onPress={pickMany}
          note="Export the ledgers, the stock items and the price list from Tally — XML, or CSV, or Tally&apos;s own Export to Excel — then pick them ALL here together. Skwik reads each one, works out what it holds, and joins the rates onto the products by name. A real .xlsx it cannot open, and it will say so." />

        <Row busy={busy} label="Past transactions from Tally" busyKey="in-book"
          onPress={pickDayBook}
          note="Gateway &#8594; Display &#8594; Day Book &#8594; Export as XML. Bills, receipts, payments and stock moved between stores. Skwik reads it and shows you every figure BEFORE anything is written." />

        {!!dayBook && (() => {
          const { book, report } = dayBook;
          const c = report.counts;
          const money = (n) => `\u20B9${fmt0(n)}`;
          const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);
          const sales = book.vouchers.filter((v) => v.vtype === 'sale');
          const buys  = book.vouchers.filter((v) => v.vtype === 'purchase');
          const rec   = book.payments.filter((p) => p.ptype === 'receipt');
          const pay   = book.payments.filter((p) => p.ptype === 'payment');
          const days  = book.vouchers.concat(book.payments)
            .map((v) => v.vdate).filter(Boolean).sort();
          // how many distinct items and names the file mentions at all
          const seen = (arr) => new Set(arr.filter(Boolean)
            .map((x) => String(x).trim().toLowerCase())).size;
          const itemsSeen = seen(book.vouchers.flatMap((v) => (v.lines || []).map((l) => l.item)));
          const namesSeen = seen(book.vouchers.map((v) => v.party)
            .concat(book.payments.map((p) => p.party)));
          const Line2 = ({ k, v, tone }) => (
            <View style={[S.row, { marginBottom: 5, alignItems: 'baseline' }]}>
              <Text style={{ flex: 1, fontSize: 13.5, color: tone || C.ink }}>{k}</Text>
              <Text style={[{ fontSize: 13.5, fontWeight: '700', color: tone || C.ink }, S.num]}>
                {v}
              </Text>
            </View>
          );
          return (
            <View style={[S.card, { marginTop: 10 }]}>
              <Text style={S.eyebrow}>What is in {dayBook.name}</Text>
              {!!days.length && (
                <Text style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
                  {showDate(days[0])} to {showDate(days[days.length - 1])}
                </Text>
              )}

              <Line2 k={`${c.bills} bill${c.bills === 1 ? '' : 's'}`} v="" />
              {!!sales.length && (
                <Line2 k={`   ${sales.length} sales`} v={money(sum(sales, (v) => v.total))} />
              )}
              {!!buys.length && (
                <Line2 k={`   ${buys.length} purchases`} v={money(sum(buys, (v) => v.total))} />
              )}
              {!!rec.length && (
                <Line2 k={`${rec.length} received`} v={money(sum(rec, (p) => p.amount))} />
              )}
              {!!pay.length && (
                <Line2 k={`${pay.length} paid`} v={money(sum(pay, (p) => p.amount))} />
              )}
              {!!c.transfers && (
                <Line2 k={`${c.transfers} moved between stores`} v="" />
              )}
              {!!c.skipped && (
                <Line2 k={`${c.skipped} left out`} v="" tone={C.muted} />
              )}

              <View style={{ height: 10 }} />
              {/* MATCHED AND NEW, SIDE BY SIDE.
                  It said how many were new and left the rest to be inferred.
                  A name that should have matched and did not is the commonest
                  way an import goes wrong -- one Ganesh Store becomes two, and
                  his udhar is split between them -- and the moment to catch it
                  is here, before anything is written, not afterwards. */}
              <Text style={S.eyebrow}>Names and goods in the file</Text>
              <Line2 k={`Items \u00b7 ${itemsSeen - report.newItems.length} already yours`}
                     v={`${report.newItems.length} new`} />
              <Line2 k={`Names \u00b7 ${namesSeen - report.newParties.length} already yours`}
                     v={`${report.newParties.length} new`} />
              {!!report.newGodowns.length && (
                <Line2 k="Stores not here yet" v={String(report.newGodowns.length)} />
              )}

              {/* WHAT IS LEFT OUT, AND WHY — never a silent drop. */}
              {!!book.skipped.length && (
                <>
                  <View style={{ height: 10 }} />
                  <Text style={S.eyebrow}>Left out, and why</Text>
                  {[...new Set(book.skipped.map((x) => x.why))].slice(0, 6).map((w) => (
                    <Text key={w} style={{ fontSize: 12.5, color: C.muted, marginBottom: 3 }}>
                      {'\u00B7 '}{book.skipped.filter((x) => x.why === w).length} {'\u2014'} {w}
                    </Text>
                  ))}
                </>
              )}

              {!!report.stop.length && (
                <View style={{ marginTop: 12, padding: 11, borderRadius: 10,
                               backgroundColor: C.dangerSoft || C.flagSoft,
                               borderWidth: 1, borderColor: C.danger }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: C.danger }}>
                    {report.stop.length} thing{report.stop.length === 1 ? '' : 's'} to put right first
                  </Text>
                  {report.stop.slice(0, 6).map((x, i) => (
                    <Text key={i} style={{ fontSize: 12.5, color: C.danger, marginTop: 4, lineHeight: 17 }}>
                      {'\u00B7 '}{x}
                    </Text>
                  ))}
                </View>
              )}

              {!!report.warn.length && (
                <View style={{ marginTop: 10, padding: 11, borderRadius: 10,
                               backgroundColor: C.flagSoft, borderWidth: 1, borderColor: C.flagLine }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: C.flagInk }}>
                    {report.warn.length} worth a look
                  </Text>
                  {report.warn.slice(0, 5).map((x, i) => (
                    <Text key={i} style={{ fontSize: 12.5, color: C.flagInk, marginTop: 4, lineHeight: 17 }}>
                      {'\u00B7 '}{x}
                    </Text>
                  ))}
                  {report.warn.length > 5 && (
                    <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 4 }}>
                      + {report.warn.length - 5} more
                    </Text>
                  )}
                </View>
              )}

              {bringing ? (
                <View style={{ marginTop: 14 }}>
                  <View style={[S.row, { gap: 10 }]}>
                    <ActivityIndicator size="small" color={C.accent} />
                    <Text style={{ fontSize: 14, fontWeight: '700', color: C.ink }}>
                      {bringing.total
                        ? `${bringing.done} of ${bringing.total}`
                        : 'Starting\u2026'}
                    </Text>
                  </View>
                  {/* A BAR, BECAUSE A NUMBER ALONE DOES NOT LOOK LIKE MOVEMENT
                      on a slow pack, and this can take a minute. */}
                  <View style={{ height: 6, borderRadius: 3, marginTop: 8,
                                 backgroundColor: C.line, overflow: 'hidden' }}>
                    <View style={{ height: 6, borderRadius: 3, backgroundColor: C.accent,
                                   width: `${bringing.total
                                     ? Math.round((bringing.done / bringing.total) * 100) : 3}%` }} />
                  </View>
                  <Text style={[S.hint, { marginTop: 8 }]}>
                    Leave this on the screen until it finishes.
                  </Text>
                </View>
              ) : (
                <>
                  <Text style={[S.hint, { marginTop: 12, lineHeight: 18 }]}>
                    Nothing has been written yet. Everything above is only what the
                    file holds.
                  </Text>
                  <TouchableOpacity onPress={bringItIn}
                    style={[S.btn, { marginTop: 12 },
                            !!report.stop.length && { backgroundColor: C.faint }]}>
                    <Text style={S.btnText}>
                      {report.stop.length ? 'Put the problems right first' : 'Bring it in'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setDayBook(null)} style={{ paddingTop: 12 }}>
                    <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.muted,
                                   textAlign: 'center' }}>
                      Not now
                    </Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          );
        })()}

        </>)}

        {tab === 'out' && (<>
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

        <Row busy={busy} label="Your whole book, in one file" busyKey="backup" onPress={exportBackup}
          note="Not a report — the rows themselves. Your firm, your items, your customers, every bill and every line, the money and the stock. Skwik can put the whole thing back from this one file, so your book is yours to take anywhere." />
        <Row busy={busy} label="Put a book back" busyKey="restore" onPress={restoreBackup} tone="quiet"
          note="Into a firm with nothing in it: a new phone, or a firm started again. Every row comes back with the bills still pointing at the same customers and the same goods. Nothing you have written is ever written over." />

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
        </>)}
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
                    {ready.what === 'both'
                      ? `${fmt0(ready.rows.length)} products, ${fmt0((ready.parties || []).length)} names`
                      : `${fmt0(ready.rows.length)} ${showsItems ? 'items' : 'names'} read`}
                  </Text>
                  <Text style={{ fontSize: 13, color: C.muted, marginTop: 6, lineHeight: 19 }}>
                    From {ready.name}, which looks like {ready.kind}. Nothing is saved yet.
                  </Text>
                </View>

                <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8 }}>

                {/* TALLY KEEPS AS MANY PRICE LEVELS AS HE LIKES. SKWIK BILLS
                    ON TWO, and every customer sits on one of them. So the
                    question is which Tally level is which — and the second one
                    was never asked at all, which is why his second rate came
                    in empty every single time. */}
                {showsItems && ready.levels?.length > 0 && (
                  <View style={{ marginTop: 14 }}>
                    {[1, 2].map((slot) => {
                      const picked = slot === 1 ? (ready.level || '') : (ready.level2 || '');
                      const skwik = slot === 1 ? (org?.price1_name || 'Wholesale')
                                               : (org?.price2_name || 'Retail');
                      return (
                        <View key={slot} style={{ marginBottom: 10 }}>
                          <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.ink }}>
                            {slot === 1 ? 'Rate 1' : 'Rate 2'} — now called “{skwik}” in Skwik
                          </Text>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                            {[''].concat(ready.levels).map((lv) => {
                              const on = picked === lv;
                              return (
                                <TouchableOpacity key={(lv || 'none') + slot}
                                  onPress={() => useLevel(lv, slot)}
                                  style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9,
                                           borderWidth: 1, borderColor: on ? C.accent : C.line,
                                           backgroundColor: on ? C.accentSoft : C.surface }}>
                                  <Text style={{ fontSize: 13, fontWeight: '600',
                                                 color: on ? C.accent : C.muted }}>
                                    {lv || (slot === 1 ? 'Newest rate' : 'Leave empty')}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        </View>
                      );
                    })}

                    {/* HIS OWN WORDS: you already have the price list, put those
                        names into Skwik's price list tab. */}
                    {(!!ready.level || !!ready.level2) && (
                      <TouchableOpacity onPress={() => setRenameLists((v) => !v)}
                        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9,
                                 marginTop: 2, marginBottom: 4 }}>
                        <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5,
                                       alignItems: 'center', justifyContent: 'center', marginTop: 1,
                                       borderColor: renameLists ? C.accent : C.greyB,
                                       backgroundColor: renameLists ? C.accent : 'transparent' }}>
                          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
                            {renameLists ? '✓' : ''}
                          </Text>
                        </View>
                        <Text style={{ flex: 1, fontSize: 12.5, color: C.muted, lineHeight: 17 }}>
                          Call Skwik's two price lists{' '}
                          <Text style={{ fontWeight: '700', color: C.ink }}>
                            {ready.level || 'Rate 1'}
                          </Text>{' and '}
                          <Text style={{ fontWeight: '700', color: C.ink }}>
                            {ready.level2 || 'Rate 2'}
                          </Text>
                          , the same as in Tally, so the names on the bill screen
                          match the rates behind them.
                        </Text>
                      </TouchableOpacity>
                    )}

                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2, lineHeight: 16 }}>
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

                {/* WHAT EACH FILE HELD. An import that quietly ignored a file
                    he picked is exactly how this went wrong for a week. */}
                {!!ready.notes?.length && (
                  <View style={{ marginTop: 14, padding: 12, borderRadius: 12,
                                 borderWidth: 1, borderColor: C.line, backgroundColor: C.surface }}>
                    <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.ink }}>
                      What was in each file
                    </Text>
                    {ready.notes.map((n, i) => (
                      <View key={i} style={[S.row, { marginTop: 5, gap: 8 }]}>
                        <Text numberOfLines={1}
                          style={{ flex: 1, fontSize: 12, color: C.muted }}>{n.file}</Text>
                        <Text style={{ fontSize: 12, fontWeight: '700',
                                       color: /nothing/.test(n.found) ? C.flagInk : C.ink }}>
                          {n.found}
                        </Text>
                      </View>
                    ))}
                    {!!ready.orphanRates && (
                      <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 7, lineHeight: 16 }}>
                        {fmt0(ready.orphanRates)} rate{ready.orphanRates === 1 ? '' : 's'} had no
                        product of that name to sit on — a price list that is ahead of the item
                        list, or a name spelled differently in the two files.
                      </Text>
                    )}
                  </View>
                )}

                {!!ready.planP && (
                  <View style={{ marginTop: 10, padding: 12, borderRadius: 12,
                                 borderWidth: 1.5, borderColor: C.line, backgroundColor: C.surface }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: C.ink }}>
                      Names: {fmt0(ready.planP.updated)} updated · {fmt0(ready.planP.added)} added
                    </Text>
                  </View>
                )}

                {/* THE ONE LINE THAT MATTERS BEFORE HE TAPS SAVE. */}
                {!!ready.plan && (
                  <View style={{ marginTop: 14, padding: 12, borderRadius: 12,
                                 borderWidth: 1.5,
                                 borderColor: ready.plan.updated ? C.line : C.flagLine,
                                 backgroundColor: ready.plan.updated ? C.surface : C.flagSoft }}>
                    <Text style={{ fontSize: 14.5, fontWeight: '800',
                                   color: ready.plan.updated ? C.ink : C.flagInk }}>
                      {fmt0(ready.plan.updated)} updated  ·  {fmt0(ready.plan.added)} added as new
                    </Text>
                    {!ready.plan.updated && ready.plan.added > 0 ? (
                      <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 4, lineHeight: 17 }}>
                        Nothing in your book matches a name in this file, so all of
                        these come in as NEW rows beside what you already have —
                        and the ones you bill on keep their old figures. If these
                        are the same {showsItems ? 'items' : 'names'} under
                        different spellings, rename them in Tally or in Skwik so
                        they line up, then bring the file in again.
                      </Text>
                    ) : (
                      <Text style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 17 }}>
                        Updated means {showsItems ? 'an item' : 'a name'} already
                        in your book takes this file's figures. Nothing is ever removed.
                        {ready.plan.loose
                          ? ` ${fmt0(ready.plan.loose)} matched on spelling alone — “Steel (A)” to “STEEL A”.`
                          : ''}
                      </Text>
                    )}
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
                      Anything already in your book KEEPS the selling price you
                      set yourself — the file is silent about these, and silence
                      does not overwrite. Ones that are new to you arrive with
                      the rate blank, rather than with what you PAID for them: a
                      bill written off that price gives the goods away.
                      {ready.levels?.length > 1
                        ? ' Tally only holds a rate on the lists you actually set, so try another list above.'
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
                        {showsItems
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
                      {ready.what === 'both'
                        ? `Bring in ${fmt0(ready.rows.length)} products and ${fmt0((ready.parties || []).length)} names`
                        : `Bring in ${fmt0(ready.rows.length)} ${showsItems ? 'items' : 'names'}`}
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
          <Head onBack={() => setSeeAll(false)}
                title={ready
                  ? `${fmt0(ready.rows.length)} ${showsItems ? 'items' : 'names'}`
                  : ''} />
          <FlatList
            data={ready?.rows || []}
            keyExtractor={(r, i) => `${r.name}|${i}`}
            initialNumToRender={20}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
            ListHeaderComponent={
              <Text style={{ fontSize: 12.5, color: C.muted, paddingVertical: 12, lineHeight: 18 }}>
                {showsItems
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
                    {showsItems
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
                  {showsItems
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

      {/* A WHOLE BOOK MOVING.
          Two years of bills takes the better part of a minute, and a spinner
          that says nothing for a minute is how a shopkeeper decides the app
          has hung and kills it — in the middle of a restore. So it says what
          it is carrying, how far along it is, and not to leave the screen. */}
      {!!copying && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
                       backgroundColor: '#3B3A35EE', alignItems: 'center',
                       justifyContent: 'center', paddingHorizontal: 30 }}>
          <View style={{ width: '100%', backgroundColor: C.surface, borderRadius: 14,
                         padding: 20 }}>
            <Text style={{ fontSize: 16.5, fontWeight: '800', color: C.ink }}>
              {copying.way === 'out' ? 'Taking your book out' : 'Putting your book back'}
            </Text>
            <View style={[S.row, { gap: 10, marginTop: 12, alignItems: 'center' }]}>
              <ActivityIndicator size="small" color={C.accent} />
              <Text style={{ flex: 1, fontSize: 14, fontWeight: '700', color: C.ink }}>
                {copying.label}
              </Text>
              <Text style={[{ fontSize: 13, color: C.muted }, S.num]}>
                {copying.total
                  ? `${fmt0(copying.done)} of ${fmt0(copying.total)}`
                  : fmt0(copying.done)}
              </Text>
            </View>
            <View style={{ height: 6, borderRadius: 3, marginTop: 10,
                           backgroundColor: C.line, overflow: 'hidden' }}>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: C.accent,
                             width: `${copying.total
                               ? Math.min(100, Math.round((copying.done / copying.total) * 100))
                               : 3}%` }} />
            </View>
            <Text style={[S.hint, { marginTop: 12, lineHeight: 18 }]}>
              {copying.way === 'out'
                ? 'It is written into the file as it comes, so a big book does not have to fit in the phone at once. Leave this on the screen until it finishes.'
                : 'Leave this on the screen until it finishes. If it stops part way, press Put a book back again with the same file — it clears what went in and starts clean.'}
            </Text>
          </View>
        </View>
      )}
    </Screen>
  );
}
