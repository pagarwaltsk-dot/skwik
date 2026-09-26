import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, ActivityIndicator, Alert, Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { sayPlainly } from '../lib/offline';
import { fmt0, n2, num } from '../lib/money';
import { ColHead, EditKey, Figure, Rule, Words } from '../components/Register';
import { Head, Screen, Sections, Swipe, useSectionSwipe } from '../components/Chrome';
import { C, S } from '../theme';

// EVERY ACCOUNT, ON ONE PAGE.
//
// Customers & suppliers is where a name is edited. This is the other thing a
// shopkeeper wants from the same list and could not get: what every account
// STANDS AT, in one screen, sorted by what matters — the biggest debts at the
// top, because those are the ones he is going to ring about.
//
// Tapping a name opens its account, where each bill can now be handed over as
// a PDF without leaving the screen.

// EVERY ACCOUNT FIRST, THE TWO SIDES AFTER.
//
// This opened on "They owe you", so a customer whose account had settled to
// nothing was nowhere: not on that tab, not on "You owe them", and he had to
// know there was a third tab to find him. A ledger list that leaves out the
// people who have paid up is not a ledger list.
//
// So All comes first and is where it opens, and the two sides are filters he
// reaches for rather than the thing he lands on.
const TABS = [
  { k: 'all',   label: 'All' },
  { k: 'owed',  label: 'They owe you' },
  { k: 'owing', label: 'You owe them' },
];

// The same quiet button the Past bills rows use: a small word, and a tap
// target around it big enough for a thumb.
const RowKey = ({ children, onPress, label }) => (
  <TouchableOpacity onPress={onPress} accessibilityLabel={label}
    hitSlop={{ top: 10, bottom: 8, left: 6, right: 6 }}
    style={{ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 9,
             borderWidth: 1, borderColor: C.line, backgroundColor: C.surface }}>
    {children}
  </TouchableOpacity>
);

