import React, { useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Alert, Modal,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { useApp } from '../AppContext';
import { fmt0, num, settle, today } from '../lib/money';
import { Box, Head, KeyForm, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// THE SHOP'S ACCOUNTS.
//
// "Bank" used to be one word covering every account a shop has. A trader with
// a current account, an OD account and the one his UPI lands in could not
// tell them apart, and a bank book that mixes three of them reconciles
// against none.
//
// The opening figure matters as much as the name: without it the bank book
// starts at nil and every balance it shows afterwards is wrong by the same
// amount. It is asked for here, once, with the date it was true on.

const dmy = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}` : '');

const blank = { name: '', opening: '', opening_on: '', is_default: false };

export default function BanksScreen({ navigation }) {
  const { org, isOwner } = useApp();
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);
  const [cash, setCash] = useState('');
  // THE DAY THE BOOKS BEGAN, NOT A DATE HE HAS TO THINK ABOUT.
  //
  // An opening balance IS the figure on the day the books started — there is
  // no other day it could be. Asking for it invited a different answer on
  // every account, and a cash book that starts on four different days does
  // not add up to anything. It is now worked out and shown, not typed.
  const [cashOn, setCashOn] = useState(today());
  const [bookDay, setBookDay] = useState(today());

  const load = useCallback(async () => {
    const [{ data }, { data: o }] = await Promise.all([
      supabase.from('bank_accounts').select('*').order('name'),
      supabase.from('orgs').select('opening_cash, opening_cash_on, created_at').eq('id', org.id).maybeSingle(),
    ]);
    setRows(data || []);
    if (o) {
      const began = String(o.created_at || '').slice(0, 10) || today();
      setBookDay(began);
      setCash(o.opening_cash ? String(o.opening_cash) : '');
      // a date already entered is left exactly as it is — rewriting it would
      // move every figure in the cash book after it
      setCashOn(o.opening_cash_on || began);
    }
  }, [org?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const save = async () => {
    if (!edit.name.trim()) return Alert.alert('Name it', 'What do you call this account?');
    const body = {
      org_id: org.id,
      name: edit.name.trim(),
      opening: num(edit.opening),
      opening_on: edit.opening_on || bookDay || null,
      is_default: !!edit.is_default,
      is_active: true,
    };
    // ONE DEFAULT, NOT THREE.
    //
    // Marking an account as the default did not unmark the one before it, so a
    // shop could end up with two or three "DEFAULT" chips and every screen
    // that asks for the default account getting whichever came back first.
    if (body.is_default) {
      const clear = supabase.from('bank_accounts').update({ is_default: false })
        .eq('org_id', org.id);
      const { error: cErr } = await (edit.id ? clear.neq('id', edit.id) : clear);
      if (cErr) return Alert.alert('Could not save', sayPlainly(cErr));
    }
    const { error } = edit.id
      ? await supabase.from('bank_accounts').update(body).eq('id', edit.id)
      : await supabase.from('bank_accounts').insert(body);
    if (error) return Alert.alert('Could not save', sayPlainly(error));
    setEdit(null); load();
  };

  const retire = (a) => Alert.alert('Close this account?',
    `${a.name} stops being offered on new entries. Everything already against `
    + 'it stays exactly where it is.',
    [{ text: 'Keep it' },
     { text: 'Close it', style: 'destructive', onPress: async () => {
         const { error } = await supabase.from('bank_accounts')
           .update({ is_active: false }).eq('id', a.id);
         if (error) return Alert.alert('Could not', sayPlainly(error));
         load();
       } }]);

  const saveCash = async () => {
    const { error } = await supabase.from('orgs')
      .update({ opening_cash: num(cash), opening_cash_on: cashOn || bookDay || null })
      .eq('id', org.id);
    if (error) return Alert.alert('Could not save', sayPlainly(error));
    Alert.alert('Saved', 'The cash book starts from that figure.');
  };

  if (!isOwner) {
    return (
      <Screen>
        <Head navigation={navigation} title="Accounts" />
        <Text style={{ padding: 24, fontSize: 14, color: C.muted, lineHeight: 20 }}>
          Only the owner of the firm can set up its accounts.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <Head navigation={navigation} title="Cash & bank accounts">
        <TouchableOpacity onPress={() => setEdit({ ...blank })}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: C.accent }}>+ NEW</Text>
        </TouchableOpacity>
      </Head>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        <View style={S.card}>
          <Text style={S.eyebrow}>The cash box</Text>
          <Text style={{ fontSize: 12.5, color: C.muted, lineHeight: 18, marginBottom: 10 }}>
            What was in the drawer on the day you started using Skwik. Without
            it the cash book begins at nil and every figure after it is short by
            the same amount.
          </Text>
          <Text style={S.label}>Opening cash</Text>
          <Box style={[{ marginTop: 6 }, S.num]} keyboardType="numeric" placeholder="0"
            value={cash} onChangeText={setCash} onBlur={() => setCash(settle(cash))} />
          <Text style={[S.num, { fontSize: 12, color: C.muted, marginTop: 8 }]}>
            as on {dmy(cashOn)} — the day your books start
          </Text>
          <TouchableOpacity style={[S.btn, { marginTop: 14, paddingVertical: 12 }]}
            onPress={saveCash}>
            <Text style={[S.btnText, { fontSize: 14.5 }]}>Save the cash opening</Text>
          </TouchableOpacity>
        </View>

        <Text style={[S.eyebrow, { marginTop: 22 }]}>Bank accounts</Text>

        {rows.filter((r) => r.is_active).map((a) => (
          <TouchableOpacity key={a.id} onPress={() => setEdit({
            ...a, opening: a.opening ? String(a.opening) : '',
            opening_on: a.opening_on || bookDay,
          })}
            style={[S.row, { paddingVertical: 14, borderBottomWidth: 1,
                             borderBottomColor: C.line }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 15.5, fontWeight: '700', color: C.ink }}>
                {a.name}{a.is_default ? '  ' : ''}
                {a.is_default && <Text style={S.chip}> DEFAULT </Text>}
              </Text>
              <Text style={[S.num, { fontSize: 11.5, color: C.muted, marginTop: 2 }]}>
                opened ₹{fmt0(a.opening)}{a.opening_on ? ` on ${dmy(a.opening_on)}` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={() => retire(a)}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={{ paddingHorizontal: 8 }}>
              <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.danger }}>CLOSE</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        ))}

        {!rows.filter((r) => r.is_active).length && (
          <View style={{ paddingVertical: 24, alignItems: 'center' }}>
            <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.ink }}>
              No bank accounts yet
            </Text>
            <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, textAlign: 'center',
                           lineHeight: 18, paddingHorizontal: 20 }}>
              Add one and every bank receipt and payment can say which account it
              went through.
            </Text>
            <TouchableOpacity style={[S.btn, { marginTop: 12, paddingVertical: 11,
                                               paddingHorizontal: 18 }]}
              onPress={() => setEdit({ ...blank, is_default: true })}>
              <Text style={[S.btnText, { fontSize: 14 }]}>Add an account</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <Modal visible={!!edit} animationType="slide" onRequestClose={() => setEdit(null)}>
        {!!edit && (
          <KeyForm style={S.screen} keyboardShouldPersistTaps="handled"
                   contentContainerStyle={{ padding: 20, paddingTop: 54 }}>
            <Text style={{ fontSize: 23, fontWeight: '700', color: C.ink }}>
              {edit.id ? edit.name || 'Account' : 'New bank account'}
            </Text>

            <Text style={[S.label, { marginTop: 20 }]}>What you call it</Text>
            <Box style={{ marginTop: 6 }} autoFocus={!edit.id}
              placeholder="SBI current, HDFC 4471"
              value={edit.name} onChangeText={(t) => setEdit((e) => ({ ...e, name: t }))} />

            <Text style={[S.label, { marginTop: 16 }]}>What was in it to begin with</Text>
            <Box style={[{ marginTop: 6 }, S.num]} keyboardType="numeric" placeholder="0"
              value={edit.opening}
              onChangeText={(t) => setEdit((e) => ({ ...e, opening: t }))}
              onBlur={() => setEdit((e) => ({ ...e, opening: settle(e.opening) }))} />

            <Text style={[S.num, { fontSize: 12, color: C.muted, marginTop: 8 }]}>
              as on {dmy(edit.opening_on || bookDay)} — the day your books start
            </Text>

            <TouchableOpacity
              onPress={() => setEdit((e) => ({ ...e, is_default: !e.is_default }))}
              style={[S.row, { marginTop: 20, gap: 10 }]}>
              <View style={{ width: 24, height: 24, borderRadius: 7, borderWidth: 1.5,
                             alignItems: 'center', justifyContent: 'center',
                             borderColor: edit.is_default ? C.accent : C.greyB,
                             backgroundColor: edit.is_default ? C.accent : 'transparent' }}>
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>
                  {edit.is_default ? '✓' : ''}
                </Text>
              </View>
              <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: C.ink }}>
                Offer this one first on a bank entry
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={[S.btn, { marginTop: 26 }]} onPress={save}>
              <Text style={S.btnText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEdit(null)}
              style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Cancel</Text>
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </KeyForm>
        )}
      </Modal>
    </Screen>
  );
}
