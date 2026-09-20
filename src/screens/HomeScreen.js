import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Alert, Keyboard,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, n2, num, today } from '../lib/money';
import { Bar, Foot, MoreButton, Screen } from '../components/Chrome';
import { ColHead, DoKey, Figure, Glyph, Rule, Words } from '../components/Register';
import {
  showExpenses, showPurchase, showRecon, showReports, showStock,
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
  const [book, setBook] = useState({ rows: [], sold: 0, bills: 0 });
  const [fyTotal, setFyTotal] = useState(0);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const estimate = org?.mode === 'estimate';

  /* ---------------- the day's entries ---------------- */

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      countPending?.();
      try {
        const d = today();
        const [{ data: vs }, { data: ps }] = await Promise.all([
          supabase.from('vouchers')
            .select('id, vtype, voucher_no, printed_name, total, is_cash, created_at')
            .eq('vdate', d).order('created_at'),
          supabase.from('payments')
            .select('id, ptype, amount, mode, created_at, parties(name)')
            .eq('pdate', d).order('created_at'),
        ]);
        if (!on) return;

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
        ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

        const sold = (vs || [])
          .filter((v) => v.vtype === 'sale' || v.vtype === 'estimate')
          .reduce((a, v) => a + num(v.total), 0);
        const bills = (vs || [])
          .filter((v) => v.vtype === 'sale' || v.vtype === 'estimate').length;

        setBook({ rows, sold: n2(sold), bills });

        if (org?.is_composition) {
          const now = new Date();
          const fyStart = `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
          const { data: fy } = await supabase.from('vouchers')
            .select('total').eq('vtype', 'sale').gte('vdate', fyStart);
          if (on && fy) setFyTotal(fy.reduce((a, v) => a + num(v.total), 0));
        }
      } catch (e) {
        // A figure that could not be worked out is left standing rather than
        // drawn as nil, which reads as a day with no trade in it.
      }
    })();
    return () => { on = false; };
  }, [org?.is_composition, countPending, navigation]));

  /* ---------------- the box that finds anything ---------------- */

  const look = async (text) => {
    setQ(text);
    const t = text.trim();
    if (t.length < 2) return setFound(null);
    try {
      const [{ data: parties }, { data: items }, { data: bills }] = await Promise.all([
        supabase.from('parties').select('id, name, area, phone').ilike('name', `%${t}%`).limit(4),
        supabase.from('items').select('id, name, unit, sale_price').eq('is_active', true)
          .ilike('name', `%${t}%`).limit(4),
        supabase.from('vouchers').select('id, vtype, voucher_no, printed_name, total, vdate')
          .ilike('voucher_no', `%${t}%`).limit(4),
      ]);
      setFound({ parties: parties || [], items: items || [], bills: bills || [] });
    } catch (e) {
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

  /* ---------------- the strip of things to do ---------------- */

  const keys = [
    { label: estimate ? 'Estimate' : 'Sale', icon: 'sale', on: true,
      go: () => navigation.navigate('Bill', { vtype: 'sale' }) },
    showPurchase(org) && { label: 'Purchase', icon: 'purchase',
      go: () => navigation.navigate('Bill', { vtype: 'purchase' }) },
    { label: 'Receipt', icon: 'in',  go: () => navigation.navigate('Money', { ptype: 'receipt' }) },
    { label: 'Payment', icon: 'out', go: () => navigation.navigate('Money', { ptype: 'payment' }) },
    { label: 'Udhar',   icon: 'book', go: () => navigation.navigate('Udhar') },
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

  const trialLeft = org?.trial_ends_at && org?.plan === 'trial'
    ? Math.ceil((new Date(org.trial_ends_at) - new Date()) / 86400000) : null;

  const banners = useMemo(() => [
    pending > 0 && { key: 'pending', tone: 'flag',
      title: `${pending} bill${pending === 1 ? '' : 's'} waiting on this phone`,
      body: sending ? 'Sending…' : 'Written with no internet. Tap to send them now.',
      go: pushNow },
    trialLeft !== null && { key: 'trial', tone: trialLeft > 2 ? 'calm' : 'flag',
      title: trialLeft > 0
        ? `Free trial — ${trialLeft} day${trialLeft === 1 ? '' : 's'} left`
        : 'Your free trial has ended' },
    org?.is_composition && fyTotal >= 12000000 && {
      key: 'comp', tone: fyTotal >= 15000000 ? 'bad' : 'flag',
      title: `This year's sale is ₹${fmt0(fyTotal)}. The composition limit is ₹1.5 crore.`,
      body: 'Speak to your accountant. Your billing carries on as normal.' },
  ].filter(Boolean), [pending, sending, trialLeft, fyTotal, org?.is_composition]);

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
            key: p.id, name: p.name, sub: [p.area, p.phone].filter(Boolean).join(' · '),
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

              <TouchableOpacity onPress={() => navigation.navigate('Bills')}
                style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8,
                         paddingHorizontal: 14, paddingVertical: 11,
                         borderBottomWidth: 1.5, borderBottomColor: C.ink }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: C.ink }}>Day book</Text>
                <Text style={[S.num, { flex: 1, fontSize: 12, color: C.muted }]}>
                  {dmy(today())}
                </Text>
                <Figure size={14.5} weight="700">{rupee(book.sold)}</Figure>
              </TouchableOpacity>

              <ColHead cols={[{ label: 'TIME', width: 40 },
                              { label: 'PARTICULARS' },
                              { label: 'AMOUNT', width: 76 }]} />

              {book.rows.map((r, i) => (
                <Rule key={r.id} onPress={r.go} last={i === book.rows.length - 1}>
                  <Figure width={40} size={11.5} weight="400" tone={C.muted}>{clock(r.at)}</Figure>
                  <Words name={r.who} sub={r.ref} />
                  <Figure width={76} size={13.5} weight="600"
                          tone={r.out ? C.danger : C.ink}>{rupee(r.amt)}</Figure>
                </Rule>
              ))}

              {!book.rows.length && (
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
            <ScrollView contentContainerStyle={{ padding: 8, gap: 6, paddingBottom: 20 }}>
              <Text style={{ fontSize: 9.5, fontWeight: '700', letterSpacing: 0.9,
                             color: C.muted, paddingLeft: 2, paddingBottom: 2 }}>DO</Text>
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
          {book.rows.length} entr{book.rows.length === 1 ? 'y' : 'ies'} today
          {book.bills ? ` · ${book.bills} bill${book.bills === 1 ? '' : 's'}` : ''}
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
