import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { showPurchase, showReturns, showReports, showTransfer, showStock } from '../lib/features';
import { useApp } from '../AppContext';
import { STATES } from './OnboardScreen';
import { Alert as RNAlert } from 'react-native';
import { Head } from '../components/Chrome';
import { C, S } from '../theme';

// Everything a shopkeeper can change about his own firm, on his phone.
// There is no computer screen and no admin panel anywhere: this is it.

const Section = ({ title, note, children }) => (
  <View style={{ marginTop: 22 }}>
    <Text style={{ fontSize: 17, fontWeight: '800', color: C.ink }}>{title}</Text>
    {!!note && (
      <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.muted, marginTop: 4 }}>{note}</Text>
    )}
    <View style={{ marginTop: 10 }}>{children}</View>
  </View>
);

const Field = ({ label, value, onChange, ...rest }) => (
  <>
    <Text style={[S.label, { marginTop: 12 }]}>{label}</Text>
    <TextInput style={[S.input, { marginTop: 6 }]} value={value ?? ''}
      onChangeText={onChange} {...rest} />
  </>
);

const Toggle = ({ label, note, value, disabled, onValueChange }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13,
                 borderBottomWidth: 1, borderBottomColor: C.line }}>
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 15.5, fontWeight: '700', color: C.ink }}>{label}</Text>
      {!!note && (
        <Text style={{ fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 17 }}>{note}</Text>
      )}
    </View>
    <Switch value={value} disabled={disabled} onValueChange={onValueChange}
            trackColor={{ true: C.green }} />
  </View>
);

