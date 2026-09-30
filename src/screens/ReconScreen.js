import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Linking,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, n2, num, today } from '../lib/money';
import { readPickedFile } from '../lib/pickfile';
import {
  parse2b, reconcile, chaseList, worklist, claimBy, READER, WHY_STUCK,
} from '../lib/gstr2b';
import { useFocusEffect } from '@react-navigation/native';
import { sayPlainly } from '../lib/offline';
import { Bar, BackButton, Screen, Sections, Swipe, useSectionSwipe } from '../components/Chrome';
import { C, S } from '../theme';

// ===========================================================================
//  WHICH OF MY SUPPLIERS HAS NOT FILED.
//
//  The tax on a purchase bill is only his to claim once the supplier has
//  declared it. Nothing at a shopkeeper's price tells him which ones have
//  not, so he finds out months later when his accountant reverses the credit.
//
//  TWO THINGS THIS SCREEN USED TO GET WRONG, BOTH OF THEM MINE.
//
//  It asked him how far back to compare -- three months, six, a year -- and
//  then which months to compare against. Neither is a question he can answer,
//  because neither has an answer. A bill does not belong to a month: it sits
//  at one date on the portal and another in his books, and a single April
//  bill can be an April bill to his supplier and a May bill to him. Setting
//  the window to April and comparing April's 2B against April's entries, his
//  own shop came out at 28 bills unfiled and 28 bills unentered -- the same
//  bills, on opposite sides, separated by nothing but the calendar.
//
//  His own tool, written before Skwik, has no chooser at all. You give it
//  every file you have and it compares everything against everything, and on
//  the same five months it answered 4 bills and 9,578 where this screen said
//  28 bills and 27,588. So the chooser is gone. Skwik holds the files; it
//  knows the oldest one; it can work the window out by itself.
//
//  AND IT NO LONGER ANSWERS IN NOUNS.
//
//  "At risk". "Not in your books". "Needs a look". Those are states, and a
//  shopkeeper has to turn each one into an action before he can move. The
//  four headings below are the actions. The translating is done for him.
// ===========================================================================

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

const monthName = (m) => `${MONTHS[Number(String(m).slice(5, 7)) - 1]} ${String(m).slice(0, 4)}`;

// why a pair is not a clean match, in words a shopkeeper can act on
const WHY = {
  DIFF_AMT:   'The tax or the value does not agree',
  DIFF_NO:    'Same supplier, tax and date — his number is different',
  DIFF_GSTIN: 'Same firm, a different GST registration',
  FUZZY:      'The number is nearly the same — check it is the right bill',
  DIFF_PARTY: 'Bill and tax agree but the GST number does not. Check the ledger',
  WEAK:       'Paired on the amount alone. Confirm before you claim',
};

// HOW FAR BACK THE BOOKS ARE READ, at the very most. His whole purchase
// history would be read if it were short enough; two years before the oldest
// file he holds is the limit, because past that nothing on either side can
// still find a partner and the reading is only slow.
const MAX_BACK_MONTHS = 24;

const firstOf = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
const backFrom = (period, months) => {
  const y = Number(String(period).slice(0, 4));
  const m = Number(String(period).slice(5, 7)) - months;
  return firstOf(y + Math.floor((m - 1) / 12), ((((m - 1) % 12) + 12) % 12) + 1);
};

