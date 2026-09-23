import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Alert, Keyboard, BackHandler,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, n2, num, today } from '../lib/money';
import { Bar, Foot, MoreButton, Screen } from '../components/Chrome';
import { ColHead, DoKey, Figure, Glyph, Rule, Words } from '../components/Register';
import {
  showExpenses, showRecon, showReports, showStock,
} from '../lib/features';
import { C, S } from '../theme';

// THE DAY BOOK.
//
// A shopkeeper opening his book does not want a dashboard. He wants to see
// what has gone through today, in the order it went through, with the money
// down the right — and he wants whatever he is about to do next to be one
// press away, not three.
//
// So this screen is his day book, ruled, with the day's total at the head of
// it, and a strip down the side holding the seven things a shop does. The box
// across the top finds anything he can name: a customer, an item, a bill
// number. No tabs, no tiles, no scrolling to find the thing he does forty
// times a day.

// One day either side, kept as the plain YYYY-MM-DD the rest of Skwik uses.
const shiftDay = (d, by) => {
  const t = new Date(`${d}T12:00:00`);
  t.setDate(t.getDate() + by);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

const rupee = (x) => `${n2(x) < 0 ? '-' : ''}${fmt0(Math.abs(n2(x)))}`;

// hh:mm out of a timestamp, in his own time, not the server's
const clock = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const VWORD = {
  sale: 'SALE', purchase: 'PURCH', estimate: 'EST',
  sale_return: 'SALE RTN', purchase_return: 'PUR RTN',
};

export default function HomeScreen({ navigation }) {
  const { org, pending, countPending, sendPending, isOwner } = useApp();
  const [sending, setSending] = useState(false);
  // NOT named `today`: that is the imported helper, and a state of the same
  // name hides it for the whole component.
  // null until the day's figures have actually arrived. Drawing a zero while
  // they are still on their way is what flashed "0" on the way back from a
  // search — and a zero is an answer a shopkeeper reads and believes.
  const [book, setBook] = useState(null);
  const [bookFailed, setBookFailed] = useState(false);
  const [sub, setSub] = useState(null);         // where the subscription stands
  const [fyTotal, setFyTotal] = useState(0);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  // WHICH DAY'S BOOK.
  //
  // It was always today's and there was no way back. A shopkeeper writing up
  // yesterday evening, or checking what Saturday came to, had nowhere to look.
  const [day, setDay] = useState(today());
  const estimate = org?.mode === 'estimate';

  /* ---------------- the day's entries ---------------- */

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      countPending?.();
      // Asked on its own so a phone that is ahead of the database still
      // gets its day book instead of an error.
      supabase.rpc('subscription_state')
        .then((r) => { if (on) setSub(r.error ? null : r.data); })
        .catch(() => {});

      try {
        const d = day;
        setBook(null);          // never show one day's entries under another's date
        const [{ data: vs }, { data: ps }] = await Promise.all([
          supabase.from('vouchers')
            .select('id, vtype, voucher_no, printed_name, total, is_cash, created_at')
            .eq('vdate', d).is('cancelled_at', null).order('created_at'),
          supabase.from('payments')
            .select('id, ptype, amount, mode, created_at, parties(name)')
            .eq('pdate', d).order('created_at'),
        ]);
        if (!on) return;

        setBookFailed(false);
        const rows = [
          ...(vs || []).map((v) => ({
            id: 'v' + v.id, at: v.created_at,
            who: v.printed_name || 'CASH',
            ref: `${VWORD[v.vtype] || v.vtype.toUpperCase()}${v.voucher_no ? ` ${v.voucher_no}` : ''}`
               + ` · ${v.is_cash ? 'cash' : 'credit'}`,
            amt: num(v.total),
            out: v.vtype === 'purchase' || v.vtype === 'sale_return',
            go: () => navigation.navigate('Bill', { voucherId: v.id }),
          })),
          ...(ps || []).map((p) => ({
            id: 'p' + p.id, at: p.created_at,
            who: p.parties?.name || 'CASH',
            ref: `${p.ptype === 'receipt' ? 'RECEIPT' : 'PAYMENT'} · ${p.mode}`,
            amt: num(p.amount),
            out: p.ptype === 'payment',
            go: () => navigation.navigate('Money',
              { ptype: p.ptype === 'receipt' ? 'receipt' : 'payment' }),
          })),
        // NEWEST FIRST, EVERYWHERE.
        // A shopkeeper opening his book wants the thing that just happened,
        // not the thing that happened at nine this morning.
        ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

        const sold = (vs || [])
          .filter((v) => v.vtype === 'sale' || v.vtype === 'estimate')
          .reduce((a, v) => a + num(v.total), 0);
        const bills = (vs || [])
          .filter((v) => v.vtype === 'sale' || v.vtype === 'estimate').length;

        setBook({ rows, sold: n2(sold), bills });

        // THE YEAR'S TURNOVER, ADDED UP WHERE THE BILLS ARE.
        //
        // This used to pull the year's bills down to the phone and add them
        // here. Supabase hands back a thousand rows at a time and nobody was
        // asking for the second page, so the figure stopped growing at a
        // thousand bills and a composition dealer would have sailed past the
        // 1.5 crore limit with the warning still showing a fraction of it.
        if (org?.is_composition) {
          const { data: fy, error: fyErr } = await supabase.rpc('fy_sales_total');
          if (on && !fyErr && fy != null) setFyTotal(num(fy));
        }
      } catch (e) {
        // A figure that could not be worked out is left standing rather than
        // drawn as nil, which reads as a day with no trade in it.
        //
        // THE DAY BOOK ITSELF IS DIFFERENT. If it could not be read, leaving
        // it empty meant the footer said "Reading the day book…" for as long
        // as the app stayed open — so a shop with no signal was told, quietly
        // and for ever, that its books were still loading. Say what happened.
        if (on) setBookFailed(true);
      }
    })();
    return () => { on = false; };
  }, [org?.is_composition, countPending, navigation, day]));

  /* ---------------- the box that finds anything ---------------- */

  // FOUR WAS NOT ENOUGH, AND IT LIED ABOUT IT.
  //
  // This box used to ask for four names, four items and four bills. Search a
  // common surname and four Sahus came back — while the fifth, the one
  // actually wanted, was simply cut off with nothing on the screen to say so.
  // A search that silently hides an answer is worse than one that finds
  // nothing, because the shopkeeper concludes the name is not in his book.
  //
  // So: enough rows that a real shop's list is not truncated, the closest
  // matches first, and a line at the foot when there are still more.
  const LOOK = 20;

  const rank = (list, t) => {
    const s2 = t.toLowerCase();
    return [...list].sort((a, b) => {
      const A = String(a.name || '').toLowerCase();
      const B = String(b.name || '').toLowerCase();
      const ea = A === s2 ? 0 : A.startsWith(s2) ? 1 : 2;
      const eb = B === s2 ? 0 : B.startsWith(s2) ? 1 : 2;
      return ea - eb || A.localeCompare(B);
    });
  };

  // FOUR QUESTIONS PER LETTER WAS FOUR TOO MANY.
  //
  // This fired the moment a key went down, so typing "ramesh" asked the
  // server twenty times and threw away the first sixteen answers — on his
  // data, on a weak line, with the results jumping about as the slower ones
  // came back out of order. It waits a quarter of a second after he stops
  // typing now, and a newer keystroke cancels an older search.
  const lookTimer = useRef(null);
  const lookSeq = useRef(0);

  const look = (text) => {
    setQ(text);
    const t = text.trim();
    if (lookTimer.current) clearTimeout(lookTimer.current);
    if (t.length < 2) { setFound(null); return; }
    lookTimer.current = setTimeout(() => { lookNow(t); }, 250);
  };

  useEffect(() => () => { if (lookTimer.current) clearTimeout(lookTimer.current); }, []);

  // A % OR AN UNDERSCORE IS A LETTER IN A NAME AND A WILDCARD IN A QUERY.
  //
  // The text went straight into ilike, so a shopkeeper typing % was shown
  // everything in his book as though it all matched, and one typing _ got
  // every three-letter name. Escaped, they match themselves, which is what
  // he meant.
  const forIlike = (t) => String(t).replace(/[\\%_]/g, (c) => `\\${c}`);

  const lookNow = async (t) => {
    const mine = ++lookSeq.current;
    const like = `%${forIlike(t)}%`;
    try {
      const [{ data: parties }, { data: items },
             { data: byNo }, { data: byName }] = await Promise.all([
        supabase.from('parties').select('id, name, kind, area, phone')
          .ilike('name', like).limit(LOOK),
        supabase.from('items').select('id, name, unit, sale_price').eq('is_active', true)
          .ilike('name', like).limit(LOOK),
        // TWO QUESTIONS, NOT ONE WITH A COMMA IN IT.
        //
        // .or() takes its conditions as one string with commas between them,
        // and the search text went straight into the middle of it. Anybody
        // searching for "Sahu, Ramesh" split the filter in half and the query
        // came back broken. Asking twice and joining the answers here has no
        // such trap in it.
        supabase.from('vouchers').select('id, vtype, voucher_no, printed_name, total, vdate')
          .is('cancelled_at', null).ilike('voucher_no', like)
          .order('vdate', { ascending: false }).limit(LOOK),
        supabase.from('vouchers').select('id, vtype, voucher_no, printed_name, total, vdate')
          .is('cancelled_at', null).ilike('printed_name', like)
          .order('vdate', { ascending: false }).limit(LOOK),
      ]);

      const seen = new Set();
      const bills = [...(byNo || []), ...(byName || [])]
        .filter((b) => (seen.has(b.id) ? false : seen.add(b.id)))
        .sort((a, b) => String(b.vdate).localeCompare(String(a.vdate)))
        .slice(0, LOOK);

      if (mine !== lookSeq.current) return;      // he has typed since; this is stale
      setFound({
        parties: rank(parties || [], t),
        items: rank(items || [], t),
        bills,
        more: (parties || []).length >= LOOK || (items || []).length >= LOOK
           || (byNo || []).length >= LOOK || (byName || []).length >= LOOK,
      });
    } catch (e) {
      if (mine !== lookSeq.current) return;
      setFound({ parties: [], items: [], bills: [], failed: true });
    }
  };

  // Push the screen FIRST. Clearing the search before navigating drops this
  // screen back to the day book for a frame, and that frame is visible as a
  // flash of the wrong page on the way out. The box is emptied once the new
  // screen is over the top of it.
  const goTo = (fn) => {
    Keyboard.dismiss();
    fn();
    setTimeout(() => { setQ(''); setFound(null); }, 400);
  };

  // THE BACK BUTTON CLEARS THE SEARCH BEFORE IT SHUTS THE APP.
  //
  // The home screen is the bottom of the stack, so the phone's back button
  // closes Skwik outright — which is right, except when a search is open over
  // the day book. Then back means "put that away", and losing the whole app
  // instead is the sort of thing that makes a shopkeeper stop trusting it.
  // Returning false lets Android do its usual thing when there is nothing to
  // put away.
  const searchOpen = !!(q || found);
  const openRef = useRef(searchOpen);
  openRef.current = searchOpen;

  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!openRef.current) return false;
      Keyboard.dismiss();
      setQ(''); setFound(null);
      return true;
    });
    return () => sub.remove();
  }, []));

  /* ---------------- the strip of things to do ---------------- */

  // PINNED, BECAUSE THEY ARE THE JOB.
  //
  // Writing a bill and entering a purchase are what a shop does forty times a
  // day; everything else is once a week. The two stay at the top of the strip
  // and never scroll out of reach, however long the rest of the list grows.
  const pinned = [
    { label: estimate ? 'Estimate' : 'Sale', icon: 'sale', on: true,
      go: () => navigation.navigate('Bill', { vtype: 'sale' }) },
    { label: 'Purchase', icon: 'purchase',
      go: () => navigation.navigate('Bill', { vtype: 'purchase' }) },
  ];

  const keys = [
    { label: 'Receipt', icon: 'in',  go: () => navigation.navigate('Money', { ptype: 'receipt' }) },
    { label: 'Payment', icon: 'out', go: () => navigation.navigate('Money', { ptype: 'payment' }) },
    { label: 'Udhar',   icon: 'book', go: () => navigation.navigate('Udhar') },
    { label: 'Ledgers', icon: 'book', go: () => navigation.navigate('Ledgers') },
    showStock(org)   && { label: 'Stock',   icon: 'stock',   go: () => navigation.navigate('Stock') },
    { label: 'Parties', icon: 'people', go: () => navigation.navigate('Parties') },
    { label: 'Items',   icon: 'tag', go: () => navigation.navigate('Items') },
    showReports(org) && isOwner && { label: 'Books', icon: 'book',
      go: () => navigation.navigate('Books') },
    showReports(org) && isOwner && { label: 'Reports', icon: 'reports',
      go: () => navigation.navigate('Reports') },
    showExpenses(org) && isOwner && { label: 'Money out', icon: 'out',
      go: () => navigation.navigate('Expenses') },
    showRecon(org) && isOwner && { label: 'Credit', icon: 'reports',
      go: () => navigation.navigate('Recon') },
  ].filter(Boolean);

  // WHERE THE SUBSCRIPTION STANDS, ASKED OF THE SERVER.
  //
  // The old banner counted down from a date on the firm row and then said
  // "your free trial has ended" while the app carried on working for ever.
  // There was no paid state at all, so a shop that HAD paid could not be
  // told apart from one that never would. The server answers now, and the
  // same answer is what stops a bill being written.
  const trialLeft = sub && sub.state === 'trial' ? Number(sub.days_left) : null;
  const paidLeft  = sub && sub.state === 'paid'  ? Number(sub.days_left) : null;
  const lapsed    = !!sub && sub.state === 'over';

  const banners = useMemo(() => [
    pending > 0 && { key: 'pending', tone: 'flag',
      title: `${pending} bill${pending === 1 ? '' : 's'} waiting on this phone`,
      body: sending ? 'Sending…' : 'Written with no internet. Tap to send them now.',
      go: pushNow },
    trialLeft !== null && { key: 'trial', tone: trialLeft > 2 ? 'calm' : 'flag',
      title: `Free trial — ${trialLeft} day${trialLeft === 1 ? '' : 's'} left`,
      body: trialLeft <= 3 ? 'After that you can still read everything, but not write new bills.' : null },
    // Only worth saying when it is close enough to act on.
    paidLeft !== null && paidLeft <= 30 && { key: 'renew', tone: paidLeft > 7 ? 'calm' : 'flag',
      title: `Your Skwik year ends in ${paidLeft} day${paidLeft === 1 ? '' : 's'}`,
      body: 'Renew before then and nothing stops.' },
    lapsed && { key: 'lapsed', tone: 'flag',
      title: 'Your Skwik year has ended',
      body: 'Everything you have written is still here and you can take a copy of it. '
          + 'New bills start again when you renew.' },
    org?.is_composition && fyTotal >= 12000000 && {
      key: 'comp', tone: fyTotal >= 15000000 ? 'bad' : 'flag',
      title: `This year's sale is ₹${fmt0(fyTotal)}. The composition limit is ₹1.5 crore.`,
      body: 'Speak to your accountant. Your billing carries on as normal.' },
  ].filter(Boolean), [pending, sending, trialLeft, paidLeft, lapsed, fyTotal, org?.is_composition]);

  // Bills written with no signal. Tapping tries them again there and then.
  async function pushNow() {
    setSending(true);
    const r = await sendPending();
    setSending(false);
    if (r.stillOffline) {
      Alert.alert('Still no internet',
        'Your bills are safe on this phone. Try again when you have signal.');
    } else if (r.failed) {
      Alert.alert('Some could not be sent',
        `${r.sent} went through. ${r.failed} were refused by the server and are `
        + 'still here. Tell me the bill and I can look at it.');
    } else if (r.renumbered?.length) {
      // The bill was already in the books under the server's own number: the
      // phone had given up waiting on a slow line after the server had in fact
      // saved it. The customer is holding paper with the other number on it.
      const one = r.renumbered[0];
      Alert.alert('One bill has two numbers',
        `Bill ${one.printed} is in your books as ${one.saved}`
        + (r.renumbered.length > 1 ? `, and ${r.renumbered.length - 1} more like it` : '')
        + '.\n\nThis happens when the line drops just as a bill is saved. Open it '
        + 'under Past bills and tell the customer the correct number, or write him '
        + 'a fresh one.');
    } else if (r.sent) {
      Alert.alert('Sent', `${r.sent} bill${r.sent === 1 ? '' : 's'} reached your books.`);
    }
  }

  const TONE = {
    flag: { bg: C.flagSoft, line: C.flagLine, ink: C.flagInk },
    calm: { bg: C.accentSoft, line: C.okLine, ink: C.accent },
    bad:  { bg: C.redL, line: '#E7C4C2', ink: '#7E2C28' },
  };

  return (
    <Screen>
      {/* the dark head: who this book belongs to, and the box that finds anything */}
      <View style={{ backgroundColor: C.barInk }}>
        <Bar style={{ paddingBottom: 6 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={S.barName}>{org?.name}</Text>
            <Text numberOfLines={1} style={S.barSub}>
              {[org?.gstin || (estimate ? 'Estimates' : 'No GST number'),
                `FY ${fyLabel()}`].join(' · ')}
            </Text>
          </View>
          <MoreButton navigation={navigation} />
        </Bar>

        <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          <View style={{ backgroundColor: C.barFill, borderWidth: 1, borderColor: C.barLine,
                         borderRadius: 10, paddingHorizontal: 12, paddingVertical: 4,
                         flexDirection: 'row', alignItems: 'center', gap: 9 }}>
            <Glyph name="search" color="#7FB3A9" size={16} />
            <TextInput
              style={{ flex: 1, fontSize: 14.5, color: '#FFFFFF', paddingVertical: 9 }}
              placeholder="Name, item or bill no."
              placeholderTextColor="#8E9C97"
              value={q} onChangeText={look} returnKeyType="search"
              autoCapitalize="none" autoCorrect={false} />
            {!!q && (
              <TouchableOpacity onPress={() => { setQ(''); setFound(null); Keyboard.dismiss(); }}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#7FB3A9' }}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>

      {/* what the box found, over the book while it is being typed in */}
      {found ? (
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
          <Result title="Customers & suppliers" rows={found.parties.map((p) => ({
            key: p.id, name: p.name,
            sub: [String(p.kind || 'customer') === 'supplier' ? 'supplier' : 'customer',
                  p.area, p.phone].filter(Boolean).join(' · '),
            go: () => goTo(() => navigation.navigate('Ledger', { partyId: p.id })),
          }))} />
          <Result title="Items" rows={found.items.map((it) => ({
            key: it.id, name: it.name, sub: it.unit,
            right: `₹${fmt0(it.sale_price)}`,
            go: () => goTo(() => navigation.navigate('Items')),
          }))} />
          <Result title="Bills" rows={found.bills.map((b) => ({
            key: b.id, name: b.printed_name || 'CASH',
            sub: `${(VWORD[b.vtype] || b.vtype).toUpperCase()} ${b.voucher_no || ''} · ${b.vdate}`,
            right: `₹${fmt0(b.total)}`,
            go: () => goTo(() => navigation.navigate('Bill', { voucherId: b.id })),
          }))} />
          {found.more && (
            <Text style={{ fontSize: 11.5, color: C.muted, textAlign: 'center',
                           marginTop: 14, paddingHorizontal: 30, lineHeight: 17 }}>
              More than {LOOK} match “{q.trim()}”. Type a little more of the name
              to narrow it down.
            </Text>
          )}

          {!found.parties.length && !found.items.length && !found.bills.length && (
            <Text style={{ fontSize: 13.5, color: C.muted, textAlign: 'center',
                           marginTop: 26, paddingHorizontal: 30, lineHeight: 20 }}>
              {found.failed
                ? 'Could not look just now — check your internet.'
                : `Nothing called “${q.trim()}”. Try a shorter piece of the name.`}
            </Text>
          )}
          <View style={{ height: 40 }} />
        </ScrollView>
      ) : (
        <View style={{ flex: 1, flexDirection: 'row' }}>

          {/* the book itself */}
          <View style={{ flex: 1, minWidth: 0 }}>
            <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>

              {banners.map((b) => {
                const t = TONE[b.tone];
                const Wrap = b.go ? TouchableOpacity : View;
                return (
                  <Wrap key={b.key} onPress={b.go} disabled={sending}
                    style={{ backgroundColor: t.bg, borderBottomWidth: 1, borderBottomColor: t.line,
                             paddingHorizontal: 14, paddingVertical: 11 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: t.ink }}>{b.title}</Text>
                    {!!b.body && (
                      <Text style={{ fontSize: 12, color: t.ink, marginTop: 3, lineHeight: 17 }}>
                        {b.body}
                      </Text>
                    )}
                  </Wrap>
                );
              })}

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
                             paddingHorizontal: 8, paddingVertical: 7,
                             borderBottomWidth: 1.5, borderBottomColor: C.ink }}>
                <TouchableOpacity onPress={() => setDay(shiftDay(day, -1))}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 8 }}
                  style={{ paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 20, fontWeight: '700', color: C.muted }}>‹</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => navigation.navigate('Bills')}
                  style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: C.ink }}>
                    {day === today() ? 'Day book' : 'Day book'}
                  </Text>
                  <Text style={[S.num, { flex: 1, fontSize: 12,
                                         color: day === today() ? C.muted : C.edit }]}>
                    {day === today() ? dmy(day) : `${dmy(day)} — not today`}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => { if (day < today()) setDay(shiftDay(day, 1)); }}
                  disabled={day >= today()}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  style={{ paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 20, fontWeight: '700',
                                 color: day >= today() ? C.faint : C.muted }}>›</Text>
                </TouchableOpacity>

                <Figure size={14.5} weight="700">{book ? rupee(book.sold) : '—'}</Figure>
              </View>

              {day !== today() && (
                <TouchableOpacity onPress={() => setDay(today())}
                  style={{ paddingHorizontal: 14, paddingVertical: 7,
                           borderBottomWidth: 1, borderBottomColor: C.line }}>
                  <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.accent }}>
                    Back to today
                  </Text>
                </TouchableOpacity>
              )}

              <ColHead cols={[{ label: 'TIME', width: 40 },
                              { label: 'PARTICULARS' },
                              { label: 'AMOUNT', width: 76 }]} />

              {(book?.rows || []).map((r, i) => (
                <Rule key={r.id} onPress={r.go} last={i === (book?.rows.length || 0) - 1}>
                  <Figure width={40} size={11.5} weight="400" tone={C.muted}>{clock(r.at)}</Figure>
                  <Words name={r.who} sub={r.ref} />
                  <Figure width={76} size={13.5} weight="600"
                          tone={r.out ? C.danger : C.ink}>{rupee(r.amt)}</Figure>
                </Rule>
              ))}

              {book && !book.rows.length && (
                <View style={{ padding: 26, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.ink }}>
                    Nothing yet today
                  </Text>
                  <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4,
                                 textAlign: 'center', lineHeight: 18 }}>
                    The first bill you write appears here.
                  </Text>
                  <TouchableOpacity
                    onPress={() => navigation.navigate('Bill', { vtype: 'sale' })}
                    style={[S.btn, { marginTop: 12, paddingVertical: 11, paddingHorizontal: 18 }]}>
                    <Text style={[S.btnText, { fontSize: 14 }]}>
                      {estimate ? 'New estimate' : 'New bill'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          </View>

          {/* the strip of things to do */}
          <View style={{ width: 92, backgroundColor: C.soft,
                         borderLeftWidth: 1, borderLeftColor: C.line }}>
            <View style={{ padding: 8, paddingBottom: 6, gap: 6,
                           borderBottomWidth: 1, borderBottomColor: C.line }}>
              <Text style={{ fontSize: 9.5, fontWeight: '700', letterSpacing: 0.9,
                             color: C.muted, paddingLeft: 2, paddingBottom: 2 }}>DO</Text>
              {pinned.map((k) => (
                <DoKey key={k.label} label={k.label} icon={k.icon} on={k.on} onPress={k.go} />
              ))}
            </View>
            <ScrollView contentContainerStyle={{ padding: 8, gap: 6, paddingBottom: 20 }}>
              {keys.map((k) => (
                <DoKey key={k.label} label={k.label} icon={k.icon} on={k.on} onPress={k.go} />
              ))}
            </ScrollView>
          </View>
        </View>
      )}

      {/* the foot: how many entries, and whether they have reached the books */}
      <Foot style={{ borderTopWidth: 1, borderTopColor: C.line, gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 11.5, color: C.muted }}>
          {book ? `${book.rows.length} entr${book.rows.length === 1 ? 'y' : 'ies'} on `
            + `${day === today() ? 'today' : dmy(day)}`
            : bookFailed ? 'No signal — today\u2019s entries could not be read'
            : 'Reading the day book…'}
          {book?.bills ? ` · ${book.bills} bill${book.bills === 1 ? '' : 's'}` : ''}
        </Text>
        <View style={{ width: 7, height: 7, borderRadius: 4,
                       backgroundColor: pending > 0 ? C.flag : C.ok }} />
        <Text style={{ fontSize: 11.5, fontWeight: '700', color: C.muted }}>
          {pending > 0 ? `${pending} waiting` : 'Synced'}
        </Text>
      </Foot>
    </Screen>
  );
}

/* ---------------- small parts used only here ---------------- */

function Result({ title, rows }) {
  if (!rows.length) return null;
  return (
    <View>
      <Text style={[S.eyebrow, { paddingHorizontal: 14, paddingTop: 14, marginBottom: 0 }]}>
        {title}
      </Text>
      {rows.map((r, i) => (
        <Rule key={r.key} onPress={r.go} last={i === rows.length - 1}>
          <Words name={r.name} sub={r.sub} />
          {!!r.right && <Figure width={76} size={13.5}>{r.right}</Figure>}
        </Rule>
      ))}
    </View>
  );
}

const dmy = (d) => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}`;

function fyLabel() {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String(y + 1).slice(2)}`;
}