export default function SettingsScreen({ navigation }) {
  const { org, reloadOrg } = useApp();
  const insets = useSafeAreaInsets();
  const [f, setF] = useState({ ...org });
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));

  const saveOrg = async (patch, msg) => {
    setBusy(true);
    const { error } = await supabase.from('orgs').update(patch).eq('id', org.id);
    setBusy(false);
    if (error) return Alert.alert('Could not save', error.message);
    await reloadOrg();
    if (msg) Alert.alert('Saved', msg);
  };

  const saveDetails = () => saveOrg({
    name: f.name?.trim(), address: f.address?.trim(), phone: f.phone?.trim(),
    gstin: f.gstin?.trim() || null,
    state_code: f.state_code, state_name: STATES[f.state_code] || '',
  }, 'Your firm details are updated. Old bills keep the details they were printed with.');

  const saveLedgers = () => saveOrg({
    bank_name: f.bank_name?.trim(), bank_ledger: f.bank_ledger?.trim(),
    cash_ledger: f.cash_ledger?.trim(), sales_ledger: f.sales_ledger?.trim(),
    purchase_ledger: f.purchase_ledger?.trim(), cgst_ledger: f.cgst_ledger?.trim(),
    sgst_ledger: f.sgst_ledger?.trim(), igst_ledger: f.igst_ledger?.trim(),
    round_off_ledger: f.round_off_ledger?.trim(),
  }, 'Ledger names saved.');

  // Bill numbering goes through the database, which refuses any number that
  // would repeat a bill already issued.
  // April to March, the way a bill is labelled: 26-27.
  const fyNow = () => {
    const d = new Date();
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return `${String(y).slice(2)}-${String(y + 1).slice(2)}`;
  };

  const nextLooksLike = () => {
    const pre = f.invoice_prefix || '';
    const yr  = f.restart_each_year && f.year_in_prefix !== false ? `${fyNow()}/` : '';
    return `${pre}${yr}${f.next_invoice_no || ''}`;
  };

  const saveNumbering = async () => {
    const n = parseInt(String(f.next_invoice_no), 10);
    if (!n || n < 1) return Alert.alert('Check the number', 'The next bill number must be 1 or more.');
    setBusy(true);
    const { error } = await supabase.rpc('set_invoice_start',
      { p_next: n, p_prefix: f.invoice_prefix || '' });
    if (!error) {
      // Starting again each April is kept on the firm, not in the counter.
      await supabase.from('orgs').update({
        restart_each_year: !!f.restart_each_year,
        year_in_prefix: f.year_in_prefix !== false,
      }).eq('id', org.id);
    }
    setBusy(false);
    if (error) return Alert.alert('Could not change numbering', error.message);
    await reloadOrg();
    Alert.alert('Saved', `Your next bill will be ${nextLooksLike()}.`);
  };

  return (
    <View style={S.screen}>
      <Head navigation={navigation} title="Settings" />
      <ScrollView keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 16,
                    paddingBottom: Math.max(insets.bottom, 12) + 60 }}>

      <Section title="What you use"
               note="Skwik opens as a billing book: sale, purchase, money in, money out. Switch on whatever else your shop needs and it appears straight away. Switching something off only hides it — nothing you have written is ever deleted.">
        <Toggle label="Purchase bills" disabled={busy}
                note="Bills your suppliers give you. Leave it off if only your accountant enters them."
                value={showPurchase(org)}
                onValueChange={(v) => saveOrg({ show_purchase: v })} />
        <Toggle label="Keep stock" disabled={busy}
                note="Skwik counts what goes out and what comes in, and shows what is left."
                value={showStock(org)}
                onValueChange={(v) => saveOrg({ stock_enabled: v })} />
        <Toggle label="Returns" disabled={busy}
                note="Goods coming back — credit notes to your customer, debit notes to your supplier."
                value={showReturns(org)}
                onValueChange={(v) => saveOrg({ show_returns: v })} />
        <Toggle label="Reports and GSTR-1" disabled={busy}
                note="Day, month and party totals, tax rate-wise, and the GSTR-1 file for the portal."
                value={showReports(org)}
                onValueChange={(v) => saveOrg({ show_reports: v })} />
        <Toggle label="Import and export" disabled={busy}
                note="Bringing items and parties in from Tally or Excel, and taking your books out."
                value={showTransfer(org)}
                onValueChange={(v) => saveOrg({ show_transfer: v })} />
      </Section>

      {org?.mode === 'estimate' && (
        <Section title="GST"
                 note="Switch this on and your estimates become tax invoices. Your items, customers and ledgers all stay exactly as they are.">
          <Field label="YOUR GST NUMBER" value={f.gstin} onChange={(v) => {
            const g = String(v).toUpperCase().trim();
            setF((s2) => ({ ...s2, gstin: g,
              state_code: g.length >= 2 && STATES[g.slice(0, 2)] ? g.slice(0, 2) : s2.state_code }));
          }} autoCapitalize="characters" maxLength={15} placeholder="18AABCS1234F1Z5" />
          <Text style={{ fontSize: 12, fontWeight: '600', color: C.muted, marginTop: 6 }}>
            {STATES[f.state_code] ? `State: ${STATES[f.state_code]}` : 'The state fills in from the number.'}
          </Text>
          <TouchableOpacity style={[S.btn, { marginTop: 16 }]} disabled={busy} onPress={() => {
            if (String(f.gstin || '').trim().length !== 15) {
              return RNAlert.alert('Check the GST number', 'A GSTIN is 15 characters.');
            }
            RNAlert.alert('Turn on GST?',
              'From now on your bills will be tax invoices with GST on them, numbered from 1. '
              + 'Estimates you have already given stay as they are.',
              [{ text: 'Not yet' },
               { text: 'Turn it on', onPress: () => saveOrg({
                   mode: 'gst', is_gst_registered: true, gstin: String(f.gstin).trim(),
                   state_code: f.state_code, state_name: STATES[f.state_code] || '',
                 }, 'GST is on. Add HSN codes to your items when you get a chance.') }]);
          }}>
            <Text style={S.btnText}>TURN ON GST</Text>
          </TouchableOpacity>
        </Section>
      )}

      <Section title="Your firm" note="This prints at the top of every bill.">
        <Field label="FIRM NAME" value={f.name} onChange={set('name')} />
        <Field label="ADDRESS"   value={f.address} onChange={set('address')} multiline
               style={[S.input, { marginTop: 6, height: 80 }]} />
        <Field label="PHONE"     value={f.phone} onChange={set('phone')} keyboardType="phone-pad" />
        {!!f.is_gst_registered && (
          <Field label="GST NUMBER" value={f.gstin} onChange={set('gstin')}
                 autoCapitalize="characters" maxLength={15} />
        )}
        <Field label="STATE CODE" value={String(f.state_code ?? '')} onChange={set('state_code')}
               keyboardType="number-pad" maxLength={2} />
        <Text style={{ fontSize: 12, fontWeight: '600', color: C.muted, marginTop: 4 }}>
          {STATES[f.state_code] || 'Unknown state code'}
        </Text>
        <TouchableOpacity style={[S.btn, { marginTop: 16 }]} onPress={saveDetails} disabled={busy}>
          <Text style={S.btnText}>SAVE FIRM DETAILS</Text>
        </TouchableOpacity>
      </Section>

      <Section title="Printing"
               note="A4 for the file and the accountant. A roll for the counter — the bill is drawn again for the narrow paper, not squeezed onto it.">
        {[['a4', 'A4 sheet', 'The full tax invoice'],
          ['80', '80mm roll', 'The usual counter printer'],
          ['58', '58mm roll', 'The small handheld ones']].map(([v, name, note]) => {
          const on = String(f.print_width || 'a4') === v;
          return (
            <TouchableOpacity key={v} onPress={() => setF((x) => ({ ...x, print_width: v }))}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12,
                       borderBottomWidth: 1, borderBottomColor: C.line }}>
              <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 1.5,
                             alignItems: 'center', justifyContent: 'center',
                             borderColor: on ? C.accent : C.line }}>
                {on && <View style={{ width: 11, height: 11, borderRadius: 6,
                                      backgroundColor: C.accent }} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: C.ink }}>{name}</Text>
                <Text style={{ fontSize: 12, color: C.muted, marginTop: 1 }}>{note}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={[S.btn, { marginTop: 16 }]} disabled={busy}
          onPress={async () => {
            setBusy(true);
            const { error } = await supabase.from('orgs')
              .update({ print_width: f.print_width || 'a4' }).eq('id', org.id);
            setBusy(false);
            if (error) return Alert.alert('Could not save', error.message);
            await reloadOrg();
            Alert.alert('Saved', 'Bills will print on that from now on.');
          }}>
          <Text style={S.btnText}>Save printing</Text>
        </TouchableOpacity>
      </Section>

      <Section title="Bill numbering"
               note="Carry on from the number your book has reached. A number you have already used will be refused.">
        <Field label="PREFIX (OPTIONAL)" value={f.invoice_prefix} onChange={set('invoice_prefix')}
               placeholder="SGS/26-27/" autoCapitalize="characters" />
        <Field label="NEXT BILL NUMBER" value={String(f.next_invoice_no ?? '')}
               onChange={set('next_invoice_no')} keyboardType="number-pad" />
        <TouchableOpacity
          onPress={() => setF((x) => ({ ...x, restart_each_year: !x.restart_each_year }))}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 14 }}>
          <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5,
                         alignItems: 'center', justifyContent: 'center', marginTop: 1,
                         borderColor: f.restart_each_year ? C.accent : C.line,
                         backgroundColor: f.restart_each_year ? C.accent : 'transparent' }}>
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
              {f.restart_each_year ? '✓' : ''}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14.5, fontWeight: '600', color: C.ink }}>
              Start again at 1 every April
            </Text>
            <Text style={{ fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 17 }}>
              Skwik does the switch on the 1st of April by itself. Bills already
              written keep the numbers they were given.
            </Text>
          </View>
        </TouchableOpacity>

        {!!f.restart_each_year && (
          <TouchableOpacity
            onPress={() => setF((x) => ({ ...x, year_in_prefix: x.year_in_prefix === false }))}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12,
                     paddingLeft: 32 }}>
            <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5,
                           alignItems: 'center', justifyContent: 'center',
                           borderColor: f.year_in_prefix !== false ? C.accent : C.line,
                           backgroundColor: f.year_in_prefix !== false ? C.accent : 'transparent' }}>
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
                {f.year_in_prefix !== false ? '✓' : ''}
              </Text>
            </View>
            <Text style={{ flex: 1, fontSize: 14, color: C.ink }}>
              Put the year on the bill — {fyNow()}/1
            </Text>
          </TouchableOpacity>
        )}

        <View style={{ padding: 12, backgroundColor: C.soft, borderRadius: 14, marginTop: 14 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.ink }}>
            Your next bill will be: {nextLooksLike()}
          </Text>
        </View>
        <TouchableOpacity style={[S.btn, { marginTop: 14 }]} onPress={saveNumbering} disabled={busy}>
          <Text style={S.btnText}>SAVE NUMBERING</Text>
        </TouchableOpacity>
      </Section>

      {!!org?.is_composition && (
        <Section title="HSN codes"
                 note="You charge no tax, so HSN is your choice. Switch it off and the HSN box disappears from items and from your bills.">
          <View style={[S.row, { padding: 14, backgroundColor: C.soft, borderRadius: 16 }]}>
            <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: C.ink }}>
              Show HSN codes
            </Text>
            <Switch value={org?.hsn_enabled !== false} disabled={busy}
                    onValueChange={(v) => saveOrg({ hsn_enabled: v })}
                    trackColor={{ true: C.green }} />
          </View>
        </Section>
      )}

      <Section title="Price lists"
               note="Two lists, named however you say them. Each customer sits on one of them.">
        <Field label="PRICE LIST 1" value={f.price1_name} onChange={set('price1_name')}
               placeholder="Wholesale" />
        <Field label="PRICE LIST 2" value={f.price2_name} onChange={set('price2_name')}
               placeholder="Retail" />
        <TouchableOpacity style={[S.btn, { marginTop: 16 }]} disabled={busy}
          onPress={() => saveOrg({ price1_name: (f.price1_name || 'Wholesale').trim(),
                                   price2_name: (f.price2_name || 'Retail').trim() },
                                 'Price list names saved.')}>
          <Text style={S.btnText}>SAVE PRICE LIST NAMES</Text>
        </TouchableOpacity>
      </Section>

      <Section title="Account names"
               note="Used on your reports and on the file your accountant imports. Change them to match the names in his books.">
        <Field label="BANK NAME"         value={f.bank_name} onChange={set('bank_name')}
               placeholder="State Bank of India" />
        <Field label="BANK ACCOUNT NAME" value={f.bank_ledger} onChange={set('bank_ledger')} />
        <Field label="CASH ACCOUNT NAME" value={f.cash_ledger} onChange={set('cash_ledger')} />
        <Field label="SALES ACCOUNT"     value={f.sales_ledger} onChange={set('sales_ledger')} />
        <Field label="PURCHASE ACCOUNT"  value={f.purchase_ledger} onChange={set('purchase_ledger')} />
        {!!f.is_gst_registered && !f.is_composition && (
          <>
            <Field label="CGST ACCOUNT" value={f.cgst_ledger} onChange={set('cgst_ledger')} />
            <Field label="SGST ACCOUNT" value={f.sgst_ledger} onChange={set('sgst_ledger')} />
            <Field label="IGST ACCOUNT" value={f.igst_ledger} onChange={set('igst_ledger')} />
          </>
        )}
        <Field label="ROUND OFF ACCOUNT" value={f.round_off_ledger} onChange={set('round_off_ledger')} />
        <TouchableOpacity style={[S.btn, { marginTop: 16 }]} onPress={saveLedgers} disabled={busy}>
          <Text style={S.btnText}>SAVE ACCOUNT NAMES</Text>
        </TouchableOpacity>
      </Section>
      </ScrollView>
    </View>
  );
}
