import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt, fmt0, n2, today } from '../lib/money';
import { buildGstr1 } from '../lib/gstr1';
import { BackButton, Bar, Foot, Screen, Sections, Swipe, useSectionSwipe } from '../components/Chrome';
import { C, S } from '../theme';
import { sayPlainly } from '../lib/offline';

// WHAT THE BOOKS SAY.
//
// Four questions a shopkeeper and his accountant actually ask: what did I
// sell, what did I buy, how much GST do I owe, and what is moving. Nothing
// here is a new number — it is the bills, added up.

const RANGES = [
  { k: 'month', label: 'This month' },
  { k: 'last',  label: 'Last month' },
  { k: 'fy',    label: 'This year' },
  { k: 'all',   label: 'All' },
];

const firstOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

// EVERY ROW, NOT THE FIRST THOUSAND.
//
// Supabase hands back at most a thousand rows and says nothing about the rest.
// A shop doing 200 bills a month has more lines than that, and the return
// would quietly go out short. These two ask for the next page until a page
// comes back short.
async function allRows(build) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await build().range(from, from + size - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < size) return out;
  }
}

async function linesFor(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    out.push(...await allRows(() => supabase.from('voucher_lines')
      .select('*').in('voucher_id', part).order('id')));
  }
  return out;
}

function rangeOf(k) {
  const now = new Date();
  if (k === 'month') return [firstOf(now), null, 'this month'];
  if (k === 'last') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0);
    return [firstOf(s), today(e), 'last month'];
  }
  if (k === 'fy') {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return [`${y}-04-01`, null, `${y}-${String(y + 1).slice(2)}`];
  }
  return [null, null, 'everything'];
}

