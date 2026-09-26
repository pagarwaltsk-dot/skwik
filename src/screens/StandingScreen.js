import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, num, showDate, today } from '../lib/money';
import { sayPlainly } from '../lib/offline';
import { Box, Head, Screen } from '../components/Chrome';
import { CardFigure, CardName, CardRow } from '../components/Register';
import { CalButton } from '../components/DatePick';
import { C, S } from '../theme';

// THE REST OF WHAT HE OWNS, AND THE REST OF WHAT HE OWES.
//
// His balance sheet used to end with an apology: a loan you have taken, a
// shop or a vehicle you own, are not in these books. True, and a sheet that
// stops one line short of being useful. A loan does not pass through a bill
// or a receipt, so nothing Skwik records will ever find it — and without it
// the figure at the bottom is a fragment of his net worth that he has to
// finish on paper.
//
// So they are written here, once, and corrected when they change: a short
// list of named balances, which is exactly how he already holds them.
//
// WHAT THIS IS NOT, ON PURPOSE.
//
// It is not a ledger for the loan. There are no journal entries, no trial
// balance, and no instalments posted against it — building those would turn a
// billing book into Tally, and Tally is hard to use precisely because it has
// them. A man who wants every instalment tracked has outgrown this.
//
// AND MONEY DRAWN FOR THE HOUSE IS NOT HERE.
//
// It looks like it belongs. It does not: when he takes 50,000 out of the till
// the cash figure has already fallen and his capital has fallen with it, so
// writing it down again here would take it off twice. If he took it without
// recording it, the CASH figure is what is wrong, and a cash entry is the fix.

const KINDS = [
  { k: 'owns', label: 'Something you own', hint: 'the shop, a vehicle, machinery, a deposit paid' },
  { k: 'owes', label: 'Something you owe', hint: 'a bank loan, money borrowed, a deposit taken' },
];

