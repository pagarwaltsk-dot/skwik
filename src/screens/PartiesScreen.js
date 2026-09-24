import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Modal, Alert, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { num, today } from '../lib/money';
import { STATES } from '../lib/states';
import { Box, Head, KeyForm, Screen } from '../components/Chrome';
import { StateField } from '../components/Pickers';
import { CalButton } from '../components/DatePick';
import { C, S } from '../theme';
import { sayPlainly } from '../lib/offline';

// CUSTOMERS AND SUPPLIERS.
//
// Names still save themselves while billing. This screen is for everything
// the bill cannot ask for: the GST number that decides whether a customer is
// charged IGST, the phone the bill is sent to, and what he owed you before
// Skwik started.

const empty = {
  name: '', kind: 'customer', phone: '', gstin: '', area: '', address: '',
  state_code: '', state_name: '', price_list: 1,
  opening_balance: '', opening_type: 'owes_you',
  opening_date: today(),
};

export default function PartiesScreen({ navigation }) {
  const { org } = useApp();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  // CUSTOMERS AND SUPPLIERS ARE TWO BOOKS, NOT ONE.
  //
  // One list holding both is a list a shopkeeper has to read carefully, and
  // the two are never wanted at the same moment: he is either chasing money
  // or paying it. Someone who is both — he buys from him and sells to him —
  // appears under both, which is correct, because he is both.
  const [side, setSide] = useState('customer');

  // A NAME AND WHICH SIDE HE IS ON. THAT IS THE WHOLE FORM.
  //
  // Eleven boxes opened for a walk-in who paid cash and left: phone, GST
  // number, state, area, address, price list, opening balance, its date. A
  // shop that is not registered cannot charge IGST, so the state and the GST
  // number decide nothing for it at all — and every one of them was optional
  // anyway, which the form never said. So the form now asks the two questions
  // it needs and keeps the rest one tap away, for the day he wants them.
  const [more, setMore] = useState(false);

  // Registered shops still see the GST number and the state without asking,
  // because those two change what a bill CARRIES. Nothing is taken away from
  // anybody — it is a question of what opens first.
  const gstShop = !!org?.is_gst_registered;

  // name → phone → GST → state → address → what was outstanding → its date
  const fName  = useRef(null), fPhone = useRef(null), fGstin = useRef(null);
  const fArea  = useRef(null), fAddr  = useRef(null);
  const fOpen  = useRef(null);
  const fDate  = useRef(null);

  // newest first, like every other list in the app: the name he just wrote on
  // a bill is the one he is looking for
  // Paged, for the same reason as the item list: past 1,000 names the rest
  // were simply missing, with no error to explain it.
  const load = () => allRows(() => supabase.from('parties').select('*')
    .order('created_at', { ascending: false }).order('id'))
    .then((data) => setRows(data || []))
    .catch(() => {});
  useFocusEffect(useCallback(() => { load(); }, []));

  const shown = rows
    // ALL is there so nobody can ever be invisible. A name saved with an odd
    // kind — or with none at all — would otherwise sit in the book unreachable
    // from either tab, which is worse than a list that is slightly too long.
    .filter((r) => {
      if (side === 'all') return true;
      const k = String(r.kind || 'customer').toLowerCase();
      return k === 'both' || k === side;
    })
    .filter((r) =>
      `${r.name} ${r.phone || ''} ${r.gstin || ''} ${r.area || ''}`
        .toLowerCase().includes(q.toLowerCase()));

  const counts = rows.reduce((a, r) => {
    const k = String(r.kind || 'customer').toLowerCase();
    if (k === 'both') { a.customer += 1; a.supplier += 1; } else if (a[k] != null) a[k] += 1;
    a.all += 1;
    return a;
  }, { customer: 0, supplier: 0, all: 0 });

  const set = (k) => (v) => setEdit((e) => ({ ...e, [k]: v }));

  // Typing a GST number fills in the state by itself — the first two digits
  // are the state code, and getting it wrong is what puts CGST on a bill that
  // should carry IGST.
  const setGstin = (t) => {
    const g = t.toUpperCase().trim();
    const code = g.slice(0, 2);
    setEdit((e) => ({ ...e, gstin: g,
      ...(STATES[code] ? { state_code: code, state_name: STATES[code] } : {}) }));
  };

  const setStateCode = (t) => {
    const code = t.replace(/\D/g, '').slice(0, 2);
    setEdit((e) => ({ ...e, state_code: code, state_name: STATES[code] || '' }));
  };

  const save = async () => {
    if (!edit.name.trim()) return Alert.alert('Name needed', 'Type the name.');
    const g = edit.gstin.trim();
    if (g && g.length !== 15) {
      return Alert.alert('Check the GST number', 'A GSTIN is 15 characters, or leave it empty.');
    }
    if (g && !STATES[g.slice(0, 2)]) {
      return Alert.alert('Check the GST number', 'The first two digits are not a state code.');
    }

    const body = {
      org_id: org.id,
      name: edit.name.trim(),
      kind: edit.kind,
      phone: edit.phone.trim() || null,
      gstin: g || null,
      is_registered: !!g,
      area: (edit.area || '').trim() || null,
      address: edit.address.trim() || null,
      state_code: edit.state_code || org.state_code,
      state_name: edit.state_name || org.state_name,
      price_list: Number(edit.price_list) === 2 ? 2 : 1,
      // the amount is a plain number; which way it runs is opening_type's job.
      // A minus typed in here used to be stored as a minus, and the ledger and
      // the udhar list then disagreed about that customer.
      opening_balance: Math.abs(num(edit.opening_balance)),
      opening_type: edit.opening_type,
      opening_date: edit.opening_date || null,
    };

    const { error } = edit.id
      ? await supabase.from('parties').update(body).eq('id', edit.id)
      : await supabase.from('parties').insert(body);
    if (error) return Alert.alert('Could not save', sayPlainly(error));
    setEdit(null); load();
  };

  // ALL is not a kind anyone can be, so a name added from the All tab is
  // added as a customer — that is what nearly every new name is.
  const newKind = side === 'all' ? 'customer' : side;
  // The + NEW button and the "add what he typed" row must open the very same
  // form, or the two would drift apart the first time either is touched.
  const startNew = (name = '') => { setMore(false); setEdit({ ...empty, kind: newKind, name }); };

  // An existing party who already HAS these details opens with them showing.
  // Hiding a filled-in box is how a phone number goes missing.
  const startEdit = (p) => { setMore(!!(p.phone || p.gstin || p.area || p.address
      || Number(p.opening_balance) || Number(p.price_list) === 2));
    return setEdit({
    ...empty, ...p,
    phone: p.phone || '', gstin: p.gstin || '',
    area: p.area || '', address: p.address || '',
    state_code: p.state_code || '', state_name: p.state_name || '',
    price_list: Number(p.price_list) === 2 ? 2 : 1,
    opening_balance: p.opening_balance ? String(p.opening_balance) : '',
    opening_type: p.opening_type || 'owes_you',
    opening_date: p.opening_date || today(),
  }); };

  const Label = ({ children, top = 14 }) => (
    <Text style={[S.label, { marginTop: top }]}>{children}</Text>
  );

  const Pick = ({ options, value, onChange }) => (
    <View style={[S.row, { marginTop: 6, gap: 8 }]}>
      {options.map((o) => {
        const on = value === o.v;
        return (
          <TouchableOpacity key={String(o.v)} onPress={() => onChange(o.v)}
            style={{ flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center',
                     borderWidth: 1, borderColor: on ? C.accent : C.line,
                     backgroundColor: on ? C.accentSoft : C.surface }}>
            <Text style={{ fontSize: 13.5, fontWeight: '600', color: on ? C.accent : C.muted }}>
              {o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <Screen>
      <Head navigation={navigation} title="Customers & suppliers">
        <TouchableOpacity onPress={() => startNew()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: C.accent }}>+ NEW</Text>
        </TouchableOpacity>
      </Head>

      <View style={[S.row, { paddingHorizontal: 16, paddingTop: 12, gap: 8 }]}>
        {[['customer', 'Customers'], ['supplier', 'Suppliers'], ['all', 'All']].map(([v, label]) => {
          const on = side === v;
          return (
            <TouchableOpacity key={v} onPress={() => setSide(v)}
              style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                       borderWidth: 1, borderColor: on ? C.accent : C.line,
                       backgroundColor: on ? C.accentSoft : C.surface }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: on ? C.accent : C.muted }}>
                {label} <Text style={[S.num, { fontSize: 12.5 }]}>{counts[v]}</Text>
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={{ padding: 16, paddingTop: 12 }}>
        <TextInput style={S.input} placeholder="Search a name, area, phone or GST number"
          placeholderTextColor={C.faint} value={q} onChangeText={setQ}  returnKeyType="search" />
      </View>

      <FlatList
        data={shown}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
        ListEmptyComponent={
          // A SEARCH THAT FINDS NOTHING IS THE MOMENT TO ADD THE NAME.
          //
          // He searched for a customer who was not in the book yet, got an
          // empty list, then went up to + NEW and typed the same name a
          // second time. The name is already in his hand here, so the row
          // carries it straight into the form.
          q.trim() ? (
            <TouchableOpacity onPress={() => startNew(q.trim())}
              style={{ paddingVertical: 18, marginTop: 14, borderBottomWidth: 1,
                       borderBottomColor: C.line }}>
              <Text style={{ fontSize: 16.5, fontWeight: '800', color: C.accent }}>
                + Add {q.trim()} as a new {newKind}
              </Text>
              <Text style={{ fontSize: 12, fontWeight: '600', color: C.muted, marginTop: 3 }}>
                Nobody by that name in the book yet.
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center', marginTop: 30,
                           lineHeight: 20 }}>
              No {side === 'supplier' ? 'suppliers' : side === 'all' ? 'names' : 'customers'} yet.
              Names save themselves when you make a bill, or add one here with the
              details filled in.
            </Text>
          )}
        renderItem={({ item }) => (
          <View style={[S.row, { borderBottomWidth: 1, borderBottomColor: C.line }]}>
            <TouchableOpacity
              onPress={() => navigation.navigate('Ledger', { partyId: item.id })}
              style={{ flex: 1, paddingVertical: 16 }}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: C.ink }}>{item.name}</Text>
              <Text style={{ fontSize: 12, fontWeight: '600', color: C.muted, marginTop: 2 }}>
                {[item.area, item.phone, item.state_name, item.gstin]
                  .filter(Boolean).join(' · ') || 'No details yet'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => startEdit(item)}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              style={{ paddingHorizontal: 8, paddingVertical: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: C.accent }}>EDIT</Text>
            </TouchableOpacity>
          </View>
        )} />

      <Modal visible={!!edit} animationType="slide" onRequestClose={() => setEdit(null)}>
        {!!edit && (
          <KeyForm style={S.screen} keyboardShouldPersistTaps="handled"
                      contentContainerStyle={{ padding: 20, paddingTop: 54 }}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: C.ink }}>
              {edit.id ? edit.name || 'Edit' : 'New customer or supplier'}
            </Text>

            <Label top={18}>Name</Label>
            {/* Next goes to the next box THAT IS ON THE SCREEN. Pointing it at
                a hidden one left a "next" key that did nothing at all. */}
            <Box ref={fName} next={gstShop ? fGstin : (more ? fPhone : undefined)}
              onSubmit={save} style={{ marginTop: 6 }} value={edit.name}
              onChangeText={set('name')} placeholder="Sri Ganesh Store" />

            <Label>They are a</Label>
            {/* BOTH IS A REAL ANSWER, AND THE APP ALREADY UNDERSTANDS IT.
                The list filters on it, the counters split it, the bill screen
                accepts it and Fill reads it — but this box offered only two
                of the three. A man who buys from you and sells to you opened
                with NEITHER chip lit, and the first save turned him into
                whichever one was tapped, silently. */}
            <Pick value={edit.kind} onChange={set('kind')}
              options={[{ v: 'customer', label: 'Customer' },
                        { v: 'supplier', label: 'Supplier' },
                        { v: 'both', label: 'Both' }]} />

            {gstShop && (
              <>
              <Label>GST number</Label>
              <Box ref={fGstin} next={more ? fArea : undefined} onSubmit={save}
                style={{ marginTop: 6 }}
                autoCapitalize="characters" maxLength={15}
                value={edit.gstin} onChangeText={setGstin} placeholder="Leave empty if unregistered" />

              {/* He is asked which STATE, not which number. The code behind it
                  is Skwik's business, and it fills itself in. */}
              <Label>State</Label>
              <View style={{ marginTop: 6 }}>
                <StateField value={String(edit.state_code || '')}
                  homeCode={String(org?.state_code || '')}
                  onChange={(code, name) =>
                    setEdit((e) => ({ ...e, state_code: code, state_name: name }))} />
              </View>
              <Text style={S.hint}>
                {edit.state_name
                  ? (String(edit.state_code) === String(org?.state_code)
                      ? 'Same state as you, so bills carry CGST and SGST.'
                      : 'Another state, so bills carry IGST.')
                  : 'This decides whether a bill carries CGST and SGST, or IGST.'}
              </Text>
              </>
            )}

            {/* ONE TAP FOR THE REST. It says how many are behind it so it is
                not a door into the unknown. */}
            {!more ? (
              <TouchableOpacity onPress={() => setMore(true)}
                style={{ marginTop: 20, paddingVertical: 12, borderRadius: 11,
                         borderWidth: 1.5, borderColor: C.line, backgroundColor: C.surface,
                         alignItems: 'center' }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: C.accent }}>
                  + Add more details
                </Text>
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                  Phone{gstShop ? '' : ', GST number, state'}, address, price list, opening balance
                </Text>
              </TouchableOpacity>
            ) : (
              <>
              {!gstShop && (
                <>
                <Label>GST number</Label>
                <Box ref={fGstin} next={fPhone} style={{ marginTop: 6 }}
                  autoCapitalize="characters" maxLength={15}
                  value={edit.gstin} onChangeText={setGstin} placeholder="Leave empty if unregistered" />

                {/* He is asked which STATE, not which number. The code behind it
                    is Skwik's business, and it fills itself in. */}
                <Label>State</Label>
                <View style={{ marginTop: 6 }}>
                  <StateField value={String(edit.state_code || '')}
                    homeCode={String(org?.state_code || '')}
                    onChange={(code, name) =>
                      setEdit((e) => ({ ...e, state_code: code, state_name: name }))} />
                </View>
                <Text style={S.hint}>
                  {edit.state_name
                    ? (String(edit.state_code) === String(org?.state_code)
                        ? 'Same state as you, so bills carry CGST and SGST.'
                        : 'Another state, so bills carry IGST.')
                    : 'This decides whether a bill carries CGST and SGST, or IGST.'}
                </Text>
                </>
              )}
              <Label>Phone</Label>
              <Box ref={fPhone} next={fArea} style={[S.num, { marginTop: 6 }]} keyboardType="phone-pad"
                value={edit.phone} onChangeText={set('phone')} placeholder="98640 12345" />

              <Label>Area</Label>
              <Box ref={fArea} next={fAddr} style={{ marginTop: 6 }}
                value={edit.area} onChangeText={set('area')}
                placeholder="Fancy Bazar, Ward 4, GS Road" />

              <Label>Address</Label>
              <Box ref={fAddr} next={fOpen} style={{ marginTop: 6 }}
                value={edit.address} onChangeText={set('address')}
                placeholder="Shop and street" />

              {/* A price list is what you CHARGE somebody, so it is a question
                  about a customer only. Asking it about a supplier — who sets
                  his own rates — is a question with no answer, and he was
                  answering it anyway and wondering what it did. Somebody who
                  is both is still asked, because he is still sold to.
                  The list keeps saving either way, so a supplier turned back
                  into a customer keeps the one he had. */}
              {edit.kind !== 'supplier' && (
                <>
                  <Label>Which price list</Label>
                  <Pick value={Number(edit.price_list)} onChange={set('price_list')}
                    options={[{ v: 1, label: org?.price1_name || 'Wholesale' },
                              { v: 2, label: org?.price2_name || 'Retail' }]} />
                </>
              )}

              <View style={{ marginTop: 24, padding: 14, backgroundColor: C.surface,
                             borderWidth: 1, borderColor: C.line, borderRadius: 12 }}>
                <Text style={S.eyebrow}>Before Skwik</Text>
                <Text style={{ fontSize: 12.5, color: C.muted, marginBottom: 10, lineHeight: 18 }}>
                  What was already outstanding when you started. Leave it empty if
                  nothing was.
                </Text>

                <Box ref={fOpen} next={fDate} style={S.num} keyboardType="numeric"
                  value={edit.opening_balance} onChangeText={set('opening_balance')}
                  placeholder="0" />

                <Pick value={edit.opening_type} onChange={set('opening_type')}
                  options={[{ v: 'owes_you', label: 'They owe you' },
                            { v: 'you_owe', label: 'You owe them' }]} />

                <Label top={12}>As on</Label>
                <View style={[S.row, { marginTop: 6, gap: 8, alignItems: 'center' }]}>
                  <Box ref={fDate} onSubmit={save} style={[S.num, { flex: 1, marginBottom: 0 }]}
                    keyboardType="numbers-and-punctuation"
                    value={edit.opening_date} onChangeText={set('opening_date')}
                    placeholder="2026-04-01" />
                  <CalButton value={edit.opening_date}
                    onPick={(iso) => set('opening_date')(iso)}
                    title="Outstanding as on which day?" size={48} />
                </View>
              </View>
              </>
            )}

            <TouchableOpacity style={[S.btn, { marginTop: 24 }]} onPress={save}>
              <Text style={S.btnText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEdit(null)}
              style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>Cancel</Text>
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </KeyForm>
        )}
      </Modal>
    </Screen>
  );
}
