import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import {
  showBatch, showExpenses, showExpiry, showGodowns, showPurchase, showRcmIn, showRcmOut, showRecon, showReports, showReturns, showStock, showThumbRail, showTransfer, showVariants,
} from '../lib/features';
import { useApp } from '../AppContext';
import { STATES } from './OnboardScreen';
import { Alert as RNAlert } from 'react-native';
import { Box, Head, KeyForm, Screen } from '../components/Chrome';
import { CalButton } from '../components/DatePick';
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

// Every settings field is a Box, so the arrow key walks down the form and the
// tapped field is scrolled clear of the keyboard.
const Field = React.forwardRef(function Field({ label, value, onChange, next, ...rest }, ref) {
  return (
    <>
      <Text style={[S.label, { marginTop: 12 }]}>{label}</Text>
      <Box ref={ref} next={next} style={{ marginTop: 6 }} value={value ?? ''}
        onChangeText={onChange} {...rest} />
    </>
  );
});

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
  const { org, reloadOrg, isOwner, joinShop } = useApp();

  // THE WAY BACK OUT OF A SHOP MADE BY ACCIDENT.
  //
  // The man who is going to stand at the counter installs Skwik, is shown a
  // screen headed "Your shop", and taps the button on it. Now his login owns
  // an empty shop, the owner's code is refused from then on, and there is
  // nowhere in the whole app left to type it. This is that door — and it only
  // exists while the shop is genuinely empty, so nobody can walk out of a
  // shop with bills in it by tapping something in Settings.
  const [emptyShop, setEmptyShop] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  useEffect(() => {
    let on = true;
    (async () => {
      const { count } = await supabase.from('vouchers')
        .select('id', { count: 'exact', head: true });
      if (on) setEmptyShop((count || 0) === 0);
    })().catch(() => {});
    return () => { on = false; };
  }, [org?.id]);

  const joinOther = async () => {
    if (joinCode.trim().length < 4) {
      return Alert.alert('The code', 'Ask the owner for the six-character shop code.');
    }
    setJoining(true);
    try {
      const r = await joinShop(joinCode);
      Alert.alert('You are in', `You can now write bills for ${r?.name || 'the shop'}.`);
    } catch (e) {
      Alert.alert('Could not join', sayPlainly(e));
    } finally { setJoining(false); }
  };
  // the address a password reset can actually reach
  const [recoveryMail, setRecoveryMail] = useState('');
  const [savedMail, setSavedMail] = useState('');
  const insets = useSafeAreaInsets();
  const [f, setF] = useState({ ...org });
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));

  // the arrow key walks each block of the form, top to bottom
  const rName = useRef(null), rAddr = useRef(null), rPhone = useRef(null), rState = useRef(null);
  const rPre  = useRef(null), rNext = useRef(null);
  const rP1   = useRef(null), rP2   = useRef(null);
  const rL0 = useRef(null), rL1 = useRef(null), rL2 = useRef(null), rL3 = useRef(null);
  const rL4 = useRef(null), rL5 = useRef(null), rL6 = useRef(null), rL7 = useRef(null);
  const rL8 = useRef(null), rLock = useRef(null);

  const saveLock = () => {
    const d = String(f.books_locked_upto || '').trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return Alert.alert('Check the date', 'Write it as 2026-08-31 — year, month, day.');
    }
    saveOrg({ books_locked_upto: d || null },
      d ? `Nothing on or before ${d} can be changed now.` : 'Your books are open again.');
  };
  const taxLedgers = !!f.is_gst_registered && !f.is_composition;

  // A SWITCH HAS TO MOVE WHEN IT IS TOUCHED.
  //
  // Every one of these read its position off the firm row, so a tap went:
  // disable all of them → write to the server → fetch the firm row back →
  // and only then did the knob slide. On a shop counter's signal that is a
  // second and a half of a switch that appears not to have worked, so he taps
  // it again, and now he has flipped it twice. It also greyed out every OTHER
  // switch on the page while it waited.
  //
  // Now the knob moves at once and the writing happens behind it. If the
  // write fails the knob goes back and he is told — which is the only honest
  // moment to interrupt him.
  const [flag, setFlag] = useState({});
  const at = (k, fallback) => (flag[k] === undefined ? fallback : flag[k]);
  const flip = async (k, v, after) => {
    setFlag((f) => ({ ...f, [k]: v }));
    const { error } = await supabase.from('orgs').update({ [k]: v }).eq('id', org.id);
    if (error) {
      setFlag((f) => ({ ...f, [k]: !v }));
      return Alert.alert('Could not save', sayPlainly(error));
    }
    await reloadOrg();
    // the firm row now says what the knob says, so stop holding it by hand
    setFlag((f) => { const n = { ...f }; delete n[k]; return n; });
    after?.(v);
  };

  const saveOrg = async (patch, msg) => {
    setBusy(true);
    const { error } = await supabase.from('orgs').update(patch).eq('id', org.id);
    setBusy(false);
    if (error) return Alert.alert('Could not save', sayPlainly(error));
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

    // Rule 46(b) is strict about what a bill number may look like: at most 16
    // characters, and only letters, numbers, a hyphen and a slash. The portal
    // refuses anything else, and it refuses it months later, at filing time,
    // when the bills are already out of the shop.
    // Measured against the number this series will REACH, not the one it is on
    // today. A thirteen-character prefix looks fine at bill 1 and is seventeen
    // characters at bill 10,000 — and the portal only objects at filing time,
    // by which point those bills are out of the shop and cannot be renumbered.
    const example = nextLooksLike();
    const room    = example.length - String(f.next_invoice_no || '').length;
    const worst   = room + 5;                    // up to 99,999 bills in a series
    if (worst > 16) {
      return Alert.alert('Too long',
        `Your bill number starts at ${example}. By bill 99,999 it would be `
        + `${worst} characters, and GST allows 16. Shorten the prefix by `
        + `${worst - 16} character${worst - 16 > 1 ? 's' : ''}.`);
    }
    if (example.length > 16) {
      return Alert.alert('Too long',
        `Your bill number would be ${example} — ${example.length} characters. GST `
        + 'allows 16. Shorten the prefix.');
    }
    if (!/^[A-Za-z0-9/-]+$/.test(example)) {
      return Alert.alert('Not allowed in a bill number',
        `${example} has a character GST does not accept. Only letters, numbers, `
        + 'a hyphen ( - ) and a slash ( / ) are allowed.');
    }
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
    if (error) return Alert.alert('Could not change numbering', sayPlainly(error));
    await reloadOrg();
    Alert.alert('Saved', `Your next bill will be ${nextLooksLike()}.`);
  };

  useEffect(() => {
    let on = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const e = data?.user?.email || '';
      // the stand-in address made from the phone number is not a real one
      if (on && e && !e.endsWith('@gstbill.app')) { setSavedMail(e); setRecoveryMail(e); }
    })();
    return () => { on = false; };
  }, []);

  // Changing the address on the account is what makes a reset link possible.
  // Supabase sends a confirmation to the new address first; until he opens
  // that, the old one stands — which is the correct, careful order.
  const saveRecovery = async () => {
    const e = recoveryMail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return Alert.alert('Check the address', 'Type an email you can actually open.');
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ email: e });
    setBusy(false);
    if (error) return Alert.alert('Could not save it', sayPlainly(error));
    // This really does move the account onto the new address. The login
    // screen looks the number up so the mobile number keeps working, but the
    // shopkeeper should be told the truth about what just happened, and told
    // that nothing takes effect until he opens the confirmation.
    Alert.alert('Open the email to finish',
      `A confirmation has gone to ${e}. Nothing changes until you open it.\n\n`
      + 'Once you do, that address is the one on your account, and a password '
      + 'reset link can reach you.\n\nYou still log in with your mobile number '
      + 'and the same password. Keep this address — you can also log in with it '
      + 'if the number ever gives trouble.');
  };

  return (
    <Screen>
      <Head navigation={navigation} title="Settings" />
      <KeyForm
                  contentContainerStyle={{ padding: 16,
                    paddingBottom: Math.max(insets.bottom, 12) + 60 }}>

      <Section title="What you use"
               note="Skwik opens as a billing book: sale, purchase, money in, money out. Switch on whatever else your shop needs and it appears straight away. Switching something off only hides it — nothing you have written is ever deleted.">
        <Toggle label="Purchase bills"
                note="Bills your suppliers give you. Leave it off if only your accountant enters them."
                value={at('show_purchase', showPurchase(org))}
                onValueChange={(v) => flip('show_purchase', v)} />
        <Toggle label="Keep stock"
                note="Skwik counts what goes out and what comes in, and shows what is left."
                value={at('stock_enabled', showStock(org))}
                onValueChange={(v) => flip('stock_enabled', v)} />
        <Toggle label="Returns"
                note="Goods coming back — credit notes to your customer, debit notes to your supplier."
                value={at('show_returns', showReturns(org))}
                onValueChange={(v) => flip('show_returns', v)} />
        <Toggle label="Reports and GSTR-1"
                note="Day, month and party totals, tax rate-wise, and the GSTR-1 file for the portal."
                value={at('show_reports', showReports(org))}
                onValueChange={(v) => flip('show_reports', v)} />
        <Toggle label="Money out"
                note="Rent, salary, transport. Without them Skwik cannot tell you what you earned."
                value={at('show_expenses', showExpenses(org))}
                onValueChange={(v) => flip('show_expenses', v)} />
        <Toggle label="Supplier credit (GSTR-2B)"
                note="Which of your suppliers has not filed, so you know before you claim."
                value={at('show_recon', showRecon(org))}
                onValueChange={(v) => flip('show_recon', v)} />
        <Toggle label="More than one godown"
                note="A back store and a counter store, with goods moved between them."
                value={at('godowns_enabled', showGodowns(org))}
                onValueChange={(v) => flip('godowns_enabled', v,
                  (on2) => { if (on2) navigation.navigate('Godowns'); })} />
        <Toggle label="Batch numbers"
                note="For a chemist or anyone selling in lots. Asked on each line of a bill."
                value={at('batch_enabled', showBatch(org))}
                onValueChange={(v) => flip('batch_enabled', v)} />
        <Toggle label="Expiry dates"
                note="Goes beside the batch on the line, and stays with the stock."
                value={at('expiry_enabled', showExpiry(org))}
                onValueChange={(v) => flip('expiry_enabled', v)} />
        <Toggle label="Sizes of one item"
                note="9x2, 9x3, 10x2 clip tiffin as one product in three sizes, each with its own rate and stock."
                value={at('variants_enabled', showVariants(org))}
                onValueChange={(v) => flip('variants_enabled', v)} />
        <Toggle label="One-handed picking"
                note="Puts a down arrow and an OK down the right of the item list while you search, so the third match is two taps in the corner instead of a reach into the middle of the screen. The list still works exactly as it does now."
                value={at('thumb_rail', showThumbRail(org))}
                onValueChange={(v) => flip('thumb_rail', v)} />
        <Toggle label="Import and export"
                note="Bringing items and parties in from Tally or Excel, and taking your books out."
                value={at('show_transfer', showTransfer(org))}
                onValueChange={(v) => flip('show_transfer', v)} />
        {!!org?.is_gst_registered && (
          <Toggle label="GST I owe on freight and the like"
                  note="When a transporter charges you no GST, the GST is yours to pay. Skwik works it out on a purchase bill or on a Money out entry, puts it in GST owed, and gives your accountant the figure for GSTR-3B."
                  value={at('rcm_purchase_enabled', showRcmIn(org))}
                  onValueChange={(v) => flip('rcm_purchase_enabled', v)} />
        )}
        {!!org?.is_gst_registered && !org?.is_composition && (
          <Toggle label="Sales where the buyer pays the GST"
                  note="Rare. Only for the few supplies the law names, and almost never for goods sold over a counter. Left off, the tick stays off your bill screen so it cannot be ticked by mistake."
                  value={at('rcm_sales_enabled', showRcmOut(org))}
                  onValueChange={(v) => flip('rcm_sales_enabled', v)} />
        )}
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

      <Section title="Closing a month"
               note="Once a return has gone to the portal the bills behind it must not change. Put the last filed date here and Skwik refuses to write, alter or remove anything on or before it — a mistake in a closed month is put right with a credit note, which is what the return expects.">
        <View style={[S.row, { gap: 8, alignItems: 'flex-end' }]}>
          <View style={{ flex: 1 }}>
            <Field ref={rLock} onSubmit={saveLock} label="FILED UP TO (YYYY-MM-DD)"
                   value={f.books_locked_upto || ''} onChange={set('books_locked_upto')}
                   placeholder="2026-08-31" />
          </View>
          <CalButton value={f.books_locked_upto || ''} size={48}
            onPick={(iso) => set('books_locked_upto')(iso)}
            title="Filed up to which day?"
            note="Everything on or before this day is closed." />
        </View>
        <Text style={{ fontSize: 12, fontWeight: '600', color: C.muted, marginTop: 6 }}>
          {org?.books_locked_upto
            ? `Your books are closed up to ${org.books_locked_upto}.`
            : 'Nothing is closed. Every bill can still be changed.'}
        </Text>
        <TouchableOpacity style={[S.btn, { marginTop: 14 }]} onPress={saveLock} disabled={busy}>
          <Text style={S.btnText}>SAVE THE CLOSING DATE</Text>
        </TouchableOpacity>
        {!!org?.books_locked_upto && (
          <TouchableOpacity onPress={() => saveOrg({ books_locked_upto: null }, 'Your books are open again.')}
            style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
            <Text style={{ fontSize: 14.5, fontWeight: '700', color: C.danger }}>
              Open them again
            </Text>
          </TouchableOpacity>
        )}
      </Section>

      <Section title="Seeing it work"
               note="Write a month of real bills from your own items, your own customers and the money you have already received, so you can see what the reports, the ledgers and the stock do before you bill a single real day. A whole run can be taken back out again if you do not like it.">
        <TouchableOpacity style={S.btn} onPress={() => navigation.navigate('Sample')}>
          <Text style={S.btnText}>FILL A MONTH</Text>
        </TouchableOpacity>
      </Section>

      <Section title="Who can bill"
               note="Give the man at your counter his own login. He can write bills and take money; he cannot remove a bill, change these settings, see what you paid for your goods, or read the reports.">
        <TouchableOpacity style={S.btn} onPress={() => navigation.navigate('Staff')}>
          <Text style={S.btnText}>SHOP CODE AND PEOPLE</Text>
        </TouchableOpacity>

        {emptyShop && (
          <View style={{ marginTop: 16, padding: 14, backgroundColor: C.surface,
                         borderWidth: 1, borderColor: C.line, borderRadius: 12 }}>
            <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.ink }}>
              Actually, I work at someone else's shop
            </Text>
            <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 5, lineHeight: 18 }}>
              If you made this shop by mistake and the owner has given you a
              code, type it here. This shop has nothing in it, so nothing is
              lost. Once you have written a bill this goes away.
            </Text>
            <View style={[S.row, { gap: 8, marginTop: 10 }]}>
              <TextInput style={[S.input, { flex: 1, letterSpacing: 3, marginBottom: 0 }, S.num]}
                autoCapitalize="characters" maxLength={6} placeholder="ABC123"
                placeholderTextColor={C.faint} value={joinCode}
                onChangeText={(t) => setJoinCode(t.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
              <TouchableOpacity style={[S.btnGhost, { paddingHorizontal: 18, paddingVertical: 12 }]}
                onPress={joinOther} disabled={joining}>
                <Text style={S.ghostText}>{joining ? '…' : 'JOIN'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </Section>

      <Section title="Your firm" note="This prints at the top of every bill.">
        <Field ref={rName} next={rAddr} label="FIRM NAME" value={f.name} onChange={set('name')} />
        <Field ref={rAddr} next={rPhone} label="ADDRESS" value={f.address} onChange={set('address')} multiline
               style={[S.input, { marginTop: 6, height: 80 }]} />
        <Field ref={rPhone} next={rState} label="PHONE" value={f.phone} onChange={set('phone')}
               keyboardType="phone-pad" />
        {!!f.is_gst_registered && (
          <Field label="GST NUMBER" value={f.gstin} onChange={set('gstin')}
                 autoCapitalize="characters" maxLength={15} />
        )}
        <Field ref={rState} onSubmit={saveDetails} label="STATE CODE"
               value={String(f.state_code ?? '')} onChange={set('state_code')}
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
            if (error) return Alert.alert('Could not save', sayPlainly(error));
            await reloadOrg();
            Alert.alert('Saved', 'Bills will print on that from now on.');
          }}>
          <Text style={S.btnText}>Save printing</Text>
        </TouchableOpacity>
      </Section>

      <Section title="Bill numbering"
               note="Carry on from the number your book has reached. A number you have already used will be refused.">
        <Field ref={rPre} next={rNext} label="PREFIX (OPTIONAL)" value={f.invoice_prefix} onChange={set('invoice_prefix')}
               placeholder="SGS/26-27/" autoCapitalize="characters" />
        <Field ref={rNext} onSubmit={saveNumbering} label="NEXT BILL NUMBER" value={String(f.next_invoice_no ?? '')}
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
            <Switch value={at('hsn_enabled', org?.hsn_enabled !== false)}
                    onValueChange={(v) => flip('hsn_enabled', v)}
                    trackColor={{ true: C.green }} />
          </View>
        </Section>
      )}

      <Section title="Price lists"
               note="Two lists, named however you say them. Each customer sits on one of them.">
        <Field ref={rP1} next={rP2} label="PRICE LIST 1" value={f.price1_name} onChange={set('price1_name')}
               placeholder="Wholesale" />
        <Field ref={rP2} label="PRICE LIST 2" value={f.price2_name} onChange={set('price2_name')}
               placeholder="Retail" />
        {/* THE QUESTION THE BILL SCREEN USED TO ASK FORTY TIMES A DAY.
            Every customer carries his own list. The stranger paying cash does
            not, and he is most of the counter — so it is answered once, here,
            and the bill screen stops asking. */}
        <Text style={[S.label, { marginTop: 18 }]}>A WALK-IN PAYS</Text>
        <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 18 }}>
          Cash at the counter, no name taken. A customer you have written down
          is billed on his own list whatever this says.
        </Text>
        <View style={[S.row, { gap: 8, marginTop: 8 }]}>
          {[1, 2].map((n) => {
            const on = Number(at('walkin_price_list', org?.walkin_price_list || 1)) === n;
            const nm = n === 1 ? (f.price1_name || 'Wholesale') : (f.price2_name || 'Retail');
            return (
              <TouchableOpacity key={n} onPress={() => flip('walkin_price_list', n)}
                style={{ flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center',
                         borderWidth: 1.5, borderColor: on ? C.accent : C.line,
                         backgroundColor: on ? C.accentSoft : C.surface }}>
                <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '700',
                                                 color: on ? C.accent : C.muted }}>{nm}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity style={[S.btn, { marginTop: 16 }]} disabled={busy}
          onPress={() => saveOrg({ price1_name: (f.price1_name || 'Wholesale').trim(),
                                   price2_name: (f.price2_name || 'Retail').trim() },
                                 'Price list names saved.')}>
          <Text style={S.btnText}>SAVE PRICE LIST NAMES</Text>
        </TouchableOpacity>
      </Section>

      <Section title="Account names"
               note="Used on your reports and on the file your accountant imports. Change them to match the names in his books.">
        <Field ref={rL0} next={rL1} label="BANK NAME"         value={f.bank_name} onChange={set('bank_name')}
               placeholder="State Bank of India" />
        <Field ref={rL1} next={rL2} label="BANK ACCOUNT NAME" value={f.bank_ledger} onChange={set('bank_ledger')} />
        <Field ref={rL2} next={rL3} label="CASH ACCOUNT NAME" value={f.cash_ledger} onChange={set('cash_ledger')} />
        <Field ref={rL3} next={rL4} label="SALES ACCOUNT"     value={f.sales_ledger} onChange={set('sales_ledger')} />
        <Field ref={rL4} next={taxLedgers ? rL5 : rL8} label="PURCHASE ACCOUNT"  value={f.purchase_ledger} onChange={set('purchase_ledger')} />
        {!!f.is_gst_registered && !f.is_composition && (
          <>
            <Field ref={rL5} next={rL6} label="CGST ACCOUNT" value={f.cgst_ledger} onChange={set('cgst_ledger')} />
            <Field ref={rL6} next={rL7} label="SGST ACCOUNT" value={f.sgst_ledger} onChange={set('sgst_ledger')} />
            <Field ref={rL7} next={rL8} label="IGST ACCOUNT" value={f.igst_ledger} onChange={set('igst_ledger')} />
          </>
        )}
        <Field ref={rL8} onSubmit={saveLedgers} label="ROUND OFF ACCOUNT" value={f.round_off_ledger} onChange={set('round_off_ledger')} />
        <TouchableOpacity style={[S.btn, { marginTop: 16 }]} onPress={saveLedgers} disabled={busy}>
          <Text style={S.btnText}>SAVE ACCOUNT NAMES</Text>
        </TouchableOpacity>
      </Section>

      <Section title="Cash &amp; bank accounts"
               note="Name every account the shop actually has, and what was in each one to begin with. Without the opening figures the cash book and the bank book start at nil and every balance after them is short by the same amount.">
        <TouchableOpacity style={S.btn} onPress={() => navigation.navigate('Banks')}>
          <Text style={S.btnText}>SET UP ACCOUNTS</Text>
        </TouchableOpacity>
      </Section>

      {/* GETTING BACK IN.
          Skwik signs a shopkeeper in on his mobile number, which stands in for
          an email address behind the scenes. It is not a real address, so if
          he forgets his password there is nowhere to send a reset link. The
          only honest fix is to ask for an address he can actually read, once,
          BEFORE the day he needs it — which is what this is. */}
      <Section title="Getting back in"
               note="If you forget your password there is nowhere to send a reset link, because you log in with your mobile number and not an email. Save a real email address here and the link can reach you. Do it now — it cannot be done after you are locked out.">
        <Text style={[S.label, { marginTop: 12 }]}>YOUR EMAIL</Text>
        <TextInput style={[S.input, { marginTop: 6 }]} autoCapitalize="none"
          keyboardType="email-address" placeholder="you@example.com"
          placeholderTextColor={C.faint}
          value={recoveryMail} onChangeText={setRecoveryMail} />
        {!!savedMail && (
          <Text style={{ fontSize: 12, color: C.ok, marginTop: 6, fontWeight: '600' }}>
            Saved: {savedMail}
          </Text>
        )}
        <TouchableOpacity style={[S.btn, { marginTop: 14 }]} onPress={saveRecovery}
          disabled={busy}>
          <Text style={S.btnText}>SAVE THIS EMAIL</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 8, lineHeight: 17 }}>
          A confirmation goes to that address. Open it, and from then on
          &ldquo;Forgotten your password?&rdquo; on the login screen works.
        </Text>
      </Section>

      <Section title="Keyboard measurements"
               note="Only turn this on if I ask you to. It draws the phone's own keyboard figures across the top of the billing screen so a fault can be read off a photograph instead of guessed at. Turn it off afterwards.">
        <View style={[S.row, { justifyContent: 'space-between', marginTop: 6 }]}>
          <Text style={{ flex: 1, fontSize: 14.5, fontWeight: '600', color: C.ink }}>
            Show the figures
          </Text>
          <Switch value={!!f.debug_keyboard}
            onValueChange={(v) => {
              set('debug_keyboard')(v);
              saveOrg({ debug_keyboard: v }, null);
            }}
            trackColor={{ true: C.accent }} />
        </View>
      </Section>

      {/* The one thing in the app that cannot be undone lives at the very
          bottom, by itself, behind its own screen and its own password. */}
      {isOwner && (
        <Section title="Start the books again"
                 note="Empties this firm of every bill, receipt, payment and stock movement so you can begin your real books from nothing. It cannot be undone, and it asks for your password first.">
          <TouchableOpacity
            style={[S.btnGhost, { borderColor: C.danger, paddingVertical: 14 }]}
            onPress={() => navigation.navigate('Wipe')}>
            <Text style={[S.ghostText, { color: C.danger, fontSize: 15 }]}>
              EMPTY THIS FIRM
            </Text>
          </TouchableOpacity>
        </Section>
      )}

      <View style={{ height: 30 }} />
      </KeyForm>
    </Screen>
  );
}