export default function StandingScreen({ navigation }) {
  const { org } = useApp();
  const [rows, setRows]   = useState([]);
  const [busy, setBusy]   = useState(false);
  const [failed, setFailed] = useState('');
  const [edit, setEdit]   = useState(null);   // the one being added or changed

  const load = useCallback(() => {
    supabase.from('standing_items').select('*').order('kind').order('name')
      .then(({ data, error }) => {
        if (error) setFailed(sayPlainly(error)); else { setRows(data || []); setFailed(''); }
      });
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const owns = rows.filter((r) => r.kind === 'owns');
  const owes = rows.filter((r) => r.kind === 'owes');
  const sum = (a) => a.reduce((t, r) => t + num(r.amount), 0);

  const startNew = (kind) => setEdit({ kind, name: '', amount: '', note: '', as_on: today() });
  const startEdit = (r) => setEdit({
    id: r.id, kind: r.kind, name: r.name || '', amount: String(r.amount ?? ''),
    note: r.note || '', as_on: r.as_on || today() });

  const save = async () => {
    const name = (edit.name || '').trim();
    if (!name) return Alert.alert('What is it?', 'Give it a name you will recognise — Bank loan, Tata Ace, the shop.');
    if (num(edit.amount) < 0) return Alert.alert('That cannot be', 'An amount cannot be less than nothing.');
    setBusy(true);
    const body = {
      org_id: org.id, kind: edit.kind, name,
      amount: num(edit.amount), note: (edit.note || '').trim() || null,
      as_on: edit.as_on || null, updated_at: new Date().toISOString(),
    };
    const { error } = edit.id
      ? await supabase.from('standing_items').update(body).eq('id', edit.id)
      : await supabase.from('standing_items').insert(body);
    setBusy(false);
    if (error) return Alert.alert('Could not save', sayPlainly(error));
    setEdit(null); load();
  };

  const remove = (r) => Alert.alert(`Take ${r.name} off the list?`,
    'It stops counting on your balance sheet. Nothing else in your books changes.',
    [{ text: 'Keep it' },
     { text: 'Take it off', style: 'destructive', onPress: async () => {
        const { error } = await supabase.from('standing_items').delete().eq('id', r.id);
        if (error) return Alert.alert('Could not remove it', sayPlainly(error));
        load();
      } }]);

  const Group = ({ title, list, kind, tone }) => (
    <>
      <View style={[S.row, { marginTop: 22 }]}>
        <Text style={[S.eyebrow, { flex: 1 }]}>{title}</Text>
        <TouchableOpacity onPress={() => startNew(kind)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ fontSize: 13.5, fontWeight: '800', color: C.green }}>+ ADD</Text>
        </TouchableOpacity>
      </View>

      {!list.length && (
        <Text style={{ fontSize: 13, color: C.muted, marginTop: 8, lineHeight: 19 }}>
          {KINDS.find((x) => x.k === kind).hint}
        </Text>
      )}

      {list.map((r) => (
        <CardRow key={r.id} onPress={() => startEdit(r)}>
          <CardName name={r.name}
            sub={[r.note, r.as_on ? `from ${showDate(r.as_on)}` : null]
              .filter(Boolean).join(' · ')}
            after={
              <TouchableOpacity onPress={() => remove(r)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={{ fontSize: 20, color: C.danger }}>{'×'}</Text>
              </TouchableOpacity>
            } />
          <View style={[S.row, { marginTop: 10 }]}>
            <CardFigure label={kind === 'owns' ? 'WORTH' : 'OUTSTANDING'} tone={tone}>
              {'₹'}{fmt0(r.amount)}
            </CardFigure>
          </View>
        </CardRow>
      ))}

      {list.length > 1 && (
        <Text style={[{ fontSize: 13.5, fontWeight: '800', color: tone, textAlign: 'right',
                        marginTop: 2, marginBottom: 6 }, S.num]}>
          {'₹'}{fmt0(sum(list))}
        </Text>
      )}
    </>
  );

  return (
    <Screen>
      <Head navigation={navigation} title="Owned and owed" />
      <ScrollView keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>

        {!!failed && (
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.danger }}>{failed}</Text>
        )}

        <Text style={{ fontSize: 13, color: C.muted, lineHeight: 19 }}>
          Things no bill or receipt will ever mention. With them on the list your
          balance sheet is your whole net worth, not a piece of it.
        </Text>

        <Group title="What you own" list={owns} kind="owns" tone={C.ink} />
        <Group title="What you owe" list={owes} kind="owes" tone={C.danger} />

        {(!!owns.length || !!owes.length) && (
          <View style={[S.card, { marginTop: 22 }]}>
            <Text style={S.eyebrow}>These add up to</Text>
            <View style={[S.row, { marginTop: 6, gap: 12 }]}>
              <CardFigure label="OWNED">{'₹'}{fmt0(sum(owns))}</CardFigure>
              <CardFigure label="OWED" tone={C.danger}>{'₹'}{fmt0(sum(owes))}</CardFigure>
            </View>
            <Text style={[S.hint, { marginTop: 8 }]}>
              Both are already in the balance sheet under Books.
            </Text>
          </View>
        )}

        {/* MONEY TAKEN FOR THE HOUSE, AND WHY IT IS NOT ON THIS LIST.
            He will look for it, so it is answered before he asks. */}
        <Text style={[S.hint, { marginTop: 22, lineHeight: 18 }]}>
          Money you take for the house does not belong here. When it leaves the
          till or the bank your cash figure has already fallen and your capital
          with it, so writing it down again would take it off twice. If you took
          it without writing it down, put it in under Money out instead.
        </Text>
      </ScrollView>

      {/* the one being added or changed */}
      {!!edit && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
                       backgroundColor: '#3B3A35DD' }}>
          <View style={{ backgroundColor: C.bg, borderBottomLeftRadius: 26,
                         borderBottomRightRadius: 26, padding: 18, maxHeight: '90%' }}>
            <View style={S.row}>
              <Text style={[S.h1, { flex: 1 }]}>
                {KINDS.find((x) => x.k === edit.kind).label}
              </Text>
              <TouchableOpacity onPress={() => setEdit(null)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: C.muted }}>CANCEL</Text>
              </TouchableOpacity>
            </View>

            <Text style={[S.label, { marginTop: 16 }]}>WHAT IS IT</Text>
            <Box autoFocus style={{ marginTop: 6 }} value={edit.name}
              placeholder={edit.kind === 'owns' ? 'The shop, Tata Ace' : 'Bank loan'}
              onChangeText={(t) => setEdit((e) => ({ ...e, name: t }))} />

            <Text style={[S.label, { marginTop: 14 }]}>
              {edit.kind === 'owns' ? 'WHAT IT IS WORTH' : 'HOW MUCH IS STILL OWED'}
            </Text>
            <Box style={{ marginTop: 6 }} keyboardType="numeric" value={edit.amount}
              onChangeText={(t) => setEdit((e) => ({ ...e, amount: t }))} />

            <Text style={[S.label, { marginTop: 14 }]}>A NOTE, IF YOU WANT ONE</Text>
            <Box style={{ marginTop: 6 }} value={edit.note}
              placeholder={edit.kind === 'owns' ? 'Fancy Bazar' : 'Federal Bank, 5 years'}
              onChangeText={(t) => setEdit((e) => ({ ...e, note: t }))} />

            {/* FROM WHEN IT COUNTS. A loan taken in August has no business on
                a sheet drawn up in July, and a sheet is often asked for as at
                a date gone by. */}
            <View style={[S.row, { marginTop: 14, gap: 10 }]}>
              <View style={{ flex: 1 }}>
                <Text style={S.label}>COUNTS FROM</Text>
                <Text style={{ fontSize: 15, fontWeight: '700', color: C.ink, marginTop: 4 }}>
                  {showDate(edit.as_on)}
                </Text>
              </View>
              <CalButton value={edit.as_on} title="From when does this count?"
                onPick={(iso) => setEdit((e) => ({ ...e, as_on: iso }))} />
            </View>

            <TouchableOpacity onPress={save} disabled={busy}
              style={[S.btn, { marginTop: 20 }, busy && { backgroundColor: C.faint }]}>
              <Text style={S.btnText}>{busy ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </Screen>
  );
}
