import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Modal,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0 } from '../lib/money';
import {
  sniff, itemsFromCsv, partiesFromCsv, itemsFromTallyXml, partiesFromTallyXml,
  itemsToCsv, partiesToCsv, billsToCsv, billLinesToCsv, tallyVouchersXml,
  looksMangled, base64ToBytes, decodeBytes,
  ITEMS_TEMPLATE, PARTIES_TEMPLATE,
} from '../lib/transfer';
import { C, S } from '../theme';

// BRINGING BOOKS IN, AND SENDING THEM OUT.
//
// A shopkeeper with 800 items in Tally will not retype them, and his
// accountant wants the month back in Tally at the end of it. Both directions
// live here.

const RANGES = [
  { k: 'all',   label: 'Everything' },
  { k: 'month', label: 'This month' },
  { k: 'last',  label: 'Last month' },
  { k: 'fy',    label: 'This year' },
];

const firstOfMonth = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

// READING THE FILE HE PICKED.
//
// Android hands a picked file over as a content:// address rather than a real
// path, and the two ways of reading one do not work in the same places. Inside
// Expo Go the newer reader is fenced off from anything outside the app's own
// folder, which is exactly where a picked file lands. So: try the modern way,
// and if it will not have it, go through Android's own content reader, which
// always can. One of the two always works.
async function readPickedFile(uri) {
  let asText, firstProblem;

  try {
    asText = await new File(uri).text();
  } catch (e) {
    firstProblem = e;
    try {
      asText = await LegacyFS.readAsStringAsync(uri, { encoding: 'utf8' });
    } catch (e2) {
      throw firstProblem || e2;
    }
  }

  // Readable? Then we are done, and nothing expensive happened.
  if (!looksMangled(asText)) return asText;

  // Not readable. Tally writes UTF-16 and the phone read it as UTF-8, so the
  // text is full of holes. Take the raw bytes instead and decode them here,
  // where we can see what encoding they really are.
  try {
    let b64;
    try { b64 = await new File(uri).base64(); }
    catch (e) { b64 = await LegacyFS.readAsStringAsync(uri, { encoding: 'base64' }); }
    const decoded = decodeBytes(base64ToBytes(b64));
    if (decoded && !looksMangled(decoded)) return decoded;
    return decoded || asText;
  } catch (e) {
    return asText;      // fall back to whatever we had
  }
}

function rangeDates(k) {
  const now = new Date();
  if (k === 'month') return [firstOfMonth(now), null];
  if (k === 'last') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end   = new Date(now.getFullYear(), now.getMonth(), 0);
    return [firstOfMonth(start), end.toISOString().slice(0, 10)];
  }
  if (k === 'fy') {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return [`${y}-04-01`, null];
  }
  return [null, null];
}