const dmy = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}` : '');

export default function LedgersScreen({ navigation }) {
  const { org, isOwner } = useApp();
  const swipe = useSectionSwipe(navigation, org, isOwner, 'ledgers');
  const [rows, setRows] = useState(null);
  const [tab, setTab]   = useState('all');
  // And on All, nil accounts can be put away — his choice, not Skwik's.
  const [hideNil, setHideNil] = useState(false);
  const [q, setQ]       = useState('');
  const [failed, setFailed] = useState('');

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('party_balances');
        if (!on) return;
        if (error) throw error;
        setRows(Array.isArray(data) ? data : []);
        setFailed('');
      } catch (e) {
        if (on) { setFailed(sayPlainly(e)); setRows(null); }
      }
    })();
    return () => { on = false; };
  }, []));

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows || [])
      .filter((r) => {
        const b = num(r.balance);
        if (tab === 'owed')  return b > 0;
        if (tab === 'owing') return b < 0;
        return !hideNil || b !== 0;
      })
      .filter((r) => !t || `${r.name} ${r.area || ''} ${r.phone || ''}`
        .toLowerCase().includes(t))
      // the biggest first: those are the ones worth a telephone call
      .sort((a, b) => Math.abs(num(b.balance)) - Math.abs(num(a.balance)));
  }, [rows, tab, q, hideNil]);

  // ASKING FOR THE MONEY, FROM THE ROW.
  //
  // Word for word what the Udhar screen sends, so the message his customers
  // have been getting does not change because the button moved.
  const ask = (r) => {
    const amt = Math.abs(num(r.balance));
    const msg = `Namaste ${r.name},\n\n`
      + `₹${fmt0(amt)} is outstanding against your account`
      + (r.last_bill ? ` (last bill ${dmy(r.last_bill)})` : '') + '.\n\n'
      + 'Kindly arrange the payment.\n\n'
      + `${org?.name || ''}${org?.phone ? `\n${org.phone}` : ''}`;

    const phone = String(r.phone || '').replace(/\D/g, '').slice(-10);
    const url = phone
      ? `whatsapp://send?phone=91${phone}&text=${encodeURIComponent(msg)}`
      : `whatsapp://send?text=${encodeURIComponent(msg)}`;

    Linking.openURL(url).catch(() =>
      Linking.openURL(`https://wa.me/${phone ? `91${phone}` : ''}?text=${encodeURIComponent(msg)}`)
        .catch(() => Alert.alert('No WhatsApp', 'WhatsApp is not installed on this phone.')));
  };

  const totals = useMemo(() => {
    const owed  = (rows || []).reduce((a, r) => a + Math.max(0, num(r.balance)), 0);
    const owing = (rows || []).reduce((a, r) => a + Math.max(0, -num(r.balance)), 0);
    return { owed: n2(owed), owing: n2(owing) };
  }, [rows]);

  return (
    <Screen>
      <Head navigation={navigation} title="Ledgers">
        <TouchableOpacity onPress={() => navigation.navigate('Parties', { newParty: true })}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: C.accent }}>+ NEW</Text>
        </TouchableOpacity>
      </Head>
      <Sections navigation={navigation} org={org} isOwner={isOwner} id="ledgers" />

      <View style={{ backgroundColor: C.soft, paddingHorizontal: 12, paddingVertical: 8,
                     borderBottomWidth: 1, borderBottomColor: C.line, gap: 8 }}>
        <View style={[S.row, { gap: 6 }]}>
          {TABS.map((t) => {
            const on = tab === t.k;
            return (
              <TouchableOpacity key={t.k} onPress={() => setTab(t.k)}
                style={{ flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center',
                         borderWidth: 1, borderColor: on ? C.accent : C.line,
                         backgroundColor: on ? C.accentSoft : C.surface }}>
                <Text numberOfLines={1}
                  style={{ fontSize: 12.5, fontWeight: '700', color: on ? C.accent : C.muted }}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TextInput style={[S.input, { paddingVertical: 9 }]} placeholder="Search a name"
          placeholderTextColor={C.faint} value={q} onChangeText={setQ} returnKeyType="search" />
        {tab === 'all' && (
          <TouchableOpacity onPress={() => setHideNil((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[S.row, { gap: 9 }]}>
            <View style={{ width: 19, height: 19, borderRadius: 6, borderWidth: 1.5,
                           alignItems: 'center', justifyContent: 'center',
                           borderColor: hideNil ? C.accent : C.greyB,
                           backgroundColor: hideNil ? C.accent : 'transparent' }}>
              {hideNil && <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>✓</Text>}
            </View>
            <Text style={{ flex: 1, fontSize: 12.5, fontWeight: '600', color: C.ink }}>
              Hide accounts that have settled to nothing
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* THE CASH BOOK, THE BANK BOOK AND THE BALANCE SHEET USED TO SIT HERE.
          They were put here when they had no other door. They have one now —
          the Books chip along the top — and a shop's own three accounts sitting
          above a list of its customers only made this page longer and said the
          same thing twice. They live under Books, and nowhere else. */}

      <View style={[S.row, { paddingHorizontal: 14, paddingVertical: 11, marginTop: 12,
                             borderBottomWidth: 1.5, borderBottomColor: C.ink, gap: 14 }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 10.5, letterSpacing: 0.8, fontWeight: '700', color: C.muted }}>
            THEY OWE YOU
          </Text>
          <Text style={[S.num, { fontSize: 17, fontWeight: '800', color: C.ink }]}>
            ₹{fmt0(totals.owed)}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 10.5, letterSpacing: 0.8, fontWeight: '700', color: C.muted }}>
            YOU OWE THEM
          </Text>
          <Text style={[S.num, { fontSize: 17, fontWeight: '800', color: C.danger }]}>
            ₹{fmt0(totals.owing)}
          </Text>
        </View>
      </View>

      <Swipe {...swipe} style={{ flex: 1 }}>
      {failed ? (
        <View style={{ padding: 20 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: C.danger }}>
            Could not read the accounts
          </Text>
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 6, lineHeight: 19 }}>{failed}</Text>
        </View>
      ) : rows === null ? (
        <View style={{ paddingTop: 40 }}><ActivityIndicator color={C.accent} /></View>
      ) : (
        <>
          <ColHead cols={[{ label: 'NAME' }, { label: 'BALANCE', width: 92 }]} />
          <FlatList
            data={shown}
            keyExtractor={(r) => String(r.id)}
            contentContainerStyle={{ paddingBottom: 40 }}
            renderItem={({ item, index }) => {
              const b = num(item.balance);
              return (
                <View>
                  <Rule last={index === shown.length - 1 && !b}
                    onPress={() => navigation.navigate('Ledger', { partyId: item.id })}>
                    <Words name={item.name}
                      after={
                        <EditKey label={`Edit ${item.name}`}
                          onPress={() => navigation.navigate('Parties', { editId: item.id })} />
                      }
                      sub={[String(item.kind || 'customer') === 'supplier' ? 'supplier' : 'customer',
                            item.area, item.phone].filter(Boolean).join(' \u00B7 ')} />
                    <Figure width={92} size={15} weight="700"
                            tone={b > 0 ? C.ink : b < 0 ? C.danger : C.faint}>
                      {b === 0 ? '\u2014' : fmt0(Math.abs(b))}
                    </Figure>
                  </Rule>

                  {/* CHASING A DUE IS THE ONE THING HE ASKED FOR ON THE ROW.
                      Receipt and payment buttons were here too and he did not
                      ask for them: taking money is its own screen with a date,
                      a mode and an amount on it, and a shortcut that lands him
                      there mid-scroll is a way to mis-tap, not a saving. Gone.
                      A row with nothing owing now carries no strip at all. */}
                  {b > 0 && (
                    <View style={[S.row, { justifyContent: 'flex-end',
                                           paddingHorizontal: 14, paddingBottom: 10,
                                           marginTop: -4,
                                           borderBottomWidth: index === shown.length - 1 ? 0 : 1,
                                           borderBottomColor: '#EDE9E0' }]}>
                      <RowKey label={`Ask ${item.name} to pay`} onPress={() => ask(item)}>
                        <Text style={{ fontSize: 11.5, fontWeight: '800', color: C.green }}>
                          ASK TO PAY
                        </Text>
                      </RowKey>
                    </View>
                  )}
                </View>
              );
            }}
            ListEmptyComponent={
              <Text style={{ fontSize: 13.5, color: C.muted, textAlign: 'center',
                             marginTop: 26, paddingHorizontal: 30, lineHeight: 20 }}>
                {tab === 'owed' ? 'Nobody owes you anything.'
                  : tab === 'owing' ? 'You owe nobody anything.'
                  : 'No accounts yet.'}
              </Text>
            } />

          {/* THE ONE THING UDHAR DID THAT A ROW CANNOT. Chasing forty people
              one after another is a job, not a tap, and it has its own screen
              with a queue. It is reached from here, where he is already
              looking at who owes him, rather than from a chip of its own. */}
          {tab === 'owed' && shown.length > 1 && (
            <TouchableOpacity onPress={() => navigation.navigate('Udhar')}
              style={{ margin: 14, paddingVertical: 13, borderRadius: 11,
                       borderWidth: 1.5, borderColor: C.line,
                       backgroundColor: C.surface, alignItems: 'center' }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: C.accent }}>
                Ask all {shown.length} of them, one after another
              </Text>
            </TouchableOpacity>
          )}
        </>
      )}
      </Swipe>
    </Screen>
  );
}