const dmy = (d) => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}`;

/* ---------------- one ruled line of a report ----------------

   THE RUPEE SIGN WAS SITTING IN THE DIGIT COLUMN.

   Every figure on a report card is monospaced so a column adds up by eye — and
   then the total, and only the total, had a ₹ stuck on the front of it. One
   character was enough to shift that row a character left of every row above
   it, which is exactly the thing monospacing is for. Worse, the totals were
   written without paise and the lines above them with, so nothing lined up with
   anything.

   So the ₹ has a narrow cell of its own, the digits have theirs, and every
   money figure in a card carries paise. Units under units, paise under paise.

   It also lives out here now rather than inside the screen, so React sees one
   component instead of a brand new kind of component on every redraw.         */
const Line = ({ k, v, strong, tone }) => {
  const t = String(v ?? '');
  const money = t.startsWith('₹');
  return (
    <View style={[S.tline, strong && { borderTopWidth: 1, borderTopColor: C.line,
                                       marginTop: 6, paddingTop: 8 }]}>
      <Text style={[S.tlineK, strong && { fontWeight: '700', color: C.ink },
                    tone && { color: tone }]}>{k}</Text>
      <Text style={[S.tlineV, S.num, { width: 13, textAlign: 'left' },
                    strong && { fontWeight: '700' }, tone && { color: tone }]}>
        {money ? '₹' : ''}
      </Text>
      <Text style={[S.tlineV, S.num, { flexShrink: 0 },
                    strong && { fontWeight: '700' }, tone && { color: tone }]}>
        {money ? t.slice(1) : t}
      </Text>
    </View>
  );
};

// WHAT EACH TAB IS FOR, IN ONE LINE.
//
// Three returns and the shop's own figures were one scroll, so the boxes his
// accountant asks for were somewhere below the day-by-day list. A return is a
// once-a-month job with a deadline; the sales summary is an every-evening look
// at the counter. Same figures, different errands.
const VIEWS = {
  summary: { title: 'Reports',
             blurb: 'Your own figures. Nothing here is filed anywhere.' },
  gstr1:   { title: 'GSTR-1',
             blurb: 'What you sold, the way the return asks for it. '
                  + 'One whole month at a time.' },
  gstr3b:  { title: 'GSTR-3B',
             blurb: 'What you owe and what you can claim back, box by box, '
                  + 'for your accountant to type in.' },
  cmp08:   { title: 'CMP-08',
             blurb: 'What you owe for the quarter under the composition scheme. '
                  + 'One figure, and the reverse charge beside it.' },
};

// THE FOUR QUARTERS A COMPOSITION RETURN IS FILED FOR, by the financial year
// the shop keeps -- April to March, not January to December.
const QUARTERS = [
  { key: 'q1', label: 'Apr\u2013Jun', from: [3, 1],  to: [5, 30] },
  { key: 'q2', label: 'Jul\u2013Sep', from: [6, 1],  to: [8, 30] },
  { key: 'q3', label: 'Oct\u2013Dec', from: [9, 1],  to: [11, 31] },
  { key: 'q4', label: 'Jan\u2013Mar', from: [0, 1],  to: [2, 31] },
];

// The financial year a date falls in: April decides it.
const fyOf = (d) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);

// The quarter a date is in, so the screen opens on the one he is likely to file.
const quarterOf = (d) => QUARTERS[Math.floor(((d.getMonth() + 9) % 12) / 3)].key;

const ymd = (y, m, day) => {
  // The last day of the month, so a quarter never runs into the next one --
  // written as day 0 of the following month, which is what Date does with it.
  //
  // THE CLAMP HAS TO HAPPEN BEFORE THE DATE IS BUILT, not after. `new Date(y,
  // m, 31)` for a thirty-day month has already rolled into the next one, and
  // setDate() on that only moves the day inside the wrong month -- 31 June
  // came out as 30 July. No quarter above asks for a day its month has not
  // got, so nothing was wrong on screen; a fifth row in that table would have
  // been.
  const last = new Date(y, m + 1, 0).getDate();
  const t = new Date(y, m, Math.min(day, last));
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

// A quarter's two dates, in the financial year that starts in `fy`.
export function quarterDates(qKey, fy) {
  const q = QUARTERS.find((x) => x.key === qKey) || QUARTERS[0];
  // Jan to March belongs to the year AFTER the one the April quarter started.
  const yr = q.key === 'q4' ? fy + 1 : fy;
  return [ymd(yr, q.from[0], q.from[1]), ymd(yr, q.to[0], q.to[1])];
}

const NO_CMP = 'Your Skwik database has not been updated for CMP-08 yet. '
  + 'Run the latest SQL and open this again.';

export default function ReportsScreen({ route, navigation }) {
  const { org, isOwner } = useApp();
  const [range, setRange] = useState('month');
  const [busy, setBusy]   = useState(true);
  const [vouchers, setVouchers] = useState([]);
  const [lines, setLines] = useState([]);
  const [pnl, setPnl] = useState(null);
  const [summary, setSummary] = useState(null);
  const [rcm, setRcm] = useState(null);         // the reverse-charge figures
  const [b3, setB3] = useState(null);           // the GSTR-3B boxes
  // CMP-08 ASKS FOR A QUARTER, NOT THE MONTH THE REST OF THIS SCREEN IS ON.
  //
  // Every other tab here follows the range chips -- this month, last month, the
  // year. A composition return has one shape and it is the quarter, so it keeps
  // its own choice and ignores those chips entirely. It opens on the quarter
  // today sits in, which is the one he is most likely to be filing.
  const [cmpQ, setCmpQ] = useState(() => quarterOf(new Date()));
  const [cmpFy, setCmpFy] = useState(() => fyOf(new Date()));
  const [cmp, setCmp] = useState(null);
  const [cmpBusy, setCmpBusy] = useState(false);

  // THE WHOLE YEAR USED TO COME DOWN THE WIRE.
  //
  // This screen asked for every bill and every line in the range and added
  // them up here. For a shop with 13,200 bills that is 37,000 lines — about
  // 8.6 MB of rows, well over 20 MB once JSON puts the column names back on
  // every one of them, across fifty round trips, on a mobile pack, EVERY time
  // he opens the screen. Then it parsed all of it and walked it three times on
  // the thread that draws the screen.
  //
  // Every figure on this page is a SUM or a GROUP BY. report_summary does them
  // on the server in about seventy milliseconds and sends back 3.6 KB.
  //
  // The old road is kept underneath, because a phone can be updated before the
  // database is, and a shopkeeper who has not run the new SQL yet must still
  // get his reports.
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [from, to] = rangeOf(range);

      // REVERSE CHARGE. Asked for on its own so that a phone running ahead of
      // the database — he has updated the app but not run the SQL yet — still
      // gets the rest of his reports instead of an error.
      supabase.rpc('rcm_summary',
        { p_from: from || '2000-04-01', p_to: to || today() })
        .then((r) => setRcm(r.error ? null : r.data))
        .catch(() => setRcm(null));

      // And the 3B boxes, asked for the same way and just as forgivingly.
      supabase.rpc('gstr3b_summary',
        { p_from: from || '2000-04-01', p_to: to || today() })
        .then((r) => setB3(r.error ? null : r.data))
        .catch(() => setB3(null));

      const sum = await supabase.rpc('report_summary',
        { p_from: from || '2000-04-01', p_to: to || today() });
      if (!sum.error && sum.data) {
        setSummary(sum.data);
        setVouchers([]); setLines([]);
        const { data: pl } = await supabase.rpc('profit_and_loss',
          { p_from: from || '2000-04-01', p_to: to || today() });
        setPnl(pl || null);
        return;
      }
      setSummary(null);
      await loadTheLongWay(from, to);
    } catch (e) {
      Alert.alert('Could not load', sayPlainly(e));
    } finally { setBusy(false); }
  }, [range]);

  const loadTheLongWay = async (from, to) => {
    {
      const vs = await allRows(() => {
        let q = supabase.from('vouchers')
          // a cancelled bill is not a sale, and must not be added into one
          .is('cancelled_at', null)
          .select('*, parties(name, gstin, state_name)').order('vdate').order('id');
        if (from) q = q.gte('vdate', from);
        if (to)   q = q.lte('vdate', to);
        return q;
      });
      setVouchers(vs);
      setLines(vs.length ? await linesFor(vs.map((v) => v.id)) : []);

      // what the shop earned: sales less the cost of what went out, less the
      // money that went on rent, salary and the rest
      const { data: pl } = await supabase.rpc('profit_and_loss',
        { p_from: from || '2000-04-01', p_to: to || today() });
      setPnl(pl || null);
    }
  };

  useFocusEffect(useCallback(() => { load(); }, [load]));

  /* ---------------- the sums ---------------- */

  const sums = useMemo(() => {
    const blank = () => ({ n: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });

    // THE SHORT ROAD: the server already grouped everything.
    if (summary) {
      const pick = (f) => {
        const a = blank();
        for (const h of (summary.heads || [])) {
          if (!f(h)) continue;
          a.n += Number(h.n || 0);
          a.taxable = n2(a.taxable + Number(h.taxable || 0));
          a.cgst    = n2(a.cgst + Number(h.cgst || 0));
          a.sgst    = n2(a.sgst + Number(h.sgst || 0));
          a.igst    = n2(a.igst + Number(h.igst || 0));
          a.total   = n2(a.total + Number(h.total || 0));
        }
        return a;
      };
      const sSales  = pick((h) => h.vtype === 'sale');
      const sPurch  = pick((h) => h.vtype === 'purchase');
      const sEst    = pick((h) => h.vtype === 'estimate');
      // section 34(2): a credit note raised after 30 November refunds the
      // customer and changes nothing about the tax
      const sInTime = pick((h) => h.vtype === 'sale_return' && h.gst_effective !== false);
      const sLate   = pick((h) => h.vtype === 'sale_return' && h.gst_effective === false);
      return {
        sales: sSales, purchases: sPurch, estimates: sEst,
        returns: {
          taxable: n2(sInTime.taxable + sLate.taxable),
          cgst: n2(sInTime.cgst + sLate.cgst),
          sgst: n2(sInTime.sgst + sLate.sgst),
          igst: n2(sInTime.igst + sLate.igst),
          total: n2(sInTime.total + sLate.total),
        },
        lateReturns: sLate,
        rates: (summary.rates || []).map((r) => ({
          rate: Number(r.rate || 0), taxable: Number(r.taxable || 0),
          cgst: Number(r.cgst || 0), sgst: Number(r.sgst || 0), igst: Number(r.igst || 0),
        })).sort((a, b) => a.rate - b.rate),
        b2bTaxable: Number(summary.b2b_taxable || 0),
        b2cTaxable: Number(summary.b2c_taxable || 0),
        days: (summary.days || []).map((d) => [d.d, Number(d.total || 0)]),
        items: (summary.items || []).map((i) => ({
          name: i.name, qty: Number(i.qty || 0), value: Number(i.value || 0), unit: i.unit,
        })),
        gstOwed: n2(sSales.cgst + sSales.sgst + sSales.igst
                  - sInTime.cgst - sInTime.sgst - sInTime.igst),
        gstLateNotes: n2(sLate.cgst + sLate.sgst + sLate.igst),
        itc: n2(sPurch.cgst + sPurch.sgst + sPurch.igst),
      };
    }

    const add = (acc, v) => {
      acc.n += 1;
      acc.taxable = n2(acc.taxable + Number(v.taxable || 0));
      acc.cgst    = n2(acc.cgst + Number(v.cgst || 0));
      acc.sgst    = n2(acc.sgst + Number(v.sgst || 0));
      acc.igst    = n2(acc.igst + Number(v.igst || 0));
      acc.total   = n2(acc.total + Number(v.total || 0));
      return acc;
    };

    // A CREDIT NOTE RAISED TOO LATE IS A REAL REFUND BUT NOT A TAX REDUCTION.
    // Section 34(2) closes the door on 30 November. The GSTR-1 file already
    // left those notes out; this screen did not, so it told the shopkeeper he
    // owed less than his own return said he owed — and the screen is what he
    // looks at. `lateReturns` is kept apart so the money still shows.
    const sales = blank(), purchases = blank(), estimates = blank();
    const inTime = blank();     // credit notes that still reduce the tax
    const late   = blank();     // raised after 30 November: money, but no tax relief
    const byDay = {};
    for (const v of vouchers) {
      if (v.vtype === 'sale')      { add(sales, v);
                                     byDay[v.vdate] = n2((byDay[v.vdate] || 0) + Number(v.total || 0)); }
      else if (v.vtype === 'purchase') add(purchases, v);
      else if (v.vtype === 'sale_return') add(v.gst_effective === false ? late : inTime, v);
      else if (v.vtype === 'estimate') { add(estimates, v);
                                     byDay[v.vdate] = n2((byDay[v.vdate] || 0) + Number(v.total || 0)); }
    }

    // GSTR-1 wants it split by rate, and registered buyers kept apart from
    // everyone else.
    const saleIds = new Set(vouchers.filter((v) => v.vtype === 'sale').map((v) => v.id));
    const b2b = new Set(vouchers.filter((v) => v.vtype === 'sale' && v.parties?.gstin).map((v) => v.id));
    const byRate = {};
    let b2bTaxable = 0, b2cTaxable = 0;
    for (const l of lines) {
      if (!saleIds.has(l.voucher_id)) continue;
      const r = Number(l.gst_rate || 0);
      byRate[r] = byRate[r] || { rate: r, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      byRate[r].taxable = n2(byRate[r].taxable + Number(l.taxable || 0));
      byRate[r].cgst    = n2(byRate[r].cgst + Number(l.cgst || 0));
      byRate[r].sgst    = n2(byRate[r].sgst + Number(l.sgst || 0));
      byRate[r].igst    = n2(byRate[r].igst + Number(l.igst || 0));
      if (b2b.has(l.voucher_id)) b2bTaxable = n2(b2bTaxable + Number(l.taxable || 0));
      else                       b2cTaxable = n2(b2cTaxable + Number(l.taxable || 0));
    }

    // what actually moved
    const byItem = {};
    for (const l of lines) {
      if (!saleIds.has(l.voucher_id)) continue;
      const k = l.item_name;
      byItem[k] = byItem[k] || { name: k, qty: 0, value: 0, unit: l.unit };
      byItem[k].qty   = n2(byItem[k].qty + Number(l.qty || 0));
      byItem[k].value = n2(byItem[k].value + Number(l.taxable || 0));
    }

    // everything that came back, for the money figures on screen
    const returns = {
      taxable: n2(inTime.taxable + late.taxable),
      cgst:    n2(inTime.cgst + late.cgst),
      sgst:    n2(inTime.sgst + late.sgst),
      igst:    n2(inTime.igst + late.igst),
      total:   n2(inTime.total + late.total),
    };

    return {
      sales, purchases, estimates, returns,
      lateReturns: late,
      rates: Object.values(byRate).sort((a, b) => a.rate - b.rate),
      b2bTaxable, b2cTaxable,
      days: Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 31),
      items: Object.values(byItem).sort((a, b) => b.value - a.value).slice(0, 15),
      // Credit notes reduce what is owed — but only the ones raised in time.
      // A note past the 30 November deadline in section 34(2) refunds the
      // customer and changes nothing about the tax, so only `inTime` comes off
      // here. This is now the same rule the GSTR-1 file uses, so the screen
      // and the return finally agree.
      gstOwed: n2(sales.cgst + sales.sgst + sales.igst
                - inTime.cgst - inTime.sgst - inTime.igst),
      gstLateNotes: n2(late.cgst + late.sgst + late.igst),
      itc: n2(purchases.cgst + purchases.sgst + purchases.igst),
    };
  }, [vouchers, lines, summary]);

  // ASKED FOR ON ITS OWN, and forgivingly: a phone that has the new app but
  // whose database has not had 1.10.53 run yet gets a plain sentence rather
  // than an error across the screen.
  useEffect(() => {
    let gone = false;
    const [from, to] = quarterDates(cmpQ, cmpFy);
    setCmpBusy(true);
    supabase.rpc('cmp08', { p_from: from, p_to: to })
      .then((r) => { if (!gone) setCmp(r.error ? { ok: false, why: NO_CMP } : r.data); })
      .catch(() => { if (!gone) setCmp({ ok: false, why: NO_CMP }); })
      .finally(() => { if (!gone) setCmpBusy(false); });
    return () => { gone = true; };
  }, [cmpQ, cmpFy]);

  const label = rangeOf(range)[2];

  // IS THERE ANYTHING IN THIS PERIOD AT ALL?
  //
  // This used to be `vouchers.length`, and the fast road above deliberately
  // empties `vouchers` — report_summary does the adding up on the server and
  // sends back the totals, not the bills. So on every phone whose database
  // has the summary function, the whole of this screen was hidden behind a
  // test that could never be true and the shopkeeper was told "Nothing in
  // this month" over a month of trade. The question has to be asked of
  // whichever road was taken.
  //
  // The last two terms are main's answer to the same fault, kept alongside:
  // they ask the server's reply directly, so a month holding only heads this
  // screen draws no card for still counts as a month with something in it.
  const anything = summary
    ? !!(sums.sales.n || sums.purchases.n || sums.estimates.n
         || sums.rates.length || sums.items.length || sums.days.length
         || sums.returns.total
         || (summary.heads || []).length || (summary.days || []).length)
    : vouchers.length > 0;

  // WHICH OF THE FOUR HE IS ON. The fourth, GSTR-2B, is a screen of its own —
  // it reads a file off the portal — so it is not one of these.
  const view = VIEWS[route?.params?.view] ? route.params.view : 'summary';
  // The chip strip marks itself by the screen's own id, and here one screen
  // wears three. Summary keeps the group's id so the Reports key still lights.
  const me = view === 'summary' ? 'reports' : view;
  const swipe = useSectionSwipe(navigation, org, isOwner, me);

  // A RETURN COVERS ONE MONTH AND NOTHING ELSE. Section 39 gives no way to
  // file a quarter or a year as one, so on either return tab the year and All
  // buttons produce figures that cannot be filed — said once, at the top,
  // rather than leaving him to wonder why the boxes went away.
  const wholeMonth = range === 'month' || range === 'last';

  // THE RETURN ITSELF.
  // Only ever for one whole month — the portal will not take anything else.
  const [filing, setFiling] = useState(false);

  const makeGstr1 = async () => {
    const now = new Date();
    let y = now.getFullYear(), m = now.getMonth() + 1;
    if (range === 'last') { const d = new Date(y, m - 2, 1); y = d.getFullYear(); m = d.getMonth() + 1; }
    else if (range !== 'month') {
      return Alert.alert('Which month?',
        'A GSTR-1 covers one month. Choose This month or Last month first.');
    }

    setFiling(true);
    try {
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      const to   = today(new Date(y, m, 0));

      // The cancelled ones come too: they are left out of every value table
      // and counted in the documents-issued table, which is the one place the
      // portal asks about them.
      const vs = await allRows(() => supabase.from('vouchers')
        .select('*, parties(name, gstin, state_code, state_name)')
        .gte('vdate', from).lte('vdate', to).order('vdate').order('id'));

      const byV = {};
      if (vs.length) {
        (await linesFor(vs.map((v) => v.id)))
          .forEach((l) => { (byV[l.voucher_id] = byV[l.voucher_id] || []).push(l); });
      }

      const r = buildGstr1({ org, vouchers: vs, linesByVoucher: byV, year: y, month: m });

      const go = async () => {
        const name = `GSTR1-${org?.gstin || 'firm'}-${String(m).padStart(2, '0')}${y}.json`;
        const f = new File(Paths.cache, name);
        try { if (f.exists) f.delete(); } catch (e) { /* first time */ }
        f.create(); f.write(JSON.stringify(r.json));
        if (!(await Sharing.isAvailableAsync())) {
          return Alert.alert('Nothing to share with', 'This phone has no app set up to receive files.');
        }
        await Sharing.shareAsync(f.uri, { mimeType: 'application/json', dialogTitle: name });
      };

      const s = r.summary;
      const body = `${s.bills} bills, ${s.notes} credit note${s.notes === 1 ? '' : 's'}.\n`
        + `${s.b2b} to registered buyers, ${s.b2cl} large out-of-state, `
        + `${s.b2cs} summary row${s.b2cs === 1 ? '' : 's'}.\n\n`
        + `Taxable ₹${fmt0(s.taxable)}, tax ₹${fmt0(s.tax)}.`
        + (r.problems.length ? `\n\nBefore you file:\n· ${r.problems.join('\n· ')}` : '');

      Alert.alert(`GSTR-1 for ${String(m).padStart(2, '0')}/${y}`, body,
        [{ text: 'Not now' }, { text: 'Send the file', onPress: go }]);
    } catch (e) {
      Alert.alert('Could not build it', sayPlainly(e));
    } finally { setFiling(false); }
  };

  /* ---------------- send it on ---------------- */

  const share = async () => {
    const q = (x) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [
      ['Skwik report', org?.name || '', label],
      [],
      ['Sales', 'bills', sums.sales.n],
      ['', 'taxable', sums.sales.taxable],
      ['', 'CGST', sums.sales.cgst], ['', 'SGST', sums.sales.sgst], ['', 'IGST', sums.sales.igst],
      ['', 'total', sums.sales.total],
      [],
      ['Purchases', 'bills', sums.purchases.n],
      ['', 'taxable', sums.purchases.taxable],
      ['', 'CGST', sums.purchases.cgst], ['', 'SGST', sums.purchases.sgst], ['', 'IGST', sums.purchases.igst],
      ['', 'total', sums.purchases.total],
      [],
      ['GST on sales', '', sums.gstOwed],
      ['GST on purchases', '', sums.itc],
      ['Difference', '', n2(sums.gstOwed - sums.itc)],
      [],
      ['Sales by GST rate'],
      ['rate %', 'taxable', 'CGST', 'SGST', 'IGST'],
      ...sums.rates.map((r) => [r.rate, r.taxable, r.cgst, r.sgst, r.igst]),
      [],
      ['To registered buyers (B2B)', '', sums.b2bTaxable],
      ['To everyone else (B2C)', '', sums.b2cTaxable],
      [],
      ['What sold'],
      ['item', 'qty', 'value'],
      ...sums.items.map((i) => [i.name, i.qty, i.value]),
    ];
    const csv = rows.map((r) => r.map(q).join(',')).join('\n');
    try {
      const f = new File(Paths.cache, `skwik-report-${label.replace(/\s+/g, '-')}.csv`);
      try { if (f.exists) f.delete(); } catch (e) { /* first time */ }
      f.create(); f.write(csv);
      if (!(await Sharing.isAvailableAsync())) {
        return Alert.alert('Nothing to share with', 'This phone has no app set up to receive files.');
      }
      await Sharing.shareAsync(f.uri, { mimeType: 'text/csv', dialogTitle: 'Send report' });
    } catch (e) {
      Alert.alert('Could not send', sayPlainly(e));
    }
  };

  /* ---------------- screen ---------------- */

  // THE BOTTOM LINE HAS TO BE THE SERVER'S BOTTOM LINE.
  //
  // profit_and_loss works out net = sale − cost − expenses − written_off and
  // hands the answer over with the rest. This screen threw that answer away
  // and did the sum again here with one term missing: sale − cost − expenses.
  // written_off came down the wire on every load and was never once read.
  //
  // Written off is the stock that went nowhere: the drum that was dented in
  // the godown, the bag that split, a box that walked, anything the count
  // screen took off the shelf. It is a real loss and the server subtracts it.
  // A month where ₹20,000 of goods were written off read ₹20,000 better
  // than it was, and it read that way on the one figure he actually decides
  // on — what to draw for the house, whether he can pay for the next lot.
  // Nothing on the card so much as hinted the line existed, so there was no
  // way for him to notice it was missing.
  //
  // The server's own `net` is used as it stands, so this card and the books
  // can never drift apart again. The sum is kept only as a fallback for a
  // phone that has been updated while the database behind it has not — the
  // same reason the long road under this screen still exists — and each term
  // falls back to nought on its own, so one missing key cannot turn the whole
  // figure into nothing.
  const pnlNet = !pnl ? 0
    : (pnl.net !== undefined && pnl.net !== null)
      ? n2(pnl.net)
      : n2((Number(pnl.sale) || 0) - (Number(pnl.cost) || 0)
           - (Number(pnl.expenses) || 0) - (Number(pnl.written_off) || 0));

  const Card = ({ title, children }) => (
    <View style={S.card}>
      <Text style={S.eyebrow}>{title}</Text>
      {children}
    </View>
  );

  return (
    <Screen>
      <Bar>
        <BackButton navigation={navigation} />
        <View style={{ flex: 1 }}>
          <Text style={S.barName}>{VIEWS[view].title}</Text>
          <Text style={S.barSub}>{label}</Text>
        </View>
        <TouchableOpacity onPress={share} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff', opacity: 0.9 }}>SEND</Text>
        </TouchableOpacity>
      </Bar>
      <Sections navigation={navigation} org={org} isOwner={isOwner} id={me} />

      <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                     borderBottomWidth: 1, borderBottomColor: C.line }}>
        <View style={[S.row, { gap: 6 }]}>
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
      </View>

      <Swipe {...swipe} style={{ flex: 1 }}>
      {busy ? (
        <View style={{ paddingTop: 60, alignItems: 'center' }}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>

          {/* THIS WHOLE PAGE WAS BLANK FOR EVERY SHOP THAT HAD RUN THE SQL.
              *
              * Making reports fast in 1.9.4 moved the figures onto the server:
              * report_summary does the sums and the screen empties `vouchers`
              * because it no longer needs the rows. But both halves of this
              * page were still gated on `vouchers.length`, so the moment the
              * fast road worked, the page said "Nothing in this month" and hid
              * everything — the totals, the rate-wise split, the profit, AND
              * the button that makes the GSTR-1 file. A shop could have four
              * hundred bills in the month and be told it had none.
              */}
          {!anything && (
            <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center',
                           marginTop: 40, lineHeight: 20 }}>
              Nothing in {label}.
            </Text>
          )}

          {anything && (
            <>
              {view === 'summary' && (
                <>
              <Card title={`Sales — ${label}`}>
                <Line k={`${sums.sales.n} bill${sums.sales.n === 1 ? '' : 's'}`} v="" />
                <Line k="Goods" v={fmt(sums.sales.taxable)} />
                {!!sums.sales.cgst && <Line k="CGST" v={fmt(sums.sales.cgst)} />}
                {!!sums.sales.sgst && <Line k="SGST" v={fmt(sums.sales.sgst)} />}
                {!!sums.sales.igst && <Line k="IGST" v={fmt(sums.sales.igst)} />}
                <Line k="Total" v={`₹${fmt(sums.sales.total)}`} strong />
              </Card>

              {!!sums.estimates.n && (
                <Card title="Estimates">
                  <Line k={`${sums.estimates.n} estimate${sums.estimates.n === 1 ? '' : 's'}`}
                        v={`₹${fmt(sums.estimates.total)}`} />
                </Card>
              )}

              {!!sums.purchases.n && (
                <Card title="Purchases">
                  <Line k={`${sums.purchases.n} bill${sums.purchases.n === 1 ? '' : 's'}`} v="" />
                  <Line k="Goods" v={fmt(sums.purchases.taxable)} />
                  <Line k="Total" v={`₹${fmt(sums.purchases.total)}`} strong />
                </Card>
              )}

              {!!pnl && (
                <Card title="What you earned">
                  <Line k="Sold (before tax)" v={fmt(pnl.sale)} />
                  <Line k="What those goods cost" v={fmt(pnl.cost)} />
                  <Line k="Gross profit" v={fmt(n2(Number(pnl.sale) - Number(pnl.cost)))} />
                  {!!Number(pnl.expenses) && <Line k="Money out" v={fmt(pnl.expenses)} />}
                  {/* Only when there is one. A shop that has written nothing
                      off should not be shown a line of noughts and left
                      wondering what it is accusing him of. */}
                  {!!Number(pnl.written_off) && (
                    <Line k="Goods written off" v={fmt(pnl.written_off)} />
                  )}
                  {/* PURCHASES ARE NOT ON THIS CARD, AND THAT IS ON PURPOSE.
                      profit_and_loss also sends `purchase`, what he bought in
                      the period. It stays off, for two reasons. The Purchases
                      card above already shows it, out of report_summary. And
                      on a profit the figure that comes off the sale is what
                      the goods that WENT OUT cost — not what came IN. Buy
                      forty drums, sell two, and the money for the other
                      thirty-eight is not lost: they are on the shelf, and they
                      are on the balance sheet under Books. Put "Purchases"
                      between "What those goods cost" and "Left" and he
                      subtracts it in his head, reads a loss in a month he did
                      well in, and stops buying stock. */}
                  <Line k="Left" strong v={`₹${fmt(pnlNet)}`} />
                  {(pnl.heads || []).map((h) => (
                    <Line key={h.head} k={`   ${h.head}`} v={fmt(h.amount)} />
                  ))}
                  <Text style={S.hint}>
                    {pnl.counts_estimates
                      ? 'This shop bills on estimates, so an estimate is a sale and is '
                        + 'counted here. '
                      : 'Estimates written since you registered are quotations, not sales, '
                        + 'so they are not counted. Anything you billed on an estimate '
                        + 'BEFORE you registered still counts, and always will. '}
                    The cost is taken from each item's purchase price, so it is only
                    as right as those are. Bills where the item was typed in by hand
                    and never saved carry no cost at all.
                  </Text>
                </Card>
              )}

              {!!sums.items.length && (
                <Card title="What sold">
                  {/* THREE COLUMNS, NOT THREE THINGS IN A ROW.
                      The quantity had no width of its own, so it started
                      wherever the name happened to end and the amount started
                      wherever the quantity happened to end — two ragged columns
                      of figures down a card whose whole job is to be read down.
                      Both are given a width and right aligned. */}
                  {sums.items.map((i) => (
                    <View key={i.name} style={[S.row, { marginBottom: 6, alignItems: 'baseline' }]}>
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: C.ink }}>
                        {i.name}
                      </Text>
                      <Text style={[{ fontSize: 12.5, color: C.muted, width: 62,
                                      textAlign: 'right' }, S.num]}>
                        {i.qty}
                      </Text>
                      <Text style={[{ fontSize: 14, fontWeight: '700', color: C.ink,
                                      minWidth: 78, textAlign: 'right' }, S.num]}>
                        {fmt0(i.value)}
                      </Text>
                    </View>
                  ))}
                </Card>
              )}

              {!!sums.days.length && (
                <Card title="Day by day">
                  {sums.days.map(([d, total]) => (
                    <View key={d} style={[S.row, { marginBottom: 5, alignItems: 'baseline' }]}>
                      <Text style={{ flex: 1, fontSize: 13.5, color: C.muted }}>{dmy(d)}</Text>
                      <Text style={[{ fontSize: 14, fontWeight: '600', color: C.ink,
                                      minWidth: 90, textAlign: 'right' }, S.num]}>
                        {fmt0(total)}
                      </Text>
                    </View>
                  ))}
                </Card>
              )}
                </>
              )}

              {view === 'gstr1' && (
                <>
                  <Text style={[S.hint, { marginTop: 0, marginBottom: 2 }]}>
                    {VIEWS.gstr1.blurb}
                  </Text>
              {/* A RETURN IS A MONTH. Said once, at the top, rather than
                  letting the boxes quietly disappear when he taps This year. */}
              {!wholeMonth && (
                <View style={S.card}>
                  <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.ink,
                                 lineHeight: 20 }}>
                    A return covers one whole month.
                  </Text>
                  <Text style={[S.hint, { marginTop: 4 }]}>
                    Tap This month or Last month above. The figures for a year or
                    for All are on the Summary tab — they are yours to read, not
                    anything you can file.
                  </Text>
                </View>
              )}
              {org?.is_gst_registered && !org?.is_composition && (
                <TouchableOpacity style={S.card} onPress={makeGstr1} disabled={filing}>
                  <Text style={S.eyebrow}>Your return</Text>
                  <View style={S.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 16, fontWeight: '700', color: C.accent }}>
                        {filing ? 'Working it out…' : 'Make the GSTR-1 file'}
                      </Text>
                      <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 18 }}>
                        The JSON the GST portal takes, worked out from these bills.
                        One month at a time. You still file it yourself — read it first.
                      </Text>
                    </View>
                    {filing && <ActivityIndicator size="small" color={C.accent} />}
                  </View>
                </TouchableOpacity>
              )}

              {!!sums.rates.length && (
                <Card title="Sales by GST rate">
                  {sums.rates.map((r) => (
                    <Line key={r.rate} k={`${r.rate}%`}
                      v={`${fmt(r.taxable)}  +  ${fmt(n2(r.cgst + r.sgst + r.igst))}`} />
                  ))}
                  <Line k="To registered buyers" v={fmt(sums.b2bTaxable)} strong />
                  <Line k="To everyone else" v={fmt(sums.b2cTaxable)} />
                </Card>
              )}

                </>
              )}

              {view === 'cmp08' && (
                <>
                  {/* HIS OWN QUARTER PICKER. The range chips above belong to
                    * the other tabs; a composition return is filed by quarter
                    * and nothing else, so it says so and keeps its own. */}
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    {QUARTERS.map((q) => {
                      const on = cmpQ === q.key;
                      return (
                        <TouchableOpacity key={q.key} onPress={() => setCmpQ(q.key)}
                          style={{ paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8,
                                   borderWidth: 1.5,
                                   borderColor: on ? C.accent : C.line,
                                   backgroundColor: on ? C.accent : 'transparent' }}>
                          <Text style={{ fontSize: 13, fontWeight: on ? '700' : '500',
                                         color: on ? '#fff' : C.ink }}>{q.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={[S.hint, { marginTop: 0, marginBottom: 2 }]}>
                    {quarterDates(cmpQ, cmpFy)[0]} to {quarterDates(cmpQ, cmpFy)[1]}
                    {'  ·  '}
                    <Text onPress={() => setCmpFy(cmpFy - 1)} style={{ color: C.accent, fontWeight: '700' }}>
                      last year
                    </Text>
                    {cmpFy !== fyOf(new Date()) ? (
                      <>
                        {'  ·  '}
                        <Text onPress={() => setCmpFy(fyOf(new Date()))}
                              style={{ color: C.accent, fontWeight: '700' }}>this year</Text>
                      </>
                    ) : null}
                  </Text>

                  {cmpBusy && !cmp ? (
                    <View style={{ paddingVertical: 30, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color={C.accent} />
                    </View>
                  ) : !cmp ? null : !cmp.ok ? (
                    <View style={S.card}>
                      <Text style={{ fontSize: 13.5, color: C.ink, lineHeight: 20 }}>
                        {cmp.why}
                      </Text>
                    </View>
                  ) : (
                    <>
                      {/* THE FIGURE HE PAYS, FIRST AND ON ITS OWN. Everything
                        * under it is how it was arrived at. */}
                      <View style={[S.card, { borderColor: C.accent, borderWidth: 1.5 }]}>
                        <Text style={S.eyebrow}>What to pay for this quarter</Text>
                        <Text style={[{ fontSize: 34, fontWeight: '700', color: C.accent,
                                        marginTop: 4 }, S.num]}>
                          {'₹'}{fmt(cmp.pay)}
                        </Text>
                        <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 6, lineHeight: 18 }}>
                          In cash. A composition dealer claims nothing back, so there is
                          nothing to set against this. You file it yourself on the portal —
                          read these figures first.
                        </Text>
                      </View>

                      <Card title="Turnover">
                        <Line k="What you billed" v={fmt(cmp.billed)} />
                        {Number(cmp.returned) > 0 && (
                          <Line k="Less what came back" v={fmt(cmp.returned)} />
                        )}
                        <Line k="Turnover for the quarter" v={fmt(cmp.turnover)} strong />
                        <Line k={`Tax at ${cmp.rate}%`} v={fmt(cmp.tax)} />
                        <Line k="Central (CGST)" v={fmt(cmp.cgst)} />
                        <Line k="State (SGST)" v={fmt(cmp.sgst)} />
                      </Card>

                      {/* REVERSE CHARGE IS NOT AT THE COMPOSITION RATE and is
                        * not set off against anything. Shown apart for that
                        * reason, and only when there is any. */}
                      {Number(cmp.rcm_tax) > 0 && (() => {
                        /* THE BREAKDOWN LIVES IN table_3_1_d. `rcm` is
                         * rcm_summary()'s own answer, which keeps the
                         * reverse-charge tax in GSTR-3B's boxes under that
                         * key. Read flat off `rcm` these five lines were all
                         * undefined, so every one of them printed nought
                         * beside a total that was not nought. */
                        const rd = (cmp.rcm || {}).table_3_1_d || {};
                        return (
                          <Card title="Reverse charge, paid separately">
                            <Line k="Value of those bills" v={fmt(rd.taxable_value || 0)} />
                            <Line k="Tax on them, at the normal rate" v={fmt(cmp.rcm_tax)} strong />
                            <Line k="Central (CGST)" v={fmt(rd.central_tax || 0)} />
                            <Line k="State (SGST)" v={fmt(rd.state_tax || 0)} />
                            <Line k="Integrated (IGST)" v={fmt(rd.integrated_tax || 0)} />
                          </Card>
                        );
                      })()}

                      <Text style={[S.hint, { marginTop: 14, lineHeight: 19 }]}>
                        {cmp.bills} bill(s) in this quarter
                        {Number(cmp.returns) > 0 ? `, ${cmp.returns} return(s)` : ''}.
                        Cancelled bills are left out. CMP-08 is filed every quarter and
                        GSTR-4 once a year — your accountant files the yearly one.
                        Check the due date with him; it has been extended more than once.
                      </Text>
                    </>
                  )}
                </>
              )}

              {view === 'gstr3b' && (
                <>
                  <Text style={[S.hint, { marginTop: 0, marginBottom: 2 }]}>
                    {VIEWS.gstr3b.blurb}
                  </Text>
              {/* A RETURN IS A MONTH. Said once, at the top, rather than
                  letting the boxes quietly disappear when he taps This year. */}
              {!wholeMonth && (
                <View style={S.card}>
                  <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.ink,
                                 lineHeight: 20 }}>
                    A return covers one whole month.
                  </Text>
                  <Text style={[S.hint, { marginTop: 4 }]}>
                    Tap This month or Last month above. The figures for a year or
                    for All are on the Summary tab — they are yours to read, not
                    anything you can file.
                  </Text>
                </View>
              )}
              {!!b3 && b3.applies && wholeMonth && (
                <Card title="GSTR-3B — the figures">
                  <Text style={[S.hint, { marginTop: 0, marginBottom: 8 }]}>
                    For your accountant to type in. Not a filed return.
                  </Text>
                  <Line k="3.1(a) taxable sales"
                        v={fmt(b3.table_3_1?.a_outward_taxable?.taxable_value)} strong />
                  {['integrated_tax', 'central_tax', 'state_tax'].map((t) =>
                    Number(b3.table_3_1?.a_outward_taxable?.[t]) > 0 ? (
                      <Line key={t}
                        k={'   ' + (t === 'integrated_tax' ? 'IGST' : t === 'central_tax' ? 'CGST' : 'SGST')}
                        v={fmt(b3.table_3_1?.a_outward_taxable?.[t])} />
                    ) : null)}
                  {Number(b3.table_3_1?.c_nil_and_exempt?.taxable_value) > 0 && (
                    <Line k="3.1(c) nil-rated and exempt"
                          v={fmt(b3.table_3_1?.c_nil_and_exempt?.taxable_value)} />
                  )}
                  {Number(b3.table_3_1?.d_inward_reverse_charge?.taxable_value) > 0 && (
                    <Line k="3.1(d) on reverse charge"
                          v={fmt(b3.table_3_1?.d_inward_reverse_charge?.taxable_value)
                             + '  +  ' + fmt(b3.table_3_1?.d_inward_reverse_charge?.total_tax)} />
                  )}
                  {Number(b3.table_3_1?.e_non_gst?.taxable_value) > 0 && (
                    <Line k="3.1(e) outside GST"
                          v={fmt(b3.table_3_1?.e_non_gst?.taxable_value)} />
                  )}
                  {(b3.table_3_2_interstate_unregistered || []).map((r) => (
                    <Line key={r.state} k={`3.2 to ${r.state}, unregistered`}
                          v={fmt(r.taxable_value) + '  +  ' + fmt(r.integrated_tax)} />
                  ))}
                  <Line k="4(A)(5) credit on purchases"
                        v={fmt(b3.table_4?.a5_all_other_itc?.total)} strong />
                  {Number(b3.table_4?.a3_reverse_charge?.total_tax) > 0 && (
                    <Line k="4(A)(3) credit on reverse charge"
                          v={fmt(b3.table_4?.a3_reverse_charge?.total_tax)} />
                  )}
                  {Number(b3.table_5_inward_nil_exempt?.value) > 0 && (
                    <Line k="5 inward, nil and exempt"
                          v={fmt(b3.table_5_inward_nil_exempt?.value)} />
                  )}
                  <Text style={[S.hint, { marginTop: 10 }]}>
                    Your accountant still fills in:
                  </Text>
                  {(b3.your_accountant_fills || []).map((t, i) => (
                    <Text key={i} style={[S.hint, { marginTop: 4 }]}>{'\u00B7 ' + t}</Text>
                  ))}
                </Card>
              )}

              {org?.is_gst_registered && !org?.is_composition && (
                <Card title="GST">
                  <Line k="On what you sold" v={fmt(sums.gstOwed)} />
                  <Line k="On what you bought" v={fmt(sums.itc)} />
                  <Line k={sums.gstOwed >= sums.itc ? 'Difference to pay' : 'Credit in hand'}
                        v={fmt(Math.abs(n2(sums.gstOwed - sums.itc)))} strong />
                  <Text style={S.hint}>
                    A rough figure from your own bills, to check against the portal.
                    It is not your return, and your accountant has the last word.
                  </Text>
                </Card>
              )}

              {/* WHAT HE OWES BECAUSE NOBODY CHARGED HIM.
                *
                * Freight, mostly. The transporter charges no GST and the shop
                * owes it, and until now Skwik neither worked it out nor said
                * so — the GST figure above was short by every rupee of it.
                *
                * The two box numbers are the ones a GSTR-3B asks for, so his
                * accountant types them in rather than working them out.
                */}
              {!!rcm && Number(rcm.entries) > 0 && (
                <Card title="GST you owe on freight and the like">
                  <Line k="Value of those supplies"
                        v={fmt(rcm.table_3_1_d?.taxable_value)} />
                  {Number(rcm.table_3_1_d?.central_tax) > 0 && (
                    <Line k="Central tax" v={fmt(rcm.table_3_1_d?.central_tax)} />
                  )}
                  {Number(rcm.table_3_1_d?.state_tax) > 0 && (
                    <Line k="State tax" v={fmt(rcm.table_3_1_d?.state_tax)} />
                  )}
                  {Number(rcm.table_3_1_d?.integrated_tax) > 0 && (
                    <Line k="Integrated tax" v={fmt(rcm.table_3_1_d?.integrated_tax)} />
                  )}
                  <Line k="To pay in cash" v={fmt(rcm.pay_in_cash)} strong />
                  {rcm.table_4_a_3?.can_claim
                    ? <Line k="You may claim back" v={fmt(rcm.table_4_a_3?.total_tax)} />
                    : <Line k="What it costs you" v={fmt(rcm.net_cost)} />}
                  <Text style={S.hint}>
                    {rcm.note}
                  </Text>
                  <Text style={[S.hint, { marginTop: 6 }]}>
                    For your accountant: this is GSTR-3B box 3.1(d)
                    {rcm.table_4_a_3?.can_claim ? ', and the same tax again in 4(A)(3).' : '.'}
                    {' '}From {Number(rcm.purchase_bills)} purchase bill
                    {Number(rcm.purchase_bills) === 1 ? '' : 's'} and{' '}
                    {Number(rcm.money_out)} Money out entr
                    {Number(rcm.money_out) === 1 ? 'y' : 'ies'}.
                  </Text>
                </Card>
              )}

              {/* THE 3B BOXES, FOR HIM TO READ OUT TO HIS ACCOUNTANT.
                *
                * Only the boxes a billing book can honestly answer. The two
                * it cannot — credit reversed, and tax paid — are named rather
                * than filled with a zero, because a zero in those reads like
                * a fact and is not one.
                */}
                </>
              )}

            </>
          )}
        </ScrollView>
      )}
      </Swipe>
    </Screen>
  );
}
