import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Alert, BackHandler,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase, allRows } from '../lib/supabase';
import { sayPlainly, withTimeout } from '../lib/offline';
import { useApp } from '../AppContext';
import { parseQuery } from '../lib/search';
import { fmt0, num, settle, today } from '../lib/money';
import { Box, Head, KeyForm, Screen, Sections, Swipe, useSectionSwipe }
  from '../components/Chrome';
import { CalButton } from '../components/DatePick';
import { C, S } from '../theme';

// MONEY IN, MONEY OUT — and putting it right when it was typed wrong.
//
// A wrong amount used to stay wrong for ever, and the customer's account
// stayed wrong with it. Recent entries are listed below the form now: tap one
// to correct it, or remove it.
//
// The receipts a cash bill writes by itself are shown but never edited here.
// They belong to the bill, and changing the bill is what changes them.

const dmy = (d) => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(2, 4)}`;

export default function MoneyScreen({ route, navigation }) {
  const ptype    = route.params?.ptype || 'receipt';
  const received = ptype === 'receipt';
  const { org, isOwner } = useApp();

  const [parties, setParties] = useState([]);
  const [recent, setRecent]   = useState([]);
  const [text, setText]   = useState('');
  const [party, setParty] = useState(null);
  const [mode, setMode]   = useState('cash');
  const [amount, setAmount] = useState('');
  const [note, setNote]   = useState('');
  // WHEN THE MONEY ACTUALLY MOVED.
  //
  // A receipt entered on Monday for cash taken on Saturday belongs on
  // Saturday, or the customer's account and the day book both read wrong.
  // Only the owner may put a date on it: a man at the counter backdating his
  // own entries is how a till is emptied quietly.
  const [pdate, setPdate] = useState(today());
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount]   = useState(null);   // which bank account

  // MANY AT ONCE, THE WAY A LEDGER IS WRITTEN UP.
  //
  // A shopkeeper sitting down in the evening with a day's slips does not want
  // to walk the same four fields twenty times. He wants to say "cash, today"
  // once and then write name, amount, name, amount down the page — which is
  // exactly what a receipts register is. Each line is held here until he
  // saves the lot, and they go in as one batch.
  // ONE WAY OF WRITING MONEY DOWN, NOT TWO.
  //
  // This opened on a single entry with "Write several at once" underneath, so
  // the commoner job -- an evening's slips, name and figure down the page --
  // cost a tap to reach every time. The register is now the screen itself, and
  // a single payment is one line typed on it: the same two boxes, one tap
  // fewer, and one screen to learn instead of two.
  //
  // The single form is still here and still reached: `editing` shows it when
  // he taps an entry already written, which is a different job from writing a
  // new one and wants the whole screen to itself.
  //
  // blankRow() is declared further down this component, so the first row is
  // written out here rather than called -- a lazy initialiser still runs
  // inside this render, before that line.
  const [batch, setBatch] = useState([{ key: Date.now() + Math.random(), name: '', amount: '' }]);
  const [dateOpen, setDateOpen] = useState(false);
  const gridRef = useRef({});        // every box in the grid, so tab can walk it
  const [onRow, setOnRow] = useState(null);   // which line's name box is being typed in
  const [editing, setEditing] = useState(null);   // the entry being corrected
  const [busy, setBusy]   = useState(false);

  // who → how much → what it was against
  const fWho = useRef(null), fAmt = useRef(null), fNote = useRef(null);
  const fDate = useRef(null);

  const load = useCallback(async () => {
    // The names are paged: past 1,000 of them the rest could not be picked.
    // The recent list below is deliberately short and stays as it is.
    //
    // allRows THROWS where a plain query resolved with an error, so one bad
    // signal used to take the whole screen down — no names, no recent
    // payments, no bank accounts, and no message either. Each part now
    // answers for itself and the screen shows whatever arrived.
    const [ps, { data: rs }, { data: bs }] = await Promise.all([
      allRows(() => supabase.from('parties').select('*').order('name').order('id'))
        .catch(() => []),
      supabase.from('payments')
        .select('*, parties(name)')
        .eq('ptype', ptype)
        .order('pdate', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(40),
      supabase.from('bank_accounts').select('*').eq('is_active', true).order('name'),
    ]);
    setParties(ps || []);
    setRecent(rs || []);
    const list = bs || [];
    setAccounts(list);
    setAccount((a) => a || list.find((x) => x.is_default)?.id || list[0]?.id || null);
  }, [ptype]);

  useFocusEffect(useCallback(() => { load().catch(() => {}); }, [load]));

  // BACK LEAVES THE SCREEN, as it does on any other form.
  //
  // The register used to be a page inside this screen, reached from the single
  // entry, and back had to close it first or the phone threw him all the way
  // home and lost the lines he had written. The register is the screen now, so
  // there is nothing behind it to step back to and nothing to intercept.
  // Back leaves the screen, as it does on any other form. There is no longer a
  // single-entry page behind the register to step back to.
  const leaveBatch = useCallback(() => false, []);

  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', leaveBatch);
    return () => sub.remove();
  }, [leaveBatch]));

  // ONE LINE, THE WAY A BILL TAKES ONE.
  //
  // "Like we do in line for sale/purchase entries item name and quantity, we
  // should do for receipt and payment also." Quite — the bill has taken
  // "thali 12" for a long time and it is the fastest thing in the app, and
  // there is no reason money should be two boxes and a tap when it can be one
  // line: "ganesh 5000".
  //
  // It is the SAME reader the bill uses, so anything he has learned there
  // works here: ganesh 5000, ganesh x5000, ganesh 2500+2500.
  const asked = useMemo(() => parseQuery(text), [text]);
  // THE NAME AS HE TYPED IT, NOT AS THE READER LOWERCASED IT.
  //
  // parseQuery lowercases everything, which is right for matching and wrong for
  // a name being written into his books: "Ganesh Store 5000" put a customer
  // called "ganesh store" in his list, and it would have stayed like that.
  // `base` is always a prefix of the tidied line, so the original casing is
  // still there to be cut at the same place.
  const tidy = String(text).trim().replace(/\s+/g, ' ');
  const nameOnly = (asked.base ? tidy.slice(0, asked.base.length) : tidy).trim() || tidy;
  const askedAmt = asked.qty;

  const matches = nameOnly && !party
    ? parties.filter((p) => p.name.toLowerCase().includes(nameOnly.toLowerCase())).slice(0, 5)
    : [];

  // PICKING A NAME CARRIES THE FIGURE WITH IT.
  //
  // The amount is put in only when he actually typed one and has not already
  // typed something into the amount box himself, so a figure he is in the
  // middle of correcting is never overwritten under his thumb.
  // AND IT DOES NOT FIGHT THE BOX FOR THE CURSOR.
  //
  // Box already moves the cursor on to whatever comes next when Enter is
  // pressed. These lines moved it again, 80ms later, to the amount box -- so
  // with the date row open he pressed Enter, landed in the date, and was
  // yanked out of it a moment later with no idea why. Two things calling
  // focus() for one keypress. It only reaches for the amount box now when
  // nothing is between here and there.
  const goToAmount = () => {
    if (isOwner && dateOpen) return;
    setTimeout(() => fAmt.current?.focus(), 80);
  };

  const choose = (pp) => {
    setParty(pp);
    setText(pp.name);
    if (askedAmt && !String(amount).trim()) setAmount(String(askedAmt));
    goToAmount();
  };

  // A NAME HE HAS NEVER TAKEN MONEY FROM BEFORE.
  //
  // "rahul 18000" read perfectly, said "rahul \u00b7 \u20b918,000" back to him,
  // and then stopped dead: there was no Rahul to tap, and the figure was only
  // ever carried into the amount box by TAPPING a name. So the one-line entry
  // worked for people already in the book and did nothing at all for everybody
  // else -- and a walk-in handing over cash is precisely the case where the
  // name is new. He had to type the eighteen thousand a second time.
  //
  // The name is not created here. Saving already creates one when there is no
  // match, which is the right place for it: nothing is written until he
  // presses Save.
  const takeAsNew = () => {
    if (askedAmt && !String(amount).trim()) setAmount(String(askedAmt));
    setText(nameOnly);
    setParty(null);
    goToAmount();
  };

  const clear = () => {
    setEditing(null); setParty(null); setText(''); setAmount(''); setNote('');
    setMode('cash'); setPdate(today()); setDateOpen(false);
  };

  // just the name and the amount, for the next line of a batch
  const clearLine = () => { setParty(null); setText(''); setAmount(''); setNote(''); };

  const startEdit = (p) => {
    if (p.ref_voucher_id) {
      return Alert.alert('This one came from a bill',
        'It was written when you saved a cash bill. To change it, change that '
        + 'bill under Past bills — the cash follows it.');
    }
    setEditing(p);
    setParty({ id: p.party_id, name: p.parties?.name || '' });
    setText(p.parties?.name || '');
    setMode(p.mode || 'cash');
    setAmount(String(Number(p.amount)));
    setNote(p.note || '');
    setPdate(p.pdate || today());
  };

  // Opened from a party's ledger: bring that entry straight up for correcting,
  // so tapping an amount in the ledger lands on the entry behind it and not on
  // a list he has to search through again.
  const wantId = route.params?.paymentId;
  useEffect(() => {
    if (!wantId) return;
    let on = true;
    (async () => {
      const { data } = await supabase.from('payments')
        .select('*, parties(name)').eq('id', wantId).maybeSingle();
      if (on && data) startEdit(data);
    })();
    return () => { on = false; };
  }, [wantId]);

  const save = async () => {
    if (!party && !text.trim()) {
      return Alert.alert('Who?', received ? 'Type who paid you.' : 'Type who you paid.');
    }

    // "RAHUL 18000" IS ONE LINE, AND SAVE UNDERSTOOD NEITHER HALF OF IT.
    //
    // The whole point of this box is that a receipt is written the way a bill
    // line is: name and figure together. The screen read it back to him
    // correctly -- "rahul · ₹18,000" -- and then save() looked only at `text`
    // and at the amount box, and did two wrong things at once:
    //
    //   the button said Save ₹0 and refused him with "Amount? Type how much",
    //   with the eighteen thousand sitting on the screen above it
    //
    //   and if he filled the amount box by hand, the party created was called
    //   "rahul 18000" -- a new name, with a space and a figure in it, in his
    //   books for ever, and the real Rahul still owed the money
    //
    // The figure only ever moved across if he tapped a suggestion. So both
    // halves of the line are honoured here, at the last moment, where every
    // road into save() passes.
    const willAsk = num(amount) > 0 ? num(amount) : num(askedAmt);
    const willName = (party?.name || nameOnly || text).trim();
    if (willAsk <= 0) return Alert.alert('Amount?', 'Type how much.');

    const when = isOwner ? (pdate || today()) : today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) {
      return Alert.alert('Check the date', 'Write it as 2026-09-20.');
    }
    if (when > today()) {
      return Alert.alert('That date has not happened yet',
        'Money cannot be entered against a day still to come.');
    }
    if (org?.books_locked_upto && when <= org.books_locked_upto) {
      return Alert.alert('Books are closed to that date',
        `Everything up to ${dmy(org.books_locked_upto)} is closed. Open the books `
        + 'again under Settings, or date this on a later day.');
    }

    // MONEY THROUGH THE BANK HAS TO SAY WHICH BANK.
    //
    // This wrote account_id: null whenever no account was chosen, and a
    // receipt with mode 'bank' and no account is in the payments table and in
    // NO bank book -- so the firm's total is right, the bank's own page shows
    // its opening balance with nothing underneath, and the trial balance
    // cannot foot. On his own live book that came to 25 entries worth
    // 8,20,400, found months later by a migration rather than by the screen
    // that wrote them.
    //
    // Expenses have refused this since the day they were written. Money, which
    // is used a hundred times more often, did not.
    if (mode === 'bank' && !account) {
      return Alert.alert('Which bank?',
        'Say which bank account this went through, or mark it as Cash. Money '
        + 'put through "bank" with no account named lands in no bank book at '
        + 'all, and then nothing adds up.');
    }

    setBusy(true);
    try {
      // EVERY CALL ON THIS SCREEN GETS A CLOCK PUT ON IT.
      //
      // There was none. On a weak line the button sat on "Saving…" until the
      // phone itself gave up, which can be a minute, with a customer waiting
      // and no way to tell whether the money had gone in. Seven seconds, then
      // a sentence he can act on.
      let p = party;
      if (!p?.id) {
        // THE NAME, NOT THE LINE. See the note at the top of save().
        const hit = parties.find((x) => x.name.toLowerCase() === willName.toLowerCase());
        if (hit) p = hit;
        else {
          const { data, error } = await withTimeout(supabase.from('parties').insert({
            org_id: org.id, name: willName, kind: received ? 'customer' : 'supplier',
            state_code: org.state_code, state_name: org.state_name,
          }).select().single());
          // This used to read .data straight off the result. When the insert
          // failed there was no data, and the next line asked an undefined
          // thing for its id — so a lost signal came out as a programmer's
          // error message instead of "check your internet".
          if (error || !data) throw (error || new Error('offline'));
          p = data;
        }
      }

      const body = {
        org_id: org.id, ptype, party_id: p.id, mode,
        amount: willAsk, note: note.trim() || null,
        pdate: isOwner ? (pdate || today()) : today(),
        account_id: mode === 'bank' ? account : null,
      };

      if (editing) {
        const { error } = await withTimeout(
          supabase.from('payments').update(body).eq('id', editing.id));
        if (error) throw error;
        clear(); await load();
        Alert.alert('Changed', `Now ₹${fmt0(willAsk)}.`);
      } else {
        const { error } = await withTimeout(supabase.from('payments').insert(body));
        if (error) throw error;
        // STAY HERE. A man taking money at the counter takes it from four
        // people in a row; throwing him into one customer's account after
        // each one means four journeys back. The entry appears in the list
        // below within the same second, which is confirmation enough.
        clear(); await load();
        setTimeout(() => fWho.current?.focus(), 80);
      }
    } catch (e) {
      Alert.alert('Could not save', sayPlainly(e));
    } finally { setBusy(false); }
  };

  /* ---------------- writing many at once ---------------- */

  const blankRow = () => ({ key: Date.now() + Math.random(), name: '', amount: '' });


  const setRow = (key, patch) => setBatch((b) => {
    const next = (b || []).map((r) => (r.key === key ? { ...r, ...patch } : r));
    // the page never runs out of lines: the moment the last one is written in,
    // a fresh empty one appears under it
    const last = next[next.length - 1];
    if (last && (last.name.trim() || String(last.amount).trim())) next.push(blankRow());
    return next;
  });

  const dropRow = (key) => setBatch((b) => {
    const next = (b || []).filter((r) => r.key !== key);
    return next.length ? next : [blankRow()];
  });

  // tab off the amount: on to the next line's name, making one if needed
  const nextLine = (i) => {
    setBatch((b) => {
      const next = [...(b || [])];
      if (i === next.length - 1) next.push(blankRow());
      setTimeout(() => gridRef.current[`n${next[i + 1].key}`]?.focus(), 40);
      return next;
    });
  };

  const filledRows = (batch || []).filter((r) => r.name.trim() && num(r.amount) > 0);

  // NAMES OFFERED AS HE TYPES, LINE BY LINE.
  //
  // A register is written from memory and from slips, and a shopkeeper types
  // three letters of a name he has used a hundred times. Nothing is offered
  // once the name is already exactly right — a list that stays open over the
  // next line is worse than no list.
  const rowHits = (r) => {
    const t = (r.name || '').trim().toLowerCase();
    if (!t || onRow !== r.key) return [];
    if (parties.some((p) => p.name.toLowerCase() === t)) return [];
    return parties
      .filter((p) => p.name.toLowerCase().includes(t)
                  || String(p.phone || '').includes(t))
      .sort((a, b) => {
        const A = a.name.toLowerCase(), B = b.name.toLowerCase();
        return (A.startsWith(t) ? 0 : 1) - (B.startsWith(t) ? 0 : 1) || A.localeCompare(B);
      })
      .slice(0, 5);
  };

  const takeHit = (r, p) => {
    setRow(r.key, { name: p.name });
    setOnRow(null);
    setTimeout(() => gridRef.current[`a${r.key}`]?.focus(), 40);
  };

  const saveBatch = async () => {
    const lines = filledRows.map((r) => ({
      key: r.key, party: null, name: r.name.trim(), amount: num(r.amount), note: null,
    }));
    if (!lines.length) {
      return Alert.alert('Nothing written yet', 'Put a name and an amount on a line first.');
    }

    const when = isOwner ? (pdate || today()) : today();
    if (when > today()) {
      return Alert.alert('That date has not happened yet',
        'Money cannot be entered against a day still to come.');
    }
    if (org?.books_locked_upto && when <= org.books_locked_upto) {
      return Alert.alert('Books are closed to that date',
        `Everything up to ${dmy(org.books_locked_upto)} is closed.`);
    }
    // and the same for twenty lines at once -- see the note on the single save
    if (mode === 'bank' && !account) {
      return Alert.alert('Which bank?',
        'Say which bank account these went through, or mark them as Cash. Money '
        + 'put through "bank" with no account named lands in no bank book at '
        + 'all, and then nothing adds up.');
    }

    setBusy(true);
    let made = 0, failed = 0, firstError = '';
    try {
      // Names that are not in the book yet are created first, so twenty lines
      // do not become twenty round trips of guesswork.
      const rowsToWrite = [];
      for (const l of lines) {
        let p = l.party;
        if (!p?.id) {
          const hit = parties.find((x) => x.name.toLowerCase() === l.name.toLowerCase());
          if (hit) p = hit;
          else {
            const { data, error } = await supabase.from('parties').insert({
              org_id: org.id, name: l.name,
              kind: received ? 'customer' : 'supplier',
              state_code: org.state_code, state_name: org.state_name,
            }).select().single();
            if (error) { failed++; if (!firstError) firstError = error.message; continue; }
            p = data;
          }
        }
        rowsToWrite.push({
          org_id: org.id, ptype, party_id: p.id, mode,
          amount: l.amount, note: l.note, pdate: when,
          account_id: mode === 'bank' ? account : null,
        });
      }

      if (rowsToWrite.length) {
        const { error } = await supabase.from('payments').insert(rowsToWrite);
        if (error) throw error;
        made = rowsToWrite.length;
      }

      setBatch([blankRow()]); clearLine(); setDateOpen(false); await load();
      Alert.alert(failed ? 'Mostly done' : 'Written',
        `${made} ${received ? 'receipt' : 'payment'}${made === 1 ? '' : 's'} `
        + `on ${dmy(when)}, ₹${fmt0(rowsToWrite.reduce((a, r) => a + r.amount, 0))} in all.`
        + (failed ? `\n\n${failed} could not be written — ${firstError}` : ''));
    } catch (e) {
      Alert.alert('Could not save', sayPlainly(e));
    } finally { setBusy(false); }
  };

  const remove = (p) => {
    if (p.ref_voucher_id) {
      return Alert.alert('This one came from a bill',
        'Remove the bill under Past bills and this goes with it.');
    }
    Alert.alert(
      `Remove ₹${fmt0(p.amount)}?`,
      `${received ? 'Received from' : 'Paid to'} ${p.parties?.name || 'them'} on ${dmy(p.pdate)}.\n\n`
      + "Their account goes back to what it was before this entry.",
      [{ text: 'Keep it' },
       { text: 'Remove', style: 'destructive', onPress: async () => {
           const { error } = await supabase.from('payments').delete().eq('id', p.id);
           if (error) return Alert.alert('Could not remove it', sayPlainly(error));
           if (editing?.id === p.id) clear();
           load();
         } }]);
  };

  const Pick = ({ v, label }) => (
    <TouchableOpacity onPress={() => setMode(v)} style={{
      flex: 1, height: 64, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
      borderWidth: 1.5, borderColor: mode === v ? C.accent : C.line,
      backgroundColor: mode === v ? C.accentSoft : C.surface }}>
      <Text style={{ fontSize: 17, fontWeight: '700', color: mode === v ? C.accent : C.muted }}>
        {label}
      </Text>
    </TouchableOpacity>
  );


  // SLIDING AWAY FROM A HALF-WRITTEN ENTRY WOULD THROW IT AWAY.
  //
  // A chip change replaces the screen, so an amount he has typed and not saved
  // goes with it — and a drag is far easier to do by accident than a tap on a
  // chip. So the finger moves between chips while the form is untouched, which
  // is when he is looking rather than writing, and stops the moment he starts
  // filling it in. The chips above never stop working.
  //
  // `batch !== null` STOOD FOR "THE REGISTER IS OPEN" and meant it until the
  // register became the screen itself. From that moment it was true before he
  // had touched anything, so `started` was always true and the finger could
  // never move between chips at all -- the swipe was switched off on this
  // screen rather than deferred until he began writing. The question it was
  // always asking is whether any line has anything in it yet.
  const written = (batch || []).some(
    (r) => String(r.name || '').trim() || String(r.amount || '').trim());
  const started = !!party || !!String(amount).trim() || !!String(note).trim()
    || !!String(text).trim() || written || !!editing;
  const sec = useSectionSwipe(navigation, org, isOwner, received ? 'in' : 'out');
  const swipe = started ? {} : sec;

  return (
    <Screen>
      <Head navigation={navigation} title={received ? 'Money received' : 'Money paid'}
        />
      <Sections navigation={navigation} org={org} isOwner={isOwner}
                id={received ? 'in' : 'out'} />
      <Swipe {...swipe} style={{ flex: 1 }}>
      <KeyForm
                  contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

      {!!editing && (
        <View style={{ marginTop: 14, padding: 12, backgroundColor: C.flagSoft,
                       borderWidth: 1, borderColor: C.flagLine, borderRadius: 12 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.flagInk }}>
            Correcting the entry of {dmy(editing.pdate)}
          </Text>
          <TouchableOpacity onPress={clear} style={{ paddingTop: 6 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: C.accent }}>
              Leave it alone and write a new one instead
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {editing ? (
        <>
          <View style={{ height: 18 }} />
          <Text style={S.label}>{received ? 'Received from' : 'Paid to'}</Text>
          {/* onSubmitEditing, NOT onSubmit. Box moves to the next field when
              there is one and only calls onSubmit when there is not -- which is
              right on every form in the app, and meant that pressing Enter here
              jumped to the amount box and left it empty. onSubmitEditing is
              called either way, so the line is taken first and the focus still
              lands where it always did. */}
          <Box ref={fWho} next={isOwner && dateOpen ? fDate : fAmt} style={{ marginTop: 6 }}
            placeholder={received ? 'Name and amount \u2014 ganesh 5000' : 'Name and amount \u2014 bharat 5000'}
            onSubmitEditing={() => { if (matches.length) choose(matches[0]);
                                     else if (nameOnly) takeAsNew(); }}
            value={text} onChangeText={(t) => { setText(t); setParty(null); }} />

          {/* WHAT IT READ, SAID BACK TO HIM. A figure picked out of the middle
              of what he typed is worth showing before it is used, because a
              name with a number in it — "Shop 5" — would otherwise take the 5
              and say nothing. */}
          {!party && !!askedAmt && !!nameOnly && (
            <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.accent, marginTop: 6 }}>
              {nameOnly} {'\u00B7'} {'\u20B9'}{fmt0(askedAmt)}
            </Text>
          )}

          {/* NOBODY OF THAT NAME YET. The bill screen has offered "+ Add" for a
              new item since the beginning; money never did, and the line just
              ended. */}
          {!party && !!nameOnly && !matches.length && (
            <TouchableOpacity onPress={takeAsNew}
              style={{ padding: 12, backgroundColor: C.surface, borderWidth: 1,
                       borderColor: C.accent, borderStyle: 'dashed', borderRadius: 12,
                       marginTop: 6 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: C.accent }}>
                + {received ? 'Take' : 'Pay'} {'\u201C'}{nameOnly}{'\u201D'} as a new name
              </Text>
              <Text style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                {askedAmt
                  ? `\u20b9${fmt0(askedAmt)} goes in the box below. Nothing is saved until you press Save.`
                  : 'Nothing is saved until you press Save.'}
              </Text>
            </TouchableOpacity>
          )}

          {matches.map((p) => (
            <TouchableOpacity key={p.id}
              onPress={() => choose(p)}
              style={{ padding: 12, backgroundColor: C.surface, borderWidth: 1,
                       borderColor: C.line, borderRadius: 12, marginTop: 6 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: C.ink }}>{p.name}</Text>
            </TouchableOpacity>
          ))}
        </>
      ) : null}

      <View style={{ height: 18 }} />
      <Text style={S.label}>How?</Text>
      <View style={[S.row, { marginTop: 8, gap: 10 }]}>
        <Pick v="cash" label="Cash" />
        <Pick v="bank" label="Bank" />
      </View>

      {/* which account, once the shop has told us it has more than one */}
      {mode === 'bank' && (
        accounts.length ? (
          <View style={[S.row, { marginTop: 10, gap: 7, flexWrap: 'wrap' }]}>
            {accounts.map((a) => {
              const on = account === a.id;
              return (
                <TouchableOpacity key={a.id} onPress={() => setAccount(a.id)}
                  style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: 9,
                           borderWidth: 1, borderColor: on ? C.accent : C.line,
                           backgroundColor: on ? C.accentSoft : C.surface }}>
                  <Text style={{ fontSize: 13, fontWeight: '700',
                                 color: on ? C.accent : C.muted }}>{a.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : (
          <TouchableOpacity onPress={() => navigation.navigate('Banks')}
            style={{ marginTop: 10 }}>
            <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.accent }}>
              Add your bank accounts so the bank book can be kept per account ›
            </Text>
          </TouchableOpacity>
        )
      )}

      {/* THE DATE, OUT OF THE WAY.
          Nearly every entry is today's. A date box sitting open on the form
          is one more thing to read past forty times a day, so it shows as a
          single quiet line and only opens when he says so. A batch is the
          exception — writing up a day's slips in the evening is precisely
          when the date is not today, so there it stays open. */}
      {isOwner && (
        <>
          <View style={{ height: 18 }} />
          {dateOpen || batch !== null ? (
            <>
              <Text style={S.label}>When?</Text>
              <View style={[S.row, { marginTop: 6, gap: 8 }]}>
                <Box ref={fDate} next={fAmt} style={[{ flex: 1 }, S.num]}
                  keyboardType="numbers-and-punctuation" placeholder="2026-09-20"
                  value={pdate} onChangeText={setPdate} />
                <CalButton value={pdate} onPick={setPdate} max={today()}
                  title="Which day was this?" />
                <TouchableOpacity onPress={() => { setPdate(today()); setDateOpen(false); }}
                  style={[S.btnGhost, { paddingVertical: 12 }]}>
                  <Text style={S.ghostText}>Today</Text>
                </TouchableOpacity>
              </View>
              {pdate !== today() && /^\d{4}-\d{2}-\d{2}$/.test(pdate) && (
                <Text style={{ fontSize: 11.5, color: C.edit, marginTop: 5 }}>
                  Dated {dmy(pdate)}, not today. It lands in that day's book.
                </Text>
              )}
            </>
          ) : (
            <TouchableOpacity onPress={() => setDateOpen(true)} style={[S.row, { gap: 8 }]}>
              <Text style={{ fontSize: 12.5, color: C.muted, fontWeight: '600' }}>
                Dated <Text style={[S.num, { color: C.ink, fontWeight: '700' }]}>
                  {pdate === today() ? 'today' : dmy(pdate)}
                </Text>
              </Text>
              <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.accent }}>change</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      {editing ? (
        <>
          <View style={{ height: 18 }} />
          <Text style={S.label}>How much?</Text>
          {/* ENTER HERE SAVES. It used to move on to the note, which is
              optional, so a complete receipt needed a second press with nothing
              to type in between. Two presses for a whole entry -- name and
              figure, then Enter -- is the point of writing it as one line. */}
          <Box ref={fAmt} onSubmit={save}
            style={[{ marginTop: 6, fontSize: 32, paddingVertical: 14 }, S.num]}
            keyboardType="numeric" placeholder="0"
            value={amount} onChangeText={setAmount}
            onBlur={() => setAmount(settle(amount))} />

          <View style={{ height: 18 }} />
          <Text style={S.label}>What for (optional)</Text>
          <Box ref={fNote} onSubmit={save} style={{ marginTop: 6 }} placeholder="Against bill 41"
            value={note} onChangeText={setNote} />
        </>
      ) : null}

      {editing ? (
        <>
          <TouchableOpacity style={[S.btn, { marginTop: 22 }, busy && { backgroundColor: C.faint }]}
            onPress={save} disabled={busy}>
            <Text style={S.btnText}>
              {busy ? 'Saving…' : editing ? `Save the change — ₹${fmt0(num(amount))}`
                                          : `Save ₹${fmt0(num(amount) > 0 ? num(amount) : num(askedAmt))}`}
            </Text>
          </TouchableOpacity>

        </>
      ) : (
        <>
          {/* THE REGISTER, WRITTEN DOWN THE PAGE.
              Cash or bank once, the date once, and then it is just names and
              figures — tab across, tab again and you are on the next line. A
              new empty line appears the moment the last one is used, so there
              is never a button to press between entries. */}
          <View style={[S.card, { marginTop: 20, padding: 0, overflow: 'hidden' }]}>
            <View style={S.colHead}>
              <Text style={[S.colName, { width: 22 }]}>#</Text>
              <Text style={[S.colName, { flex: 1 }]}>
                {received ? 'RECEIVED FROM' : 'PAID TO'}
              </Text>
              <Text style={[S.colName, { width: 96, textAlign: 'right' }]}>AMOUNT</Text>
            </View>

            {batch.map((r, i) => {
              const hit = r.name.trim()
                ? parties.find((p) => p.name.toLowerCase() === r.name.trim().toLowerCase())
                : null;
              const isNew = r.name.trim() && !hit;
              return (
                <View key={r.key}
                  style={{ borderBottomWidth: 1, borderBottomColor: '#EDE9E0',
                           backgroundColor: i % 2 ? C.surface : '#FCFBF7' }}>
                  <View style={[S.row, { paddingHorizontal: 10, paddingVertical: 6, gap: 6 }]}>
                    <Text style={[S.num, { width: 22, fontSize: 12, color: C.faint }]}>
                      {i + 1}
                    </Text>
                    <TextInput
                      ref={(x) => { gridRef.current[`n${r.key}`] = x; }}
                      style={{ flex: 1, fontSize: 15, color: C.ink, paddingVertical: 8,
                               paddingHorizontal: 8, borderWidth: 1, borderRadius: 8,
                               borderColor: C.line, backgroundColor: '#FFFFFF' }}
                      placeholder={i === batch.length - 1 ? 'name' : ''}
                      placeholderTextColor={C.faint}
                      value={r.name}
                      returnKeyType="next" submitBehavior="submit"
                      onFocus={() => setOnRow(r.key)}
                      onSubmitEditing={() => {
                        // the first name offered is almost always the one meant
                        const h = rowHits(r);
                        if (h.length) return takeHit(r, h[0]);
                        setOnRow(null);
                        gridRef.current[`a${r.key}`]?.focus();
                      }}
                      onChangeText={(t) => setRow(r.key, { name: t })} />
                    <TextInput
                      ref={(x) => { gridRef.current[`a${r.key}`] = x; }}
                      style={[S.num, { width: 96, fontSize: 15, color: C.ink, paddingVertical: 8,
                                       paddingHorizontal: 8, borderWidth: 1, borderRadius: 8,
                                       borderColor: C.line, backgroundColor: '#FFFFFF',
                                       textAlign: 'right' }]}
                      placeholder="0" placeholderTextColor={C.faint}
                      keyboardType="numeric" value={r.amount}
                      returnKeyType="next" submitBehavior="submit"
                      onSubmitEditing={() => nextLine(i)}
                      onChangeText={(t) => setRow(r.key, { amount: t })} />
                    {batch.length > 1 && (
                      <TouchableOpacity onPress={() => dropRow(r.key)}
                        hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                        <Text style={{ fontSize: 18, color: C.faint }}>×</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {/* the names he might mean, under the line he is on */}
                  {rowHits(r).map((p) => (
                    <TouchableOpacity key={p.id} onPress={() => takeHit(r, p)}
                      style={{ marginLeft: 38, marginRight: 10, marginBottom: 6,
                               paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8,
                               borderWidth: 1, borderColor: C.line, backgroundColor: C.accentSoft }}>
                      <Text numberOfLines={1}
                        style={{ fontSize: 13.5, fontWeight: '700', color: C.ink }}>
                        {p.name}
                        {!!p.area && (
                          <Text style={{ fontWeight: '500', color: C.muted }}> · {p.area}</Text>
                        )}
                      </Text>
                    </TouchableOpacity>
                  ))}

                  {isNew && !rowHits(r).length && (
                    <Text style={{ fontSize: 10.5, color: C.edit, paddingHorizontal: 38,
                                   paddingBottom: 6 }}>
                      new name — will be added to your book
                    </Text>
                  )}
                </View>
              );
            })}

            <View style={[S.row, { paddingHorizontal: 14, paddingVertical: 11,
                                   borderTopWidth: 1.5, borderTopColor: C.ink }]}>
              <Text style={{ flex: 1, fontSize: 13, fontWeight: '700', color: C.ink }}>
                {filledRows.length} entr{filledRows.length === 1 ? 'y' : 'ies'}
                <Text style={{ fontWeight: '600', color: C.muted }}>
                  {'  '}{mode === 'bank' ? 'bank' : 'cash'} · {pdate === today() ? 'today' : dmy(pdate)}
                </Text>
              </Text>
              <Text style={[S.num, { fontSize: 18, fontWeight: '800', color: C.ink }]}>
                ₹{fmt0(filledRows.reduce((a2, l) => a2 + num(l.amount), 0))}
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={[S.btn, { marginTop: 14 },
                    (busy || !filledRows.length) && { backgroundColor: C.faint }]}
            onPress={saveBatch} disabled={busy || !filledRows.length}>
            <Text style={S.btnText}>
              {busy ? 'Writing…'
                    : `Write ${filledRows.length || ''} to the books`.replace('  ', ' ')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => {
              if (!filledRows.length) { setBatch(null); return; }
              Alert.alert('Throw the list away?',
                `${filledRows.length} line(s) have not been written to the books yet.`,
                [{ text: 'Keep it' },
                 { text: 'Throw away', style: 'destructive',
                   onPress: () => { setBatch(null); clearLine(); } }]);
            }}
            style={{ marginTop: 12, alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: C.muted }}>
              ‹ Back to one at a time
            </Text>
          </TouchableOpacity>
        </>
      )}

      {/* ---------- what was entered lately ---------- */}
      {!!recent.length && (
        <>
          <Text style={[S.eyebrow, { marginTop: 30 }]}>
            Lately — tap one to put it right
          </Text>
          {recent.map((p) => (
            <View key={p.id} style={[S.row, { paddingVertical: 12, borderBottomWidth: 1,
                                              borderBottomColor: C.line }]}>
              <TouchableOpacity style={{ flex: 1, minWidth: 0 }} onPress={() => startEdit(p)}>
                <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: C.ink }}>
                  {p.parties?.name || '—'}
                </Text>
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                  {dmy(p.pdate)} · {p.mode === 'bank' ? 'Bank' : 'Cash'}
                  {p.ref_voucher_id ? ' · from a bill' : ''}
                  {p.note ? ` · ${p.note}` : ''}
                </Text>
              </TouchableOpacity>
              <Text style={[{ fontSize: 15, fontWeight: '700', color: C.ink, marginRight: 10 },
                            S.num]}>
                {fmt0(p.amount)}
              </Text>
              <TouchableOpacity onPress={() => remove(p)}
                hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                style={{ paddingHorizontal: 6 }}>
                <Text style={{ fontSize: 20, color: p.ref_voucher_id ? C.greyB : C.danger }}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}
      </KeyForm>
      </Swipe>
    </Screen>
  );
}