export default function ReconScreen({ navigation }) {
  const { org, isOwner } = useApp();
  const swipe = useSectionSwipe(navigation, org, isOwner, 'recon');
  const [busy, setBusy]   = useState('');
  const [kept, setKept]   = useState([]);
  const [res, setRes]     = useState(null);
  const [askAgain, setAskAgain] = useState([]);   // months only he can refresh
  const [open, setOpen]   = useState('ring');     // which section is unfolded

  const monthOf = (p) => {                        // the portal writes MMYYYY
    const t = String(p || '').trim();
    return /^\d{6}$/.test(t) ? `${t.slice(2)}-${t.slice(0, 2)}` : t.slice(0, 7);
  };

  /* ---------------- where his books begin ---------------- */

  // The portal's file reaches back further than his books do. Every row older
  // than his first purchase has nothing on this side to meet and is not a
  // bill he forgot -- it is a year he has not loaded. On his own data that is
  // 84 rows and 6,35,721, which turns a worklist into a wall.
  const earliestBook = async () => {
    const one = async (col) => {
      const { data } = await supabase.from('vouchers').select(col)
        .in('vtype', ['purchase', 'purchase_return']).is('cancelled_at', null)
        .not(col, 'is', null).order(col, { ascending: true }).limit(1);
      return data && data[0] ? String(data[0][col]).slice(0, 10) : '';
    };
    const [a, b] = await Promise.all([one('vdate'), one('supplier_invoice_date')]);
    return [a, b].filter(Boolean).sort()[0] || '';
  };

  /* ---------------- the comparison, and there is only one ---------------- */

  const run = async (portal, months) => {
    const oldest = months.slice().sort()[0] || today().slice(0, 7);
    const booksFrom = await earliestBook();
    const limit = backFrom(oldest, MAX_BACK_MONTHS);
    const from  = booksFrom && booksFrom > limit ? booksFrom : limit;

    // Paged: a busy shop passes a thousand purchase bills easily, and the
    // ones past the first page were silently absent from the comparison --
    // which reads exactly like the supplier not having filed them.
    const data = await allRows(() => supabase.from('vouchers')
      .select('id, vtype, vdate, voucher_no, supplier_invoice_no, supplier_invoice_date,'
            + ' taxable, cgst, sgst, igst, total, printed_name, reverse_charge,'
            + ' parties(name, gstin)')
      .in('vtype', ['purchase', 'purchase_return'])
      // A CANCELLED PURCHASE IS NOT A PURCHASE. These came through with the
      // rest, found nothing to match, and were reported as unfiled credit.
      .is('cancelled_at', null)
      .gte('vdate', from).lte('vdate', today())
      .order('vdate').order('id'));

    setRes(reconcile({ purchases: data || [], portal, periods: months,
                       booksFrom: from, asOf: today() }));
  };

  /* ---------------- everything he has, compared against everything ------- */

  const compareAll = async (list) => {
    const shelf = list || kept;
    if (!shelf.length) return;
    setBusy('reading');
    const stale = [];
    try {
      const { data, error } = await supabase.from('itc_files')
        .select('period, rows, reader').order('period');
      if (error) throw error;

      // A MONTH READ BY AN OLDER READER READS ITSELF AGAIN.
      //
      // 1.10.19 kept the reader's output and not the file. 1.10.25 improved
      // the reader -- it had been looking for a 2A's field names in a 2B, so
      // every tax came back nought -- and the stored months went on serving
      // the old zeros to the new build. He was told to go and open all five
      // files by hand, which is the chore the shelf exists to spare him.
      const portal = [];
      const months = [];
      for (const f of data || []) {
        months.push(f.period);
        if ((f.reader || 0) >= READER) { portal.push(...(f.rows || [])); continue; }
        const { data: raw } = await supabase.rpc('raw_2b', { p_period: f.period });
        if (!raw) { stale.push(f.period); portal.push(...(f.rows || [])); continue; }
        const again = parse2b(raw);
        if (again.problem) { stale.push(f.period); portal.push(...(f.rows || [])); continue; }
        portal.push(...again.rows);
        await supabase.rpc('keep_2b', { p_period: f.period, p_rows: again.rows,
                                        p_name: null, p_raw: null, p_reader: READER });
      }
      setAskAgain(stale);
      await run(portal, months);
    } catch (e) {
      Alert.alert('Could not compare', sayPlainly(e));
    } finally { setBusy(''); }
  };

  const loadKept = async (andCompare) => {
    const { data, error } = await supabase.rpc('my_2b_months');
    if (error) return;                             // an older database: no shelf
    const list = data || [];
    setKept(list);
    if (andCompare && list.length) await compareAll(list);
  };
  // COMING BACK FROM ENTERING ONE OF THEM SHOULD SHOW IT GONE.
  //
  // He works down "enter these in your books" bill by bill, and every one he
  // enters should leave the list. But re-reading his whole purchase history
  // every time he glances at this screen is a long wait for nothing, so it is
  // read again only when he has actually been away to change something.
  const dirty = useRef(false);
  useFocusEffect(useCallback(() => {
    if (!res || dirty.current) { dirty.current = false; loadKept(true); }
  }, [res]));

  /* ---------------- bringing a month in ---------------- */

  const pick = async () => {
    setBusy('reading');
    try {
      const r = await DocumentPicker.getDocumentAsync(
        { copyToCacheDirectory: false, type: '*/*', multiple: true });
      if (r.canceled) return;
      const picked = (r.assets || []).filter((a) => a?.uri);
      if (!picked.length) return Alert.alert('Could not open that', 'No file came back.');

      // one at a time, so a bad file among good ones says which one it was
      for (const a of picked) {
        const text = await readPickedFile(a.uri);
        const one = parse2b(text);
        if (one.problem) {
          return Alert.alert(picked.length > 1 ? `Could not read ${a.name || 'one of those files'}`
                                               : 'Could not read that file', one.problem);
        }
        if (!one.period) {
          return Alert.alert('Which month is that?',
            'That file does not say which return period it is for.');
        }
        // AND THE FILE ITSELF IS KEPT, not only what the reader made of it.
        // A GSTR-2B is final once the portal has made it, so the file is true
        // for ever and a better reader can be run over it again without ever
        // asking him for it a second time.
        const { error: ke } = await supabase.rpc('keep_2b', {
          p_period: monthOf(one.period), p_rows: one.rows,
          p_name: a.name || null, p_raw: text, p_reader: READER });
        if (ke && !/does not exist/i.test(ke.message || '')) {
          Alert.alert('Read, but not kept', `${sayPlainly(ke)}`);
          break;
        }
      }
      setRes(null);
      await loadKept(true);
    } catch (e) {
      Alert.alert('Could not read that file', sayPlainly(e));
    } finally { setBusy(''); }
  };

  /* ---------------- the two things he does with the answer --------------- */

  const chase = (g) => {
    const lines = g.bills.map((b) =>
      `${b.docNo || '(no number)'} dt ${b.docDate} — ₹${fmt0(b.value)}`);
    const msg = `Namaste${g.name ? ' ' + g.name : ''},\n\n`
      + 'These bills are not showing in our GSTR-2B, so we cannot take the input credit:\n\n'
      + lines.join('\n')
      + `\n\nPlease check and file them.\n\n${org?.name || ''}`;
    Linking.openURL(`whatsapp://send?text=${encodeURIComponent(msg)}`)
      .catch(() => Linking.openURL(`https://wa.me/?text=${encodeURIComponent(msg)}`))
      .catch(() => Alert.alert('No WhatsApp', 'WhatsApp is not installed on this phone.'));
  };

  const takeAway = async () => {
    if (!res) return;
    const q = (x) => {
      const t = String(x == null ? '' : x);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = worklist(res).map((row) => row.map(q).join(',')).join('\n');
    try {
      const f = new File(Paths.cache, 'skwik-supplier-credit.csv');
      try { if (f.exists) f.delete(); } catch (e) { /* first time */ }
      f.create(); f.write(csv);
      if (!(await Sharing.isAvailableAsync())) {
        return Alert.alert('Nothing to share with',
          'This phone has no app set up to receive files.');
      }
      await Sharing.shareAsync(f.uri, { mimeType: 'text/csv', dialogTitle: 'Supplier credit' });
    } catch (e) {
      Alert.alert('Could not send', sayPlainly(e));
    }
  };

  /* ---------------- what the four sections hold ---------------- */

  const s = res?.summary;
  const ring = useMemo(() => (res ? chaseList(res) : []), [res]);

  // WHY THEY ARE STUCK, IN ONE SENTENCE, BEFORE HE OPENS ANYTHING.
  //
  // Three of these are a reminder and one is his own ledger to fix, and the
  // difference decides whether he picks up the telephone at all. His own
  // report says so in the line under the heading; this said only "it is not
  // in the government record", which is true of all three.
  const why = useMemo(() => {
    if (!res) return '';
    const bag = { GSTIN: [0, 0], MONTH: [0, 0], OMITTED: [0, 0] };
    (res.booksOnly || []).forEach((b) => {
      const k = bag[b.why] ? b.why : 'OMITTED';
      bag[k][0] += 1;
      bag[k][1] += (b.sign || 1) * (Number(b.tax) || 0);
    });
    const bit = (k, said) => (bag[k][0]
      ? `${bag[k][0]} ${said} — ₹${fmt0(Math.abs(bag[k][1]))}` : null);
    const parts = [
      bit('MONTH', 'where he has not filed that month at all, a reminder rather than a complaint'),
      bit('OMITTED', 'he filed that month and left out'),
      bit('GSTIN', 'from firms that appear in no return at all, which usually means a wrong '
                 + 'GSTIN in your ledger'),
    ].filter(Boolean);
    return 'You have the bill and you paid the tax, but it is not in the government record.'
      + (parts.length ? ` Of these, ${parts.join('; ')}.` : '');
  }, [res]);
  const enter = useMemo(
    () => (res ? [...res.twoOnly].sort((a, b) => b.tax - a.tax) : []), [res]);

  // LAST YEAR'S BILLS ARE NOT THIS YEAR'S WORK.
  //
  // A bill from a finished year is a different job: its deadline is months
  // away rather than a year, and nothing he does this evening about this
  // month's return touches it. Mixed into the list it is noise; named on its
  // own it is a deadline. Split on the financial year of the newest file he
  // has given, because that is the year he is working in.
  const thisYear = useMemo(() => {
    const newest = (kept[0] && kept[0].period) || today().slice(0, 7);
    const y = Number(newest.slice(0, 4)), m = Number(newest.slice(5, 7));
    return m >= 4 ? y : y - 1;
  }, [kept]);
  const fyOf = (d) => {
    const y = Number(String(d).slice(0, 4)), m = Number(String(d).slice(5, 7));
    return m >= 4 ? y : y - 1;
  };
  const split = useMemo(() => {
    const now = [], before = [];
    ring.forEach((g) => {
      const a = g.bills.filter((b) => fyOf(b.docDate) >= thisYear);
      const b = g.bills.filter((x) => fyOf(x.docDate) < thisYear);
      const cut = (bills) => n2(bills.reduce((s, x) => s + (x.sign || 1) * num(x.tax), 0));
      if (a.length) now.push({ ...g, bills: a, tax: cut(a) });
      if (b.length) before.push({ ...g, bills: b, tax: cut(b) });
    });
    const sum = (gs) => n2(gs.reduce((s, g) => s + g.tax, 0));
    const count = (gs) => gs.reduce((s, g) => s + g.bills.length, 0);
    return { now, before, nowTax: sum(now), beforeTax: sum(before),
             nowBills: count(now), beforeBills: count(before) };
  }, [ring, thisYear]);
  const earlier = useMemo(() => {
    const seen = [];
    (res?.booksUnseen || []).forEach((b) => {
      const m = String(b.docDate || '').slice(0, 7);
      if (m && seen.indexOf(m) < 0) seen.push(m);
    });
    return seen.sort().map(monthName);
  }, [res]);
  const span = kept.length
    ? [monthName(kept[kept.length - 1].period), monthName(kept[0].period)]
        .filter((x, i, a) => a.indexOf(x) === i).join(' to ')
    : '';

  /* ---------------- the small pieces the page is drawn from --------------- */

  // THE COUNT WITHOUT THE MONEY IS HALF A HEADING.
  //
  // "2 bills" does not tell him whether to open it. "2 bills · ₹5,040" tells him
  // whether it is worth his evening. His own report carries the money in
  // every heading and that is most of why it reads faster than this did.
  const Job = ({ id, title, count, money, tone, note, children }) => {
    const on = open === id;
    return (
      <View style={[S.card, { marginBottom: 10, paddingVertical: 0 }]}>
        <TouchableOpacity onPress={() => setOpen(on ? '' : id)}
          style={{ paddingVertical: 14 }}>
          <View style={S.row}>
            <Text style={{ flex: 1, fontSize: 16, fontWeight: '800', color: C.ink }}>
              {title}
            </Text>
            <Text style={{ fontSize: 13, fontWeight: '700', color: C.muted }}>
              {count} {count === 1 ? 'bill' : 'bills'}
              {money ? '  ·  ' : ''}
              {money ? (
                <Text style={[{ fontWeight: '800',
                                color: tone === 'bad' ? C.danger
                                     : tone === 'ok' ? '#0B5C34' : C.ink }, S.num]}>
                  {'₹' + fmt0(money)}
                </Text>
              ) : null}
              {'  '}{on ? '⌃' : '⌄'}
            </Text>
          </View>
          {!!note && (
            <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 18 }}>
              {note}
            </Text>
          )}
        </TouchableOpacity>
        {on && <View style={{ paddingBottom: 14 }}>{children}</View>}
      </View>
    );
  };

  const Line = ({ k, v, sub, tone, onPress, go }) => (
    <TouchableOpacity disabled={!onPress} onPress={onPress}
      style={[S.row, { paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.line }]}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={{ fontSize: 13.5, fontWeight: '600', color: C.ink }}>{k}</Text>
        {!!sub && (
          <Text style={{ fontSize: 11.5, color: onPress ? C.accent : C.muted, marginTop: 2 }}>
            {sub}{go ? ' ›' : ''}
          </Text>
        )}
      </View>
      <Text style={[{ fontSize: 14, fontWeight: '700',
                      color: tone === 'bad' ? C.danger : C.ink }, S.num]}>{v}</Text>
    </TouchableOpacity>
  );

  return (
    <Screen>
      <Bar>
        <BackButton navigation={navigation} />
        <View style={{ flex: 1 }}>
          <Text style={S.barName}>Supplier credit</Text>
          <Text style={S.barSub}>
            {span ? `GSTR-2B ${span}` : 'GSTR-2B against your books'}
          </Text>
        </View>
      </Bar>
      <Sections navigation={navigation} org={org} isOwner={isOwner} id="recon" />

      <Swipe {...swipe} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>

        {!res && !busy && (
          <View style={S.card}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: C.ink }}>
              Which of your suppliers has not filed?
            </Text>
            <Text style={{ fontSize: 13, color: C.muted, marginTop: 8, lineHeight: 19 }}>
              The GST you pay a supplier is only yours to claim once he has declared
              that bill on the portal. Skwik reads the GSTR-2B file and puts it beside
              your purchases, so you know before you file, not after.
            </Text>
            <Text style={{ fontSize: 13, fontWeight: '700', color: C.ink, marginTop: 14 }}>
              On the GST portal
            </Text>
            <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 19 }}>
              Returns → Returns Dashboard → pick the month → GSTR-2B → Download →
              Generate JSON file to download. Save it on this phone, then tap below.
            </Text>
            <Text style={{ fontSize: 12.5, color: C.ink, marginTop: 14, lineHeight: 18 }}>
              Bring in as many months as you have. Skwik keeps every file and compares
              all of them against all of your bills, every time — a supplier who files
              late and a bill you entered late both come right on their own.
            </Text>
            <TouchableOpacity style={[S.btn, { marginTop: 14 }]} onPress={pick} disabled={!!busy}>
              <Text style={S.btnText}>{busy ? 'Reading…' : 'Open the 2B file(s)'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {!!s && (
          <>
            {/* ONE THING TO LOSE AND ONE THING TO GAIN, before any table. */}
            <View style={[S.card, { marginBottom: 10 }]}>
              <Text style={{ fontSize: 15.5, color: C.ink, lineHeight: 23 }}>
                <Text style={[{ fontWeight: '800', color: C.danger }, S.num]}>
                  ₹{fmt0(s.stuck)}
                </Text>
                {' of your credit is stuck with '}
                {s.stuckSuppliers} {s.stuckSuppliers === 1 ? 'supplier' : 'suppliers'}.
              </Text>
              <Text style={{ fontSize: 15.5, color: C.ink, lineHeight: 23, marginTop: 6 }}>
                <Text style={[{ fontWeight: '800', color: '#0B5C34' }, S.num]}>
                  ₹{fmt0(s.waiting)}
                </Text>
                {' is waiting for you, on bills you have not entered.'}
              </Text>
              {!!span && (
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 10, lineHeight: 17 }}>
                  Compared against every file Skwik holds — {span}, {kept.length}{' '}
                  {kept.length === 1 ? 'month' : 'months'}.
                </Text>
              )}
            </View>

            {askAgain.length > 0 && (
              <View style={{ marginBottom: 10, padding: 12, borderRadius: 12,
                             backgroundColor: C.flagSoft, borderWidth: 1, borderColor: C.flagLine }}>
                <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.flagInk }}>
                  {askAgain.map(monthName).join(', ')} {askAgain.length === 1 ? 'was' : 'were'}
                  {' '}read by an older version of Skwik
                </Text>
                <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 4, lineHeight: 17 }}>
                  Those months were kept before Skwik started keeping the file itself, so
                  they cannot be read again on their own. Open {askAgain.length === 1
                    ? 'that file' : 'those files'} once more and the figures above will be
                  right. It will not be asked again.
                </Text>
              </View>
            )}

            <Job id="ring" title="Ring these suppliers" count={split.nowBills}
                 money={split.nowTax} tone="bad" note={why}>
              {split.now.map((g) => (
                <View key={g.key} style={{ marginTop: 12 }}>
                  <View style={S.row}>
                    <Text style={{ flex: 1, fontSize: 14.5, fontWeight: '800', color: C.ink }}>
                      {g.name}
                    </Text>
                    <Text style={[{ fontSize: 15, fontWeight: '800', color: C.danger }, S.num]}>
                      ₹{fmt0(g.tax)}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2, lineHeight: 16 }}>
                    {WHY_STUCK[g.why]}
                  </Text>
                  {g.bills.map((b, i) => (
                    <Line key={i} tone="bad"
                          k={`${b.docNo || '(no number)'} · ${b.docDate}`}
                          sub={b.daysLeft == null ? ''
                               : `${b.daysLeft} days left — claim by ${claimBy(b.docDate)}`}
                          v={`₹${fmt0(b.tax)}`} />
                  ))}
                  {g.why !== 'GSTIN' && (
                    <TouchableOpacity style={[S.btn, { marginTop: 10, backgroundColor: C.wa }]}
                      onPress={() => chase(g)}>
                      <Text style={S.btnText}>Ask him on WhatsApp</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </Job>

            {split.beforeBills > 0 && (
              <Job id="lastyear" title="From an earlier year" count={split.beforeBills}
                   money={Math.abs(split.beforeTax)}
                   note={'These are stuck too, but they belong to a year that has finished. '
                       + 'Nothing you file this month touches them — what matters is the '
                       + 'date each one has to be claimed by.'}>
                {split.before.map((g) => (
                  <View key={g.key} style={{ marginTop: 12 }}>
                    <View style={S.row}>
                      <Text style={{ flex: 1, fontSize: 14.5, fontWeight: '800', color: C.ink }}>
                        {g.name}
                      </Text>
                      <Text style={[{ fontSize: 15, fontWeight: '800', color: C.danger }, S.num]}>
                        {'₹' + fmt0(Math.abs(g.tax))}
                      </Text>
                    </View>
                    {g.bills.map((b, i) => (
                      <Line key={i} tone="bad"
                            k={`${b.docNo || '(no number)'} · ${b.docDate}`}
                            sub={b.daysLeft == null ? ''
                                 : b.daysLeft < 0 ? 'the date to claim it has gone'
                                 : `${b.daysLeft} days left — claim by ${claimBy(b.docDate)}`}
                            v={'₹' + fmt0(b.tax)} />
                    ))}
                  </View>
                ))}
              </Job>
            )}

            <Job id="enter" title="Enter these in your books" count={s.waitingBills}
                 money={s.waiting} tone="ok"
                 note={'The supplier has declared these to the government, but they are not '
                     + 'in your books. Tap one and the purchase opens, already headed.'}>
              {enter.map((x, i) => (
                <Line key={i}
                      k={`${x.party || x.gstin || '—'} · ${x.docNo || '—'}`}
                      sub={`${x.docDate}${x.taxable ? `  ·  goods ₹${fmt0(x.taxable)}` : ''}`
                           + '  — enter this purchase'} go
                      v={`₹${fmt0(x.tax)}`}
                      onPress={() => { dirty.current = true;
                        navigation.navigate('Bill', {
                          vtype: 'purchase',
                          from2b: { gstin: x.gstin, party: x.party,
                                    docNo: x.docNo, docDate: x.docDate } }); }} />
              ))}
            </Job>

            {s.unseen > 0 && (
              <Job id="earlier" title="Look in an earlier return" count={s.unseen}
                   money={Math.abs(s.unseenTax)}
                   note={`These are dated ${earlier.join(', ')}, and you have not brought in `
                       + 'the 2B for those months. Nobody is at fault and nothing has been '
                       + 'compared — download those files and they will be checked too.'}>
                {res.booksUnseen.map((b, i) => (
                  <Line key={i} k={`${b.party || '—'} · ${b.docNo || '—'}`}
                        sub={`${b.docDate} — probably in ${monthName(String(b.docDate).slice(0, 7))}`}
                        v={`₹${fmt0(b.tax)}`} />
                ))}
              </Job>
            )}

            {s.different > 0 && (
              <Job id="fix" title="Small corrections" count={s.different}
                   money={s.queriedTax}
                   note={'These bills are on both sides, so the credit is safe. Something on '
                       + 'the entry just needs tidying.'}>
                {res.queried.map((p, i) => (
                  <View key={i} style={{ marginTop: 12 }}>
                    <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.ink }}>
                      {p.b.party || p.b.gstin || '—'} · {p.b.docNo || '—'}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>
                      {WHY[p.cls] || 'Matched, please confirm'}
                    </Text>
                    <Line k="Your books" v={`₹${fmt0(p.b.tax)}`} />
                    <Line k="The portal" v={`₹${fmt0(p.t.tax)}`}
                          tone={Math.abs(p.taxDiff) > 2 ? 'bad' : undefined} />
                    {p.b.docNo !== p.t.docNo && (
                      <Line k="His number" v={p.t.docNo || '—'} />
                    )}
                  </View>
                ))}
              </Job>
            )}

            {/* THE QUIET LINE. The difference between "this found four
                problems" and "this read all your bills and only four want
                you" is the whole of whether he trusts it next month. */}
            <View style={{ padding: 12, borderRadius: 12, borderWidth: 1,
                           borderColor: C.line, marginBottom: 10 }}>
              <Text style={{ fontSize: 12.5, color: C.muted, lineHeight: 18 }}>
                {fmt0(s.needNothing)} more bills were checked and need nothing from you —
                bills that agree, bills the supplier filed a month late, and freight and
                other reverse-charge bills that never appear in a 2B.
              </Text>
              {s.earlyPortal > 0 && (
                <Text style={{ fontSize: 12.5, color: C.muted, lineHeight: 18, marginTop: 6 }}>
                  {fmt0(s.earlyPortal)} bills in the government record are dated before{' '}
                  {s.booksFrom}, where your books start, and were left out — ₹
                  {fmt0(s.earlyPortalTax)} belonging to a year you have not loaded.
                </Text>
              )}
              {s.noGstinTax > 0 && (
                <Text style={{ fontSize: 12.5, color: C.muted, lineHeight: 18, marginTop: 6 }}>
                  ₹{fmt0(s.noGstinTax)} of purchases have no GST number on the supplier,
                  so they cannot be matched at all. Add the GSTIN under Customers.
                </Text>
              )}
            </View>

            {/* A BLOCKED CREDIT HE HAS ALREADY ENTERED is the dangerous one:
                it matches perfectly, is quietly kept out of the safe total,
                and if nothing names it he claims it anyway. */}
            {s.blockedInBooks > 0 && (
              <View style={{ backgroundColor: C.flagSoft, borderWidth: 1, borderColor: C.flagLine,
                             borderRadius: 12, padding: 12, marginBottom: 10 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: C.flagInk }}>
                  Do not claim ₹{fmt0(s.blockedInBooks)} — the portal will not allow it
                </Text>
                <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 3, lineHeight: 17 }}>
                  {s.blockedInBooksCount === 1 ? 'This bill matches' : 'These bills match'} your
                  purchase perfectly, but the 2B marks the credit not available.
                </Text>
                {res.blockedPairs.slice(0, 5).map((x, i) => (
                  <Text key={i} style={{ fontSize: 11.5, color: C.flagInk, marginTop: 4 }}>
                    • {x.t.party || x.t.gstin} — {x.t.docNo} — ₹{fmt0(x.t.tax)}
                    {x.blockedReason ? ` (${x.blockedReason})` : ''}
                  </Text>
                ))}
              </View>
            )}

            {res.dupes.length > 0 && (
              <View style={{ backgroundColor: C.flagSoft, borderWidth: 1, borderColor: C.flagLine,
                             borderRadius: 12, padding: 12, marginBottom: 10 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: C.flagInk }}>
                  Check {res.dupes.length} bill {res.dupes.length === 1 ? 'number' : 'numbers'} that
                  appear more than once
                </Text>
                {res.dupes.map((d, i) => (
                  <View key={i} style={{ marginTop: 8 }}>
                    <Text style={{ fontSize: 12, color: C.flagInk }}>
                      {d.docs[0]?.party || 'A supplier'} · {d.docs[0]?.docNo || '—'}
                      {d.src === 'books' ? '' : '  (on the portal, not your books)'}
                    </Text>
                    {d.src === 'books' && d.docs.map((x, j) => (
                      <TouchableOpacity key={j} disabled={!x.id}
                        onPress={() => navigation.navigate('Bill', { voucherId: x.id })}
                        style={[S.row, { paddingVertical: 7 }]}>
                        <Text style={{ flex: 1, fontSize: 13, fontWeight: '600',
                                       color: x.id ? C.accent : C.muted }}>
                          {x.docDate} · ₹{fmt0(x.tax)}{x.id ? '  — open it ›' : ''}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                ))}
              </View>
            )}

            <TouchableOpacity style={[S.btn, { marginTop: 4 }]} onPress={takeAway}>
              <Text style={S.btnText}>Take this list with me</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 6, textAlign: 'center' }}>
              The same four lists as a file. Open it, work down it, tick things off.
            </Text>

            <TouchableOpacity style={[S.btnGhost, { marginTop: 14 }]} onPress={pick}
              disabled={!!busy}>
              <Text style={S.ghostText}>Bring in another month</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
      </Swipe>

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
