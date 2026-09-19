import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt, fmt0, n2 } from '../lib/money';
import { buildGstr1 } from '../lib/gstr1';
import { Bar, Foot, MoreButton, BackButton } from '../components/Chrome';
import { C, S } from '../theme';

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

function rangeOf(k) {
  const now = new Date();
  if (k === 'month') return [firstOf(now), null, 'this month'];
  if (k === 'last') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0);
    return [firstOf(s), e.toISOString().slice(0, 10), 'last month'];
  }
  if (k === 'fy') {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return [`${y}-04-01`, null, `${y}-${String(y + 1).slice(2)}`];
  }
  return [null, null, 'everything'];
}

const dmy = (d) => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}`;

export default function ReportsScreen({ navigation }) {
  const { org } = useApp();
  const [range, setRange] = useState('month');
  const [busy, setBusy]   = useState(true);
  const [vouchers, setVouchers] = useState([]);
  const [lines, setLines] = useState([]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [from, to] = rangeOf(range);
      let q = supabase.from('vouchers')
        .select('*, parties(name, gstin, state_name)').order('vdate');
      if (from) q = q.gte('vdate', from);
      if (to)   q = q.lte('vdate', to);
      const { data: vs, error } = await q;
      if (error) throw error;
      setVouchers(vs || []);

      if (vs?.length) {
        const ids = vs.map((v) => v.id);
        const all = [];
        for (let i = 0; i < ids.length; i += 200) {
          const { data } = await supabase.from('voucher_lines')
            .select('*').in('voucher_id', ids.slice(i, i + 200));
          all.push(...(data || []));
        }
        setLines(all);
      } else setLines([]);
    } catch (e) {
      Alert.alert('Could not load', e.message || String(e));
    } finally { setBusy(false); }
  }, [range]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  /* ---------------- the sums ---------------- */

  const sums = useMemo(() => {
    const blank = () => ({ n: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });
    const add = (acc, v) => {
      acc.n += 1;
      acc.taxable = n2(acc.taxable + Number(v.taxable || 0));
      acc.cgst    = n2(acc.cgst + Number(v.cgst || 0));
      acc.sgst    = n2(acc.sgst + Number(v.sgst || 0));
      acc.igst    = n2(acc.igst + Number(v.igst || 0));
      acc.total   = n2(acc.total + Number(v.total || 0));
      return acc;
    };

    const sales = blank(), purchases = blank(), estimates = blank();
    const byDay = {};
    for (const v of vouchers) {
      if (v.vtype === 'sale')      { add(sales, v);
                                     byDay[v.vdate] = n2((byDay[v.vdate] || 0) + Number(v.total || 0)); }
      else if (v.vtype === 'purchase') add(purchases, v);
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

    return {
      sales, purchases, estimates,
      rates: Object.values(byRate).sort((a, b) => a.rate - b.rate),
      b2bTaxable, b2cTaxable,
      days: Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 31),
      items: Object.values(byItem).sort((a, b) => b.value - a.value).slice(0, 15),
      gstOwed: n2(sales.cgst + sales.sgst + sales.igst),
      itc: n2(purchases.cgst + purchases.sgst + purchases.igst),
    };
  }, [vouchers, lines]);

  const label = rangeOf(range)[2];

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
      const to   = new Date(y, m, 0).toISOString().slice(0, 10);

      const { data: vs, error } = await supabase.from('vouchers')
        .select('*, parties(name, gstin, state_code, state_name)')
        .gte('vdate', from).lte('vdate', to);
      if (error) throw error;

      const byV = {};
      if (vs?.length) {
        const ids = vs.map((v) => v.id);
        for (let i = 0; i < ids.length; i += 200) {
          const { data } = await supabase.from('voucher_lines')
            .select('*').in('voucher_id', ids.slice(i, i + 200));
          (data || []).forEach((l) => { (byV[l.voucher_id] = byV[l.voucher_id] || []).push(l); });
        }
      }

      const r = buildGstr1({ org, vouchers: vs || [], linesByVoucher: byV, year: y, month: m });

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
      Alert.alert('Could not build it', e.message || String(e));
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
      Alert.alert('Could not send', e.message || String(e));
    }
  };

  /* ---------------- screen ---------------- */

  const Line = ({ k, v, strong, tone }) => (
    <View style={[S.tline, strong && { borderTopWidth: 1, borderTopColor: C.line,
                                       marginTop: 6, paddingTop: 8 }]}>
      <Text style={[S.tlineK, strong && { fontWeight: '700', color: C.ink },
                    tone && { color: tone }]}>{k}</Text>
      <Text style={[S.tlineV, S.num, strong && { fontWeight: '700' }, tone && { color: tone }]}>{v}</Text>
    </View>
  );

  const Card = ({ title, children }) => (
    <View style={S.card}>
      <Text style={S.eyebrow}>{title}</Text>
      {children}
    </View>
  );

  return (
    <View style={S.screen}>
      <Bar>
        <BackButton navigation={navigation} />
        <View style={{ flex: 1 }}>
          <Text style={S.barName}>Reports</Text>
          <Text style={S.barSub}>{label}</Text>
        </View>
        <TouchableOpacity onPress={share} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff', opacity: 0.9 }}>SEND</Text>
        </TouchableOpacity>
        <MoreButton navigation={navigation} />
      </Bar>

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

      {busy ? (
        <View style={{ paddingTop: 60, alignItems: 'center' }}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>

          {!vouchers.length && (
            <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center',
                           marginTop: 40, lineHeight: 20 }}>
              Nothing in {label}.
            </Text>
          )}

          {!!vouchers.length && (
            <>
              <Card title={`Sales — ${label}`}>
                <Line k={`${sums.sales.n} bill${sums.sales.n === 1 ? '' : 's'}`} v="" />
                <Line k="Goods" v={fmt(sums.sales.taxable)} />
                {!!sums.sales.cgst && <Line k="CGST" v={fmt(sums.sales.cgst)} />}
                {!!sums.sales.sgst && <Line k="SGST" v={fmt(sums.sales.sgst)} />}
                {!!sums.sales.igst && <Line k="IGST" v={fmt(sums.sales.igst)} />}
                <Line k="Total" v={`₹${fmt0(sums.sales.total)}`} strong />
              </Card>

              {!!sums.estimates.n && (
                <Card title="Estimates">
                  <Line k={`${sums.estimates.n} estimate${sums.estimates.n === 1 ? '' : 's'}`}
                        v={`₹${fmt0(sums.estimates.total)}`} />
                </Card>
              )}

              {!!sums.purchases.n && (
                <Card title="Purchases">
                  <Line k={`${sums.purchases.n} bill${sums.purchases.n === 1 ? '' : 's'}`} v="" />
                  <Line k="Goods" v={fmt(sums.purchases.taxable)} />
                  <Line k="Total" v={`₹${fmt0(sums.purchases.total)}`} strong />
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

              {!!sums.items.length && (
                <Card title="What sold">
                  {sums.items.map((i) => (
                    <View key={i.name} style={[S.row, { marginBottom: 6 }]}>
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: C.ink }}>
                        {i.name}
                      </Text>
                      <Text style={[{ fontSize: 12.5, color: C.muted, marginRight: 10 }, S.num]}>
                        {i.qty}
                      </Text>
                      <Text style={[{ fontSize: 14, fontWeight: '700', color: C.ink }, S.num]}>
                        {fmt0(i.value)}
                      </Text>
                    </View>
                  ))}
                </Card>
              )}

              {!!sums.days.length && (
                <Card title="Day by day">
                  {sums.days.map(([d, total]) => (
                    <View key={d} style={[S.row, { marginBottom: 5 }]}>
                      <Text style={{ flex: 1, fontSize: 13.5, color: C.muted }}>{dmy(d)}</Text>
                      <Text style={[{ fontSize: 14, fontWeight: '600', color: C.ink }, S.num]}>
                        {fmt0(total)}
                      </Text>
                    </View>
                  ))}
                </Card>
              )}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}
