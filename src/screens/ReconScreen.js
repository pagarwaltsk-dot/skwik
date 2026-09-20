import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Modal, Linking,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, today } from '../lib/money';
import { readPickedFile } from '../lib/pickfile';
import { parse2b, reconcile, bySupplier } from '../lib/gstr2b';
import { sayPlainly } from '../lib/offline';
import { Bar, BackButton, MoreButton, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// WHICH OF MY SUPPLIERS HAS NOT FILED.
//
// The tax on a purchase bill is only his to claim once the supplier has
// declared it. Nothing at a shopkeeper's price tells him which ones have not,
// so he finds out months later when his accountant reverses the credit.
//
// He downloads the 2B from the portal and hands it over here. Skwik does the
// rest, and tells him who to ring.

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

// why a pair is not a clean match, in words a shopkeeper can act on
const WHY = {
  DIFF_AMT:   'Same bill, the tax or the value does not agree',
  DIFF_NO:    'Same supplier, tax and date — his number is different',
  DIFF_GSTIN: 'Same firm, a different GST registration',
  FUZZY:      'The number is nearly the same — check it is the right bill',
  DIFF_PARTY: 'Bill and tax agree but the GST number does not. Check the ledger',
  WEAK:       'Paired on the amount alone. Confirm before you claim',
};

// Late filing and late entry both mean the two sides never line up inside one
// month, so the books are read wider than the file: three months back by
// default, which is what catches a supplier who files a month late.
const BACK = [
  { k: 3,  label: '3 months' },
  { k: 6,  label: '6 months' },
  { k: 12, label: 'A year' },
];

export default function ReconScreen({ navigation }) {
  const { org } = useApp();
  const [busy, setBusy]   = useState('');
  const [back, setBack]   = useState(3);
  const [res, setRes]     = useState(null);
  const [period, setPeriod] = useState('');
  const [open, setOpen]   = useState(null);     // the supplier being looked at

  const firstOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

  const pick = async () => {
    setBusy('reading');
    try {
      const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false, type: '*/*' });
      if (r.canceled) return;
      const uri = r.assets?.[0]?.uri;
      if (!uri) return Alert.alert('Could not open that', 'No file came back.');

      const text = await readPickedFile(uri);
      const file = parse2b(text);
      if (file.problem) return Alert.alert('Could not read that file', file.problem);

      // the books, wide enough to catch late filing on either side
      const from = firstOf(new Date(new Date().getFullYear(),
                                    new Date().getMonth() - (back - 1), 1));
      // Paged: a busy shop can easily pass 1,000 purchase bills across the
      // months this looks at, and the ones past that were silently missing
      // from the reconciliation — which reads as the supplier not having
      // filed them.
      const data = await allRows(() => supabase.from('vouchers')
        .select('id, vtype, vdate, voucher_no, supplier_invoice_no, supplier_invoice_date,'
              + ' taxable, cgst, sgst, igst, total, printed_name, parties(name, gstin)')
        .in('vtype', ['purchase', 'purchase_return'])
        .gte('vdate', from).lte('vdate', today())
        .order('vdate').order('id'));

      setPeriod(file.period
        ? `${MONTHS[Number(file.period.slice(0, 2)) - 1]} ${file.period.slice(2)}`
        : '');
      setRes(reconcile({ purchases: data || [], portal: file.rows }));
    } catch (e) {
      Alert.alert('Could not read that file', sayPlainly(e));
    } finally { setBusy(''); }
  };

  const chase = (sup) => {
    const bills = sup.rows.filter((r) => r.field === 'onlyBooks').map((r) => r.row);
    if (!bills.length) return;
    const lines = bills.map((b) => `${b.docNo || '(no number)'} dt ${b.docDate} — ₹${fmt0(b.value)}`);
    const msg = `Namaste${sup.name ? ' ' + sup.name : ''},\n\n`
      + `These bills are not showing in our GSTR-2B, so we cannot take the input credit:\n\n`
      + lines.join('\n')
      + `\n\nPlease check and file them.\n\n${org?.name || ''}`;
    Linking.openURL(`whatsapp://send?text=${encodeURIComponent(msg)}`)
      .catch(() => Linking.openURL(`https://wa.me/?text=${encodeURIComponent(msg)}`))
      .catch(() => Alert.alert('No WhatsApp', 'WhatsApp is not installed on this phone.'));
  };

  const s = res?.summary;

  const Tile = ({ label, value, note, tone }) => (
    <View style={{ flex: 1, padding: 12, borderRadius: 12, borderWidth: 1,
                   borderColor: tone === 'bad' ? '#E7C4C2' : tone === 'ok' ? C.okLine : C.line,
                   backgroundColor: tone === 'bad' ? '#FBEDEC' : tone === 'ok' ? C.okSoft : C.surface }}>
      <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: .6, color: C.muted }}>
        {label.toUpperCase()}
      </Text>
      <Text style={[{ fontSize: 22, fontWeight: '800', marginTop: 4,
                      color: tone === 'bad' ? '#7E2C28' : tone === 'ok' ? '#0B5C34' : C.ink }, S.num]}>
        ₹{fmt0(value)}
      </Text>
      {!!note && <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>{note}</Text>}
    </View>
  );

  const Row = ({ k, v, tone }) => (
    <View style={[S.tline, { paddingVertical: 7 }]}>
      <Text style={{ fontSize: 14.5, color: C.muted }}>{k}</Text>
      <Text style={[{ fontSize: 14.5, fontWeight: '700',
                      color: tone === 'bad' ? C.danger : C.ink }, S.num]}>{v}</Text>
    </View>
  );

  return (
    <Screen>
      <Bar>
        <BackButton navigation={navigation} />
        <View style={{ flex: 1 }}>
          <Text style={S.barName}>Supplier credit</Text>
          <Text style={S.barSub}>{period ? `GSTR-2B ${period}` : 'GSTR-2B against your books'}</Text>
        </View>
        <MoreButton navigation={navigation} />
      </Bar>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>
        {!res && (
          <View style={S.card}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: C.ink }}>
              Which of your suppliers has not filed?
            </Text>
            <Text style={{ fontSize: 13, color: C.muted, marginTop: 8, lineHeight: 19 }}>
              The GST you pay a supplier is only yours to claim once he has declared
              that bill on the portal. Skwik reads the GSTR-2B file and puts it
              beside your purchases, so you know before you file, not after.
            </Text>
            <Text style={{ fontSize: 13, fontWeight: '700', color: C.ink, marginTop: 14 }}>
              On the GST portal
            </Text>
            <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 19 }}>
              Returns → Returns Dashboard → pick the month → GSTR-2B →
              Download → Generate JSON file to download. Save it on this phone,
              then tap below.
            </Text>

            <Text style={[S.label, { marginTop: 18 }]}>HOW FAR BACK TO COMPARE</Text>
            <View style={[S.row, { gap: 8, marginTop: 6 }]}>
              {BACK.map((b) => {
                const on = back === b.k;
                return (
                  <TouchableOpacity key={b.k} onPress={() => setBack(b.k)}
                    style={{ flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center',
                             borderWidth: 1, borderColor: on ? C.accent : C.line,
                             backgroundColor: on ? C.accentSoft : C.surface }}>
                    <Text style={{ fontSize: 13, fontWeight: '700',
                                   color: on ? C.accent : C.muted }}>{b.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 6, lineHeight: 16 }}>
              A supplier who files late turns up in a later month's file, and a bill
              entered late turns up in your books after its month has gone. Reading
              wider than one month catches both.
            </Text>

            <TouchableOpacity style={[S.btn, { marginTop: 18 }]} onPress={pick} disabled={!!busy}>
              <Text style={S.btnText}>{busy ? 'Reading…' : 'Open the 2B file'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {!!s && (
          <>
            <View style={[S.row, { gap: 10, marginBottom: 10 }]}>
              <Tile label="Safe to claim" value={s.safe} tone="ok"
                    note={`${s.matched} bills agree`} />
              <Tile label="At risk" value={s.atRisk} tone="bad"
                    note={`${s.onlyBooks} not filed by the supplier`} />
            </View>
            <View style={[S.row, { gap: 10, marginBottom: 12 }]}>
              <Tile label="Not in your books" value={s.missing}
                    note={`${s.onlyPortal} bills to enter`} />
              <Tile label="Needs a look" value={s.queriedTax}
                    note={`${s.different} matched with a query`} />
            </View>

            {(s.timing > 0 || s.noGstinTax > 0 || res.dupes.length > 0) && (
              <View style={[S.card, { marginBottom: 12 }]}>
                {s.timing > 0 && (
                  <Text style={{ fontSize: 12.5, color: C.muted, lineHeight: 18 }}>
                    {s.timing} bill{s.timing === 1 ? ' is' : 's are'} in both, a month or
                    more apart — filed late, or entered late. The credit belongs to the
                    later month.
                  </Text>
                )}
                {s.noGstinTax > 0 && (
                  <Text style={{ fontSize: 12.5, color: C.muted, lineHeight: 18, marginTop: 6 }}>
                    ₹{fmt0(s.noGstinTax)} of purchases have no GST number on the supplier,
                    so they cannot be matched at all. Add the GSTIN under Customers.
                  </Text>
                )}
                {res.dupes.length > 0 && (
                  <Text style={{ fontSize: 12.5, color: C.edit, lineHeight: 18, marginTop: 6,
                                 fontWeight: '700' }}>
                    {res.dupes.length} bill number{res.dupes.length === 1 ? '' : 's'} appear
                    more than once — the same purchase may be entered twice.
                  </Text>
                )}
              </View>
            )}

            {s.blocked > 0 && (
              <View style={{ backgroundColor: C.flagSoft, borderWidth: 1, borderColor: C.flagLine,
                             borderRadius: 12, padding: 12, marginBottom: 12 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: C.flagInk }}>
                  ₹{fmt0(s.blocked)} of this credit is blocked by the portal itself
                </Text>
                <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 3 }}>
                  The 2B marks it not available, whatever your books say.
                </Text>
              </View>
            )}

            <Text style={[S.eyebrow, { marginTop: 4 }]}>Supplier by supplier</Text>
            {bySupplier(res).map((sup) => (
              <TouchableOpacity key={sup.ctin || sup.name} onPress={() => setOpen(sup)}
                style={[S.line, { marginBottom: 8 }]}>
                <View style={S.row}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={S.lineNm}>{sup.name || sup.ctin || '—'}</Text>
                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                      {[sup.matched && `${sup.matched} agree`,
                        sup.different && `${sup.different} differ`,
                        sup.onlyBooks && `${sup.onlyBooks} not filed`,
                        sup.onlyPortal && `${sup.onlyPortal} not in books`]
                        .filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  {sup.atRisk > 0 && (
                    <Text style={[{ fontSize: 15, fontWeight: '800', color: C.danger }, S.num]}>
                      ₹{fmt0(sup.atRisk)}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            ))}

            <TouchableOpacity style={[S.btnGhost, { marginTop: 14 }]}
              onPress={() => { setRes(null); setPeriod(''); }}>
              <Text style={S.ghostText}>Compare another month</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      {/* one supplier, bill by bill */}
      <Modal visible={!!open} transparent animationType="slide"
             onRequestClose={() => setOpen(null)}>
        <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22,
                         padding: 18, maxHeight: '86%' }}>
            {!!open && (
              <ScrollView>
                <Text style={{ fontSize: 20, fontWeight: '800', color: C.ink }}>
                  {open.name || open.ctin}
                </Text>
                {!!open.ctin && (
                  <Text style={{ fontSize: 12, fontWeight: '600', color: C.muted, marginTop: 2 }}>
                    {open.ctin}
                  </Text>
                )}

                {open.rows.filter((r) => r.field === 'onlyBooks').length > 0 && (
                  <View style={{ marginTop: 16 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: C.danger }}>
                      He has not filed these
                    </Text>
                    {open.rows.filter((r) => r.field === 'onlyBooks').map((r, i) => (
                      <Row key={i} tone="bad" k={`${r.row.docNo || '—'} · ${r.row.docDate}`}
                           v={`₹${fmt0(r.row.tax)}`} />
                    ))}
                    <TouchableOpacity style={[S.btn, { marginTop: 12, backgroundColor: C.wa }]}
                      onPress={() => chase(open)}>
                      <Text style={S.btnText}>Ask him on WhatsApp</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {open.rows.filter((r) => r.field === 'different').length > 0 && (
                  <View style={{ marginTop: 18 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: C.edit }}>
                      Matched, but worth a look
                    </Text>
                    {open.rows.filter((r) => r.field === 'different').map((r, i) => (
                      <View key={i} style={{ marginTop: 10 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: C.ink }}>
                          {r.row.b.docNo || '—'} · {r.row.b.docDate}
                        </Text>
                        <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>
                          {WHY[r.row.cls] || 'Matched, please confirm'}
                        </Text>
                        <Row k="Your books" v={`₹${fmt0(r.row.b.tax)}`} />
                        <Row k="The portal"  v={`₹${fmt0(r.row.t.tax)}`}
                             tone={Math.abs(r.row.taxDiff) > 2 ? 'bad' : undefined} />
                        {r.row.b.docNo !== r.row.t.docNo && (
                          <Row k="His number" v={r.row.t.docNo || '—'} />
                        )}
                      </View>
                    ))}
                  </View>
                )}

                {open.rows.filter((r) => r.field === 'onlyPortal').length > 0 && (
                  <View style={{ marginTop: 18 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: C.ink }}>
                      Filed, but not in your books
                    </Text>
                    <Text style={{ fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 17 }}>
                      Enter these as purchases and the credit is yours.
                    </Text>
                    {open.rows.filter((r) => r.field === 'onlyPortal').map((r, i) => (
                      <Row key={i} k={`${r.row.docNo || '—'} · ${r.row.docDate}`}
                           v={`₹${fmt0(r.row.tax)}`} />
                    ))}
                  </View>
                )}

                {open.rows.filter((r) => r.field === 'matched').length > 0 && (
                  <View style={{ marginTop: 18 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: C.ok }}>
                      These agree
                    </Text>
                    {open.rows.filter((r) => r.field === 'matched').map((r, i) => (
                      <Row key={i} k={`${r.row.b.docNo || '—'} · ${r.row.b.docDate}`}
                           v={`₹${fmt0(r.row.b.tax)}`} />
                    ))}
                  </View>
                )}

                <TouchableOpacity onPress={() => setOpen(null)}
                  style={{ marginTop: 22, alignItems: 'center', paddingVertical: 12 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Close</Text>
                </TouchableOpacity>
                <View style={{ height: 20 }} />
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {busy === 'reading' && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
                       backgroundColor: '#3B3A35AA', alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700', marginTop: 12 }}>Comparing…</Text>
        </View>
      )}
    </Screen>
  );
}