export default function TransferScreen({ navigation }) {
  const { org } = useApp();
  const [busy, setBusy]   = useState('');
  const [range, setRange] = useState('month');
  const [ready, setReady] = useState(null);   // what was read, waiting to be confirmed

  /* ---------------- out ---------------- */

  // Everything leaves the same way: write the file, then hand it to whatever
  // the phone uses to share — WhatsApp, Gmail, Drive, the accountant.
  const send = async (name, text, mime) => {
    const file = new File(Paths.cache, name);
    try { if (file.exists) file.delete(); } catch (e) { /* first time through */ }
    file.create();
    file.write(text);
    if (!(await Sharing.isAvailableAsync())) {
      return Alert.alert('Nothing to share with', 'This phone has no app set up to receive files.');
    }
    await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: name });
  };

  const exportItems = async () => {
    setBusy('items');
    try {
      const { data, error } = await supabase.from('items').select('*').order('name');
      if (error) throw error;
      if (!data?.length) return Alert.alert('Nothing to send', 'There are no items yet.');
      await send('skwik-items.csv', itemsToCsv(data), 'text/csv');
    } catch (e) { Alert.alert('Could not send', e.message || String(e)); }
    finally { setBusy(''); }
  };

  const exportParties = async () => {
    setBusy('parties');
    try {
      const { data, error } = await supabase.from('parties').select('*').order('name');
      if (error) throw error;
      if (!data?.length) return Alert.alert('Nothing to send', 'There are no customers yet.');
      await send('skwik-customers.csv', partiesToCsv(data), 'text/csv');
    } catch (e) { Alert.alert('Could not send', e.message || String(e)); }
    finally { setBusy(''); }
  };

  const fetchBills = async () => {
    const [from, to] = rangeDates(range);
    let qy = supabase.from('vouchers')
      .select('*, parties(name, gstin, state_name, state_code)')
      .order('vdate');
    if (from) qy = qy.gte('vdate', from);
    if (to)   qy = qy.lte('vdate', to);
    const { data, error } = await qy;
    if (error) throw error;
    return data || [];
  };

  const exportBills = async () => {
    setBusy('bills');
    try {
      const vs = await fetchBills();
      if (!vs.length) return Alert.alert('Nothing in that period', 'No bills were found.');
      await send('skwik-bills.csv', billsToCsv(vs), 'text/csv');
    } catch (e) { Alert.alert('Could not send', e.message || String(e)); }
    finally { setBusy(''); }
  };

  const exportBillLines = async () => {
    setBusy('lines');
    try {
      const vs = await fetchBills();
      if (!vs.length) return Alert.alert('Nothing in that period', 'No bills were found.');
      const ids = vs.map((v) => v.id);
      const { data: ls, error } = await supabase.from('voucher_lines')
        .select('*').in('voucher_id', ids);
      if (error) throw error;
      const byId = Object.fromEntries(vs.map((v) => [v.id, v]));
      const rows = (ls || []).map((l) => ({
        ...l,
        vdate: byId[l.voucher_id]?.vdate,
        voucher_no: byId[l.voucher_id]?.voucher_no,
        who: byId[l.voucher_id]?.parties?.name || byId[l.voucher_id]?.printed_name || '',
      })).sort((a, b) => String(a.vdate).localeCompare(String(b.vdate)));
      await send('skwik-bill-lines.csv', billLinesToCsv(rows), 'text/csv');
    } catch (e) { Alert.alert('Could not send', e.message || String(e)); }
    finally { setBusy(''); }
  };

  const exportTally = async () => {
    setBusy('tally');
    try {
      const vs = (await fetchBills()).filter((v) => v.vtype === 'sale' || v.vtype === 'purchase');
      if (!vs.length) {
        return Alert.alert('Nothing in that period',
          'Only bills and purchases go to Tally. Estimates are not accounting entries.');
      }
      const { data: ls, error } = await supabase.from('voucher_lines')
        .select('*').in('voucher_id', vs.map((v) => v.id)).order('line_no');
      if (error) throw error;
      const byV = {};
      (ls || []).forEach((l) => { (byV[l.voucher_id] = byV[l.voucher_id] || []).push(l); });
      await send('skwik-tally.xml', tallyVouchersXml({ org, vouchers: vs, linesByVoucher: byV }),
                 'application/xml');
    } catch (e) { Alert.alert('Could not send', e.message || String(e)); }
    finally { setBusy(''); }
  };

  /* ---------------- in ---------------- */

  const pick = async (what) => {
    setBusy(what === 'items' ? 'in-items' : 'in-parties');
    try {
      // Left where it is on purpose. Copying it into the app's cache is what
      // makes Expo Go refuse to read it, and Tally's XML is often reported as
      // a plain unknown file, so nothing is filtered out by type either.
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: false,
        type: '*/*',
      });
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset?.uri) return Alert.alert('Could not open that', 'No file came back.');

      const text = await readPickedFile(asset.uri);
      const kind = sniff(text);

      let read;
      if (what === 'items') {
        read = kind === 'csv' ? itemsFromCsv(text) : itemsFromTallyXml(text);
      } else {
        read = kind === 'csv' ? partiesFromCsv(text) : partiesFromTallyXml(text);
      }

      if (read.problem) return Alert.alert('Could not read that file', read.problem);
      if (!read.rows.length) return Alert.alert('Nothing found', 'That file had no rows we could use.');

      setReady({ what, rows: read.rows, name: asset.name || 'the file',
                 kind: kind === 'csv' ? 'a spreadsheet' : 'a Tally export' });
    } catch (e) {
      const msg = String(e?.message || e);
      Alert.alert('Could not read that file',
        /permission/i.test(msg)
          ? 'Android would not let Skwik open that file. Copy it into your '
            + 'phone\'s Downloads folder and pick it from there.'
          : msg);
    } finally { setBusy(''); }
  };

  // Names already in the book are updated, new ones are added. Nothing is
  // ever duplicated and nothing is ever removed.
  const commit = async () => {
    const { what, rows } = ready;
    setReady(null);
    setBusy('saving');
    try {
      const table = what === 'items' ? 'items' : 'parties';
      const { data: have } = await supabase.from(table).select('id, name');
      const byName = Object.fromEntries((have || []).map((r) => [r.name.trim().toLowerCase(), r.id]));

      let added = 0, updated = 0;
      const toAdd = [];

      for (const r of rows) {
        const body = what === 'items'
          ? { org_id: org.id, name: r.name, alias: r.alias || null, hsn: r.hsn || null,
              unit: r.unit || 'PCS', sale_price: r.sale_price, price2: r.price2,
              purchase_price: r.purchase_price, gst_rate: r.gst_rate,
              opening_stock: r.opening_stock }
          : { org_id: org.id, name: r.name, kind: r.kind || 'customer',
              gstin: r.gstin || null, is_registered: !!r.gstin, phone: r.phone || null,
              address: r.address || null,
              state_code: r.state_code || org.state_code,
              state_name: r.state_name || org.state_name,
              opening_balance: r.opening_balance || 0,
              opening_type: r.opening_type || 'owes_you' };

        const id = byName[r.name.trim().toLowerCase()];
        if (id) {
          const { error } = await supabase.from(table).update(body).eq('id', id);
          if (error) throw error;
          updated++;
        } else {
          toAdd.push(body); added++;
        }
      }

      // new ones go in blocks, so one long list is not one long wait
      for (let i = 0; i < toAdd.length; i += 100) {
        const { error } = await supabase.from(table).insert(toAdd.slice(i, i + 100));
        if (error) throw error;
      }

      Alert.alert('Done',
        `${added} new, ${updated} updated. Nothing was removed.`);
    } catch (e) {
      Alert.alert('Stopped part way', `${e.message || String(e)}\n\nWhat went in before the `
        + `problem is saved. Fix the file and bring it in again — names already `
        + `here are updated, not duplicated.`);
    } finally { setBusy(''); }
  };

  /* ---------------- screen ---------------- */

  const Row = ({ label, note, onPress, busyKey, tone }) => (
    <TouchableOpacity onPress={onPress} disabled={!!busy}
      style={{ paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: C.line,
               opacity: busy && busy !== busyKey ? 0.4 : 1 }}>
      <View style={S.row}>
        <Text style={{ flex: 1, fontSize: 16, fontWeight: '700',
                       color: tone === 'quiet' ? C.ink : C.accent }}>{label}</Text>
        {busy === busyKey && <ActivityIndicator size="small" color={C.accent} />}
      </View>
      {!!note && <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 18 }}>{note}</Text>}
    </TouchableOpacity>
  );

  return (
    <View style={S.screen}>
      <View style={[S.bar, { paddingTop: 46 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityLabel="Back"
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          style={{ paddingVertical: 8, paddingRight: 10, paddingLeft: 2 }}>
          <Text style={{ fontSize: 26, color: '#fff', opacity: 0.85 }}>‹</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.barName}>Import &amp; export</Text>
          <Text style={S.barSub}>Tally and spreadsheets</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        <Text style={S.eyebrow}>Bring your book in</Text>
        <Text style={{ fontSize: 13, color: C.muted, marginBottom: 6, lineHeight: 19 }}>
          From Tally: Gateway → Display → List of Accounts → Export, and choose
          XML. Or any spreadsheet saved as CSV. A name already here is updated,
          never duplicated.
        </Text>

        <Row label="Items" busyKey="in-items" onPress={() => pick('items')}
          note="Name, HSN, unit, rates and GST. Headings need not match exactly — Particulars, Rate and Per are all understood." />
        <Row label="Customers and suppliers" busyKey="in-parties" onPress={() => pick('parties')}
          note="Name, GST number, phone and what they owed you before. The GST number fills in the state, which decides IGST." />

        <View style={{ height: 26 }} />

        <Text style={S.eyebrow}>Send your book out</Text>

        <View style={[S.row, { gap: 6, marginBottom: 12 }]}>
          {RANGES.map((r) => {
            const on = range === r.k;
            return (
              <TouchableOpacity key={r.k} onPress={() => setRange(r.k)}
                style={{ flex: 1, paddingVertical: 7, borderRadius: 9, alignItems: 'center',
                         borderWidth: 1, borderColor: on ? C.accent : C.line,
                         backgroundColor: on ? C.accentSoft : C.surface }}>
                <Text numberOfLines={1}
                  style={{ fontSize: 12, fontWeight: '600', color: on ? C.accent : C.muted }}>
                  {r.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Row label="To Tally" busyKey="tally" onPress={exportTally}
          note={`Bills and purchases as a Tally XML your accountant imports with Gateway → Import → Vouchers. It uses the ledger names from Settings${org?.sales_ledger ? '' : ' — set those first, or it will use plain names like Sales and CGST'}.`} />
        <Row label="Bills, one row each" busyKey="bills" onPress={exportBills} tone="quiet"
          note="A spreadsheet of every bill with its tax split. For your own checking, or your accountant's." />
        <Row label="Bills, one row per item" busyKey="lines" onPress={exportBillLines} tone="quiet"
          note="Every line of every bill. This is the one to use for working out what sold." />
        <Row label="Items" busyKey="items" onPress={exportItems} tone="quiet"
          note="Your whole item list, in the same shape it can be brought back in." />
        <Row label="Customers and suppliers" busyKey="parties" onPress={exportParties} tone="quiet"
          note="Names, GST numbers, phones and balances." />

        <View style={{ height: 26 }} />

        <Text style={S.eyebrow}>Blank forms</Text>
        <Row label="Items form" tone="quiet" busyKey="t1"
          onPress={() => send('skwik-items-form.csv', ITEMS_TEMPLATE, 'text/csv')}
          note="Fill this in on a computer and bring it back." />
        <Row label="Customers form" tone="quiet" busyKey="t2"
          onPress={() => send('skwik-customers-form.csv', PARTIES_TEMPLATE, 'text/csv')} />

        <Text style={[S.hint, { marginTop: 22 }]}>
          Your whole book stays in Skwik. These files are copies — sending one
          out changes nothing here.
        </Text>
      </ScrollView>

      {/* ---------- what was read, before anything is saved ---------- */}
      <Modal visible={!!ready} transparent animationType="slide"
             onRequestClose={() => setReady(null)}>
        <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22,
                         padding: 20, paddingBottom: 28 }}>
            {!!ready && (
              <>
                <Text style={{ fontSize: 21, fontWeight: '700', color: C.ink }}>
                  {fmt0(ready.rows.length)} {ready.what === 'items' ? 'items' : 'names'} read
                </Text>
                <Text style={{ fontSize: 13, color: C.muted, marginTop: 6, lineHeight: 19 }}>
                  From {ready.name}, which looks like {ready.kind}. Nothing is saved yet.
                </Text>

                <View style={{ marginTop: 14, padding: 12, backgroundColor: C.surface,
                               borderWidth: 1, borderColor: C.line, borderRadius: 12 }}>
                  {ready.rows.slice(0, 5).map((r, i) => (
                    <Text key={i} numberOfLines={1}
                      style={{ fontSize: 13.5, color: C.ink, marginBottom: 4 }}>
                      {r.name}
                      <Text style={{ color: C.muted }}>
                        {ready.what === 'items'
                          ? `  ${r.hsn ? `HSN ${r.hsn} · ` : ''}₹${fmt0(r.sale_price)}`
                          : `  ${[r.gstin, r.phone].filter(Boolean).join(' · ')}`}
                      </Text>
                    </Text>
                  ))}
                  {ready.rows.length > 5 && (
                    <Text style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                      and {fmt0(ready.rows.length - 5)} more
                    </Text>
                  )}
                </View>

                <TouchableOpacity style={[S.btn, { marginTop: 18 }]} onPress={commit}>
                  <Text style={S.btnText}>Bring them in</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setReady(null)}
                  style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>
                    Not now
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {busy === 'saving' && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
                       backgroundColor: '#3B3A35AA', alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700', marginTop: 12 }}>Saving…</Text>
        </View>
      )}
    </View>
  );
}
