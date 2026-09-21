import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, num, settle, today } from '../lib/money';
import { sayPlainly } from '../lib/offline';
import { Box, Head, Screen, Foot } from '../components/Chrome';
import { C, S } from '../theme';

// MONEY THAT GOES OUT AND IS NOT A PURCHASE.
//
// Rent, salary, tea, transport, the electricity bill. Without them the app
// can tell a shopkeeper what he sold but never what he earned, which is the
// number he actually wants. Two boxes: what for, and how much.

const COMMON = ['Rent', 'Salary', 'Transport', 'Electricity', 'Tea & food',
                'Repairs', 'Phone', 'Packing', 'Commission', 'Other'];

const dmy = (d) => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(2, 4)}`;

export default function ExpensesScreen({ navigation }) {
  const { org } = useApp();
  const [rows, setRows]   = useState([]);
  const [heads, setHeads] = useState([]);
  const [head, setHead]   = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote]   = useState('');
  const [mode, setMode]   = useState('cash');
  // WHICH BANK THE MONEY LEFT.
  //
  // This screen had a Cash/Bank switch and no account behind it, so every
  // bank expense went in with no account on it — and the bank book filters by
  // account, so rent and salary paid from the bank appeared in no bank book at
  // all and the closing balance was overstated by the whole of it. A shop
  // reconciling against its own statement found it short by its own rent.
  const [monthSpent, setMonthSpent] = useState(0);
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount]   = useState(null);
  const [busy, setBusy]   = useState(false);
  const [editing, setEditing] = useState(null);

  const fAmt = useRef(null), fNote = useRef(null);

  const load = useCallback(async () => {
    const [{ data: xs }, { data: hs }, { data: bs }, { data: ms }] = await Promise.all([
      supabase.from('expenses').select('*').order('edate', { ascending: false })
        .order('created_at', { ascending: false }).limit(60),
      // `used` is not a counter — see the note by the upsert below — so the
      // name is the tie-break rather than whatever order the rows arrive in.
      supabase.from('expense_heads').select('*')
        .order('used', { ascending: false }).order('head').limit(12),
      supabase.from('bank_accounts').select('id, name, is_default, active')
        .order('is_default', { ascending: false }).order('name'),
      // THIS MONTH'S TOTAL CAME OFF THE LIST, AND THE LIST IS SIXTY ROWS.
      // A shop entering more than sixty expenses in a month saw a total short
      // by the overflow, with nothing to say so. It has its own query now,
      // which asks for the month and nothing else.
      supabase.from('expenses').select('amount')
        .gte('edate', today().slice(0, 7) + '-01')
        .lte('edate', today()),
    ]);
    setRows(xs || []);
    setHeads((hs || []).map((h) => h.head));
    const live = (bs || []).filter((b) => b.active !== false);
    setAccounts(live);
    setAccount((a) => a || live.find((b) => b.is_default)?.id || live[0]?.id || null);
    setMonthSpent((ms || []).reduce((t, x) => t + Number(x.amount || 0), 0));
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const clear = () => { setEditing(null); setHead(''); setAmount(''); setNote(''); setMode('cash'); };

  const save = async () => {
    const h = head.trim();
    if (!h) return Alert.alert('What for?', 'Type what the money went on — rent, salary, tea.');
    if (num(amount) <= 0) return Alert.alert('How much?', 'Type the amount.');

    setBusy(true);
    try {
      const body = { org_id: org.id, head: h, amount: num(amount),
                     mode, note: note.trim() || null,
                     account_id: mode === 'bank' ? account : null };
      if (mode === 'bank' && !account) {
        setBusy(false);
        return Alert.alert('Which bank?',
          'Add a bank account under Cash & bank accounts first, or mark this as Cash.');
      }
      const { error } = editing
        ? await supabase.from('expenses').update(body).eq('id', editing.id)
        : await supabase.from('expenses').insert({ ...body, edate: today() });
      if (error) throw error;

      // Remember the head, so next time it is one tap.
      //
      // This used to upsert `used: 1`, which does not count anything — it
      // writes 1 back over whatever was there, every single time. The list
      // below is ordered by that column, so "the ones you use most" was in
      // no order at all. Nothing is written over an existing head now, and
      // the order falls back to the name, which at least does not lie.
      await supabase.from('expense_heads')
        .upsert({ org_id: org.id, head: h, used: 1 },
                { onConflict: 'org_id,head', ignoreDuplicates: true });

      clear();
      load();
    } catch (e) {
      Alert.alert('Could not save', sayPlainly(e));
    } finally { setBusy(false); }
  };

  const remove = (x) => Alert.alert('Remove this?', `${x.head} — ₹${fmt0(x.amount)}`,
    [{ text: 'Keep it' },
     { text: 'Remove', style: 'destructive', onPress: async () => {
         const { error } = await supabase.from('expenses').delete().eq('id', x.id);
         if (error) return Alert.alert('Could not remove', sayPlainly(error));
         if (editing?.id === x.id) clear();
         load();
       } }]);

  const month = monthSpent;

  const suggestions = [...new Set([...heads, ...COMMON])].slice(0, 10);

  return (
    <Screen>
      <Head navigation={navigation} title="Money out" />

      <FlatList
        data={rows}
        keyExtractor={(x) => x.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ padding: 12 }}>
            <View style={S.card}>
              <Text style={S.eyebrow}>This month</Text>
              <Text style={[{ fontSize: 28, fontWeight: '800', color: C.ink }, S.num]}>
                ₹{fmt0(month)}
              </Text>
            </View>

            <Text style={S.label}>WHAT FOR</Text>
            <Box ref={null} next={fAmt} style={{ marginTop: 6 }} value={head}
              onChangeText={setHead} placeholder="Rent, salary, tea…" />
            <View style={[S.row, { flexWrap: 'wrap', gap: 6, marginTop: 8 }]}>
              {suggestions.map((h) => (
                <TouchableOpacity key={h} onPress={() => { setHead(h); fAmt.current?.focus(); }}
                  style={{ paddingHorizontal: 11, paddingVertical: 7, borderRadius: 9,
                           borderWidth: 1, borderColor: head === h ? C.accent : C.line,
                           backgroundColor: head === h ? C.accentSoft : C.surface }}>
                  <Text style={{ fontSize: 12.5, fontWeight: '600',
                                 color: head === h ? C.accent : C.muted }}>{h}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[S.label, { marginTop: 14 }]}>HOW MUCH</Text>
            <Box ref={fAmt} next={fNote}
              style={[{ marginTop: 6, fontSize: 30, paddingVertical: 12 }, S.num]}
              keyboardType="numeric" placeholder="0" value={amount}
              onChangeText={setAmount} onBlur={() => setAmount(settle(amount))} />

            <View style={[S.row, { gap: 8, marginTop: 12 }]}>
              {['cash', 'bank'].map((m) => {
                const on = mode === m;
                return (
                  <TouchableOpacity key={m} onPress={() => setMode(m)}
                    style={{ flex: 1, paddingVertical: 11, borderRadius: 9, alignItems: 'center',
                             borderWidth: 1, borderColor: on ? C.accent : C.line,
                             backgroundColor: on ? C.accentSoft : C.surface }}>
                    <Text style={{ fontSize: 14, fontWeight: '700',
                                   color: on ? C.accent : C.muted }}>
                      {m === 'cash' ? 'Cash' : 'Bank'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {mode === 'bank' && accounts.length > 1 && (
              <View style={{ marginTop: 10 }}>
                <Text style={S.label}>FROM WHICH ACCOUNT</Text>
                <View style={[S.row, { gap: 8, marginTop: 6, flexWrap: 'wrap' }]}>
                  {accounts.map((b) => {
                    const on = account === b.id;
                    return (
                      <TouchableOpacity key={b.id} onPress={() => setAccount(b.id)}
                        style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 9,
                                 borderWidth: 1, borderColor: on ? C.accent : C.line,
                                 backgroundColor: on ? C.accentSoft : C.surface }}>
                        <Text style={{ fontSize: 13, fontWeight: '700',
                                       color: on ? C.accent : C.muted }}>{b.name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            <Text style={[S.label, { marginTop: 14 }]}>NOTE (OPTIONAL)</Text>
            <Box ref={fNote} onSubmit={save} style={{ marginTop: 6 }} value={note}
              onChangeText={setNote} placeholder="September, shop rent" />

            <TouchableOpacity style={[S.btn, { marginTop: 18 }]} onPress={save} disabled={busy}>
              <Text style={S.btnText}>
                {busy ? 'Saving…' : editing ? 'Save the change' : 'Write it down'}
              </Text>
            </TouchableOpacity>
            {!!editing && (
              <TouchableOpacity onPress={clear} style={{ marginTop: 10, alignItems: 'center', padding: 8 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: C.muted }}>Cancel</Text>
              </TouchableOpacity>
            )}

            <Text style={[S.eyebrow, { marginTop: 24 }]}>Lately</Text>
          </View>
        }
        renderItem={({ item: x }) => (
          <TouchableOpacity
            onPress={() => { setEditing(x); setHead(x.head); setAmount(String(Number(x.amount)));
                             setNote(x.note || ''); setMode(x.mode || 'cash');
                             setAccount(x.account_id || accounts.find((b) => b.is_default)?.id
                                        || accounts[0]?.id || null); }}
            onLongPress={() => remove(x)}
            style={[S.hit, { paddingHorizontal: 16 }]}>
            <View style={{ flex: 1 }}>
              <Text style={S.hitName}>{x.head}</Text>
              <Text style={S.hitSub}>
                {dmy(x.edate)} · {x.mode === 'bank' ? 'Bank' : 'Cash'}
                {x.note ? ` · ${x.note}` : ''}
              </Text>
            </View>
            <Text style={[S.hitPr, S.num]}>₹{fmt0(x.amount)}</Text>
          </TouchableOpacity>
        )}
        ListFooterComponent={
          rows.length ? (
            <Text style={{ fontSize: 11.5, color: C.muted, textAlign: 'center',
                           marginTop: 14, marginBottom: 30 }}>
              Tap one to correct it. Hold it to remove it.
            </Text>
          ) : (
            <Text style={{ fontSize: 13, color: C.muted, textAlign: 'center', marginTop: 20 }}>
              Nothing written down yet.
            </Text>
          )
        }
      />
    </Screen>
  );
}
