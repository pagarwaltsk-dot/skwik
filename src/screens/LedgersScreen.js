import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { fmt0, n2, num } from '../lib/money';
import { ColHead, Figure, Rule, Words } from '../components/Register';
import { Head, Screen } from '../components/Chrome';
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

const TABS = [
  { k: 'owed',  label: 'They owe you' },
  { k: 'owing', label: 'You owe them' },
  { k: 'all',   label: 'All' },
];

export default function LedgersScreen({ navigation }) {
  const [rows, setRows] = useState(null);
  const [tab, setTab]   = useState('owed');
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
        return true;
      })
      .filter((r) => !t || `${r.name} ${r.area || ''} ${r.phone || ''}`
        .toLowerCase().includes(t))
      // the biggest first: those are the ones worth a telephone call
      .sort((a, b) => Math.abs(num(b.balance)) - Math.abs(num(a.balance)));
  }, [rows, tab, q]);

  const totals = useMemo(() => {
    const owed  = (rows || []).reduce((a, r) => a + Math.max(0, num(r.balance)), 0);
    const owing = (rows || []).reduce((a, r) => a + Math.max(0, -num(r.balance)), 0);
    return { owed: n2(owed), owing: n2(owing) };
  }, [rows]);

  return (
    <Screen>
      <Head navigation={navigation} title="Ledgers" />

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
      </View>

      {/* THE CASH BOOK AND THE BANK BOOK WERE BUILT AND THEN LEFT UNREACHABLE.
          They lived behind one tile on the home screen that only an owner with
          Reports switched on ever saw, and it was called "Books", which does
          not say cash or bank to anybody. A ledger is a ledger: the cash box
          and each bank account are accounts of the firm exactly as a customer
          is, so they belong on the page that lists the accounts. */}
      <View style={{ paddingHorizontal: 14, paddingTop: 12 }}>
        <Text style={S.eyebrow}>YOUR OWN ACCOUNTS</Text>
        <View style={[S.row, { gap: 8, marginTop: 8 }]}>
          {[{ k: 'cash',  label: 'Cash book',  sub: 'the drawer' },
            { k: 'bank',  label: 'Bank book',  sub: 'per account' },
            { k: 'sheet', label: 'Balance sheet', sub: 'what you are worth' }].map((b) => (
            <TouchableOpacity key={b.k}
              onPress={() => navigation.navigate('Books', { book: b.k })}
              style={{ flex: 1, paddingVertical: 11, paddingHorizontal: 8, borderRadius: 11,
                       borderWidth: 1.5, borderColor: C.line, backgroundColor: C.surface,
                       alignItems: 'center' }}>
              <Text numberOfLines={1}
                style={{ fontSize: 13, fontWeight: '800', color: C.ink }}>{b.label}</Text>
              <Text numberOfLines={1}
                style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>{b.sub}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

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
                <Rule last={index === shown.length - 1}
                  onPress={() => navigation.navigate('Ledger', { partyId: item.id })}>
                  <Words name={item.name}
                    sub={[String(item.kind || 'customer') === 'supplier' ? 'supplier' : 'customer',
                          item.area, item.phone].filter(Boolean).join(' · ')} />
                  <Figure width={92} size={15} weight="700"
                          tone={b > 0 ? C.ink : b < 0 ? C.danger : C.faint}>
                    {b === 0 ? '—' : fmt0(Math.abs(b))}
                  </Figure>
                </Rule>
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
        </>
      )}
    </Screen>
  );
}
