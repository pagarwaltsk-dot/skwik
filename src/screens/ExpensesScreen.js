import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, n2, num, settle, today } from '../lib/money';
import { showRcmIn } from '../lib/features';
import { sayPlainly } from '../lib/offline';
import { Box, Head, Screen, Sections, Foot, Swipe, useSectionSwipe }
  from '../components/Chrome';
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
  const { org, isOwner } = useApp();
  const [rows, setRows]   = useState([]);
  const [heads, setHeads] = useState([]);
  const [head, setHead]   = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote]   = useState('');
  const [mode, setMode]   = useState('cash');
  // FREIGHT, AND THE TAX ON IT THAT IS HIS TO PAY.
  //
  // A goods transport agency charges no GST; under section 9(3) the shop owes
  // it. Money out had nowhere to put that, so every rupee of freight tax was
  // missing from what Skwik said the shop owed. `amount` stays what he handed
  // the transporter — the tax goes to the government, not to him.
  const [rcm, setRcm]     = useState(false);
  const [rcmRate, setRcmRate] = useState('5');
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

  // Reverse charge is cleared with everything else. Left ticked, the next
  // entry — rent, tea — would quietly carry freight tax on it.
  const clear = () => { setEditing(null); setHead(''); setAmount(''); setNote('');
                        setMode('cash'); setRcm(false); setRcmRate('5'); };

  const save = async () => {
    const h = head.trim();
    if (!h) return Alert.alert('What for?', 'Type what the money went on — rent, salary, tea.');
    if (num(amount) <= 0) return Alert.alert('How much?', 'Type the amount.');

    setBusy(true);
    try {
      // The tax is worked out ON TOP of what he paid, and split the way a
      // local supply is split — a small shop's transporter is almost always
      // in its own state. Skwik never guesses an out-of-state transporter.
      const rate = rcm ? num(rcmRate) : 0;
      const tax  = rcm ? n2((num(amount) * rate) / 100) : 0;
      const half = n2(tax / 2);
      const body = { org_id: org.id, head: h, amount: num(amount),
                     mode, note: note.trim() || null,
                     account_id: mode === 'bank' ? account : null,
                     reverse_charge: !!rcm, gst_rate: rate,
                     cgst: half, sgst: n2(tax - half), igst: 0 };
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


  // SLIDING AWAY FROM A HALF-WRITTEN ENTRY WOULD THROW IT AWAY.
  //
  // A chip change replaces the screen, so an amount he has typed and not saved
  // goes with it — and a drag is far easier to do by accident than a tap on a
  // chip. So the finger moves between chips while the form is untouched, which
  // is when he is looking rather than writing, and stops the moment he starts
  // filling it in. The chips above never stop working.
  const started = !!String(head).trim() || !!String(amount).trim()
    || !!String(note).trim() || !!editing;
  const sec = useSectionSwipe(navigation, org, isOwner, 'spent');
  const swipe = started ? {} : sec;

  return (
    <Screen>
      <Head navigation={navigation} title="Money out" />
      <Sections navigation={navigation} org={org} isOwner={isOwner} id="spent" />

      <Swipe {...swipe} style={{ flex: 1 }}>
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

            {showRcmIn(org) && (
              <TouchableOpacity onPress={() => setRcm(!rcm)}
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 14 }}>
                <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5,
                               alignItems: 'center', justifyContent: 'center', marginTop: 1,
                               borderColor: rcm ? C.accent : C.greyB,
                               backgroundColor: rcm ? C.accent : 'transparent' }}>
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
                    {rcm ? '\u2713' : ''}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13.5, color: C.ink }}>
                    He charged no GST \u2014 the GST on this is mine to pay
                  </Text>
                  <Text style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 17 }}>
                    {rcm
                      ? `${rcmRate}% of \u20B9${fmt0(num(amount))} is `
                        + `\u20B9${fmt0(n2((num(amount) * num(rcmRate)) / 100))}, which you `
                        + 'hand to the government, not to him.'
                      : 'Freight from a transporter is the usual one.'}
                  </Text>
                </View>
              </TouchableOpacity>
            )}

            {rcm && (
              <View style={{ marginTop: 10 }}>
                <Text style={S.label}>AT WHAT RATE</Text>
                <View style={[S.row, { gap: 8, marginTop: 6, flexWrap: 'wrap' }]}>
                  {['5', '12', '18'].map((r) => {
                    const on = rcmRate === r;
                    return (
                      <TouchableOpacity key={r} onPress={() => setRcmRate(r)}
                        style={{ paddingHorizontal: 16, paddingVertical: 11, borderRadius: 9,
                                 borderWidth: 1, borderColor: on ? C.accent : C.line,
                                 backgroundColor: on ? C.accentSoft : C.surface }}>
                        <Text style={{ fontSize: 14, fontWeight: '700',
                                       color: on ? C.accent : C.muted }}>{r}%</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={[S.hint, { marginTop: 6 }]}>
                  Goods transport is 5%. Ask your accountant for anything else.
                </Text>
              </View>
            )}

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
                             setRcm(!!x.reverse_charge);
                             setRcmRate(String(Number(x.gst_rate) || 5));
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
      </Swipe>
    </Screen>
  );
}
