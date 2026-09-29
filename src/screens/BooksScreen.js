import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { useApp } from '../AppContext';
import { fmt0, n2, num, qty as qtyText, today } from '../lib/money';
import { ColHead, Figure, Rule, Words } from '../components/Register';
import { Head, Screen, Sections, Swipe, useChainSwipe, useSectionSwipe } from '../components/Chrome';
import { CalButton } from '../components/DatePick';
import { C, S } from '../theme';

// THE BOOKS.
//
// Up to now Skwik could tell a shopkeeper what he had sold and who owed him,
// which is a billing app. A book of account answers three more questions, and
// they are the ones his accountant asks in April:
//
//   THE CASH BOOK     every rupee in and out of the cash box, in date order,
//                     with the balance after each line — the figure he checks
//                     against what is actually in the drawer tonight
//   THE BANK BOOK     the same, per account, so it reconciles against one
//                     bank statement rather than against three mixed together
//   THE BALANCE SHEET what he has, what he owes, and the difference
//
// The balance sheet is worked out from what is already in the books rather
// than from a chart of accounts he would have to keep. That makes it honest
// arithmetic, not a filing: a shop with a loan, a shop van or money drawn for
// the house has to account for those himself, and the note at the foot says
// so plainly rather than letting him believe a figure that is not the whole
// picture.

const firstOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
const dmy = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}` : '');

const RANGES = [
  { k: 'month',  label: 'This month' },
  { k: 'last',   label: 'Last month' },
  { k: 'fy',     label: 'This year' },
  { k: 'custom', label: 'Pick dates' },
];

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

function rangeOf(k, from, to) {
  if (k === 'custom') {
    return [isDate(from) ? from : firstOf(new Date()),
            isDate(to)   ? to   : today()];
  }
  const now = new Date();
  if (k === 'last') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0);
    return [firstOf(s), today(e)];
  }
  if (k === 'fy') {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return [`${y}-04-01`, today()];
  }
  return [firstOf(now), today()];
}

const rupee = (x) => `${num(x) < 0 ? '−' : ''}${fmt0(Math.abs(num(x)))}`;

export default function BooksScreen({ navigation, route }) {
  const { org, isOwner } = useApp();
  // Opened from Ledgers, which says WHICH book he asked for. On its own it
  // still opens on the cash book, which is the one most shops want.
  const [tab, setTab]     = useState(
    ['cash', 'bank', 'sheet'].includes(route?.params?.book) ? route.params.book : 'cash');
  const [range, setRange] = useState('month');
  // his own two dates, when none of the three ready-made periods is the one
  // he wants — a week, a quarter, the days since he last showed his accountant
  const [from, setFrom] = useState(firstOf(new Date()));
  const [to, setTo]     = useState(today());
  // newest first is how a shopkeeper reads a book; oldest first is how an
  // accountant checks one. Both, on a tap.
  const [newest, setNewest] = useState(true);
  const section = useSectionSwipe(navigation, org, isOwner, 'books');
  const swipe = useChainSwipe(['cash', 'bank', 'sheet'], tab, setTab, section);
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount]   = useState(null); // which bank account
  const [book, setBook]   = useState(null);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy]   = useState(true);
  // A book that could not be fetched is never drawn as an empty one: "no
  // movement" is an answer a shopkeeper acts on.
  const [failed, setFailed] = useState('');

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      const { data } = await supabase.from('bank_accounts')
        .select('*').eq('is_active', true).order('name');
      if (!on) return;
      const list = data || [];
      setAccounts(list);
      setAccount((a) => a || list.find((x) => x.is_default)?.id || list[0]?.id || null);
    })();
    return () => { on = false; };
  }, []));

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      setBusy(true);
      try {
        if (tab === 'sheet') {
          const { data, error } = await supabase.rpc('balance_sheet', { p_on: today() });
          if (!on) return;
          if (error) throw error;
          setSheet(data); setFailed('');
        } else {
          const [f, t] = rangeOf(range, from, to);
          const { data, error } = await supabase.rpc('money_book', {
            p_from: f, p_to: t,
            p_account: tab === 'bank' ? account : null,
            p_cash: tab === 'cash',
            // A YEAR OF A BUSY SHOP IS NOT A SCREEN.
            //
            // The cash book used to come back whole: a year of a shop doing
            // 40,000 bills was 1.7 MB in one answer, and two and a half years
            // was 4.3 MB — a long wait on mobile data and enough to bring a
            // cheap phone down. The database now hands back the most recent
            // movements and folds everything before them into the opening
            // figure, so the running balance is still exactly right.
            p_limit: 400,
          });
          if (!on) return;
          if (error) throw error;
          setBook(data || { opening: 0, rows: [] }); setFailed('');
        }
      } catch (e) {
        if (on) { setFailed(sayPlainly(e)); setBook(null); setSheet(null); }
      } finally { if (on) setBusy(false); }
    })();
    return () => { on = false; };
  }, [tab, range, account, from, to]));

  // running balance, so every line carries the figure that stood after it
  // OPENING MEANS OPENING.
  //
  // The database hands back two figures, because they are two different things
  // and printing one under the other's name is what made him think his books
  // were wrong. `opening` is the balance on the day the period began -- his
  // figure. `brought` is that plus whatever was folded away to keep a year of
  // movements off a mobile line, and it is where the first visible line starts
  // from. On his cash book for the year those were 2,00,000 and 35,20,075.
  const { rows, opening, brought, folded, inTotal, outTotal, closing } = useMemo(() => {
    const raw = book?.rows || [];
    // an older database hands back only `opening`, and it meant `brought`
    const bf = book?.brought != null ? num(book.brought) : num(book?.opening);
    const op = book?.opening != null ? num(book.opening) : bf;
    let bal = bf;
    let gi = 0, go = 0;
    const out = raw.map((r) => {
      const i = num(r.in), o = num(r.out);
      bal = n2(bal + i - o); gi += i; go += o;
      return { ...r, balance: bal };
    });
    // worked out oldest-first because a balance can be worked out no other
    // way, then turned over so today's entries are at the top
    return { rows: newest ? out.reverse() : out,
             opening: op, brought: bf, folded: Number(book?.folded || 0),
             inTotal: n2(gi), outTotal: n2(go), closing: bal };
  }, [book, newest]);

  // BROUGHT FORWARD, THE WAY A LEDGER PAGE HAS ALWAYS DONE IT.
  //
  // The visible lines start part way through the period, so the balance the
  // first one starts from is not the opening -- it is the opening plus every
  // entry folded away. Printing that under the word OPENING is what made him
  // think his books were wrong, and it only came right when he narrowed the
  // window enough that nothing had to be folded.
  const bfLine = folded > 0 ? (
    <Rule>
      <Figure width={38} size={11} weight="400" tone={C.muted}> </Figure>
      <Words name={`${fmt0(folded)} earlier entr${folded === 1 ? 'y' : 'ies'} not shown`}
             sub={`brought forward ₹${rupee(brought)}`} />
      <Figure width={62} size={13} tone={C.faint}>—</Figure>
      <Figure width={62} size={13} tone={C.faint}>—</Figure>
    </Rule>
  ) : null;

  const Tab = ({ v, label }) => {
    const on = tab === v;
    return (
      <TouchableOpacity onPress={() => setTab(v)}
        style={{ flex: 1, paddingVertical: 10, alignItems: 'center',
                 borderBottomWidth: 2.5, borderBottomColor: on ? C.accent : 'transparent' }}>
        <Text style={{ fontSize: 13.5, fontWeight: '700', color: on ? C.accent : C.muted }}>
          {label}
        </Text>
      </TouchableOpacity>
    );
  };

  const Chip = ({ on, label, onPress }) => (
    <TouchableOpacity onPress={onPress}
      style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, borderWidth: 1,
               borderColor: on ? C.accent : C.line,
               backgroundColor: on ? C.accentSoft : C.surface }}>
      <Text style={{ fontSize: 12.5, fontWeight: '700', color: on ? C.accent : C.muted }}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  const SheetRow = ({ label, amount, strong, tone, indent }) => (
    <View style={[S.row, { paddingVertical: strong ? 9 : 7, paddingHorizontal: 14,
                           paddingLeft: 14 + (indent || 0),
                           borderBottomWidth: strong ? 1.5 : 1,
                           borderBottomColor: strong ? C.ink : '#EDE9E0' }]}>
      <Text style={{ flex: 1, fontSize: strong ? 14 : 13.5,
                     fontWeight: strong ? '700' : '600',
                     color: tone || (strong ? C.ink : C.muted) }}>{label}</Text>
      <Text style={[S.num, { fontSize: strong ? 16 : 14, fontWeight: strong ? '700' : '600',
                             color: tone || C.ink }]}>₹{rupee(amount)}</Text>
    </View>
  );

  // WHAT THE SHELF FIGURE LEAVES OUT, SAID ON THE SHEET ITSELF.
  //
  // An item with no purchase price on it used to be valued here at what he
  // SELLS it for. That put profit he has not earned yet into what he owns: a
  // shelf of glasses bought for ₹18 and priced at ₹25 was carried at 25,
  // and his capital was the shop's takings for a year it has not had. It is
  // now counted at nothing, which is the truer of the two answers, because a
  // cost nobody has entered is a cost nobody knows.
  //
  // But a figure that is short and silent about being short is its own kind of
  // wrong. ₹4,20,000 of stock and ₹4,20,000 of stock plus sixty uncosted items
  // read exactly the same on this sheet, and he would take the sum to his
  // accountant either way. So the sheet says how many are missing from the
  // figure and how much of them, and the line is the door to the screen where
  // the price is entered rather than an apology he can do nothing about.
  const unpricedNote = num(sheet?.stock_unpriced)
    ? `${fmt0(sheet.stock_unpriced)} item${num(sheet.stock_unpriced) === 1 ? '' : 's'} on the shelf `
      + (num(sheet?.stock_unpriced_qty) ? `(${qtyText(sheet.stock_unpriced_qty)} in all) ` : '')
      + 'have no cost price on them, so they count as nothing above. '
    : '';

  return (
    <Screen>
      <Head navigation={navigation} title="The books" />
      <Sections navigation={navigation} org={org} isOwner={isOwner} id="books" />

      <View style={{ flexDirection: 'row', backgroundColor: C.surface,
                     borderBottomWidth: 1, borderBottomColor: C.line }}>
        <Tab v="cash"  label="Cash book" />
        <Tab v="bank"  label="Bank book" />
        <Tab v="sheet" label="Balance sheet" />
      </View>

      {tab !== 'sheet' && (
        <View style={{ backgroundColor: C.soft, paddingHorizontal: 12, paddingVertical: 8,
                       borderBottomWidth: 1, borderBottomColor: C.line, gap: 8 }}>
          <View style={[S.row, { gap: 6, flexWrap: 'wrap' }]}>
            {RANGES.map((g) => (
              <Chip key={g.k} on={range === g.k} label={g.label}
                    onPress={() => setRange(g.k)} />
            ))}
            <View style={{ flex: 1 }} />
            <Chip on={false} label={newest ? 'Newest first ↓' : 'Oldest first ↑'}
                  onPress={() => setNewest(!newest)} />
          </View>

          {range === 'custom' && (
            <View style={[S.row, { gap: 8, alignItems: 'center' }]}>
              <TextInput style={[S.cell, S.num, { flex: 1 }]} placeholder="2026-04-01"
                placeholderTextColor={C.faint} keyboardType="numbers-and-punctuation"
                value={from} onChangeText={setFrom} />
              <CalButton value={from} onPick={setFrom} size={40} max={to || today()}
                title="From which day?" />
              <Text style={{ fontSize: 13, color: C.muted }}>to</Text>
              <TextInput style={[S.cell, S.num, { flex: 1 }]} placeholder={today()}
                placeholderTextColor={C.faint} keyboardType="numbers-and-punctuation"
                value={to} onChangeText={setTo} />
              <CalButton value={to} onPick={setTo} size={40} min={from || undefined}
                title="Up to which day?" />
            </View>
          )}
          {tab === 'bank' && (
            accounts.length ? (
              <View style={[S.row, { gap: 6, flexWrap: 'wrap' }]}>
                {accounts.map((a) => (
                  <Chip key={a.id} on={account === a.id} label={a.name}
                        onPress={() => setAccount(a.id)} />
                ))}
              </View>
            ) : (
              <TouchableOpacity onPress={() => navigation.navigate('Banks')}>
                <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.accent }}>
                  No bank accounts set up yet — add one ›
                </Text>
              </TouchableOpacity>
            )
          )}
        </View>
      )}

      {/* Swiping sideways moves between Cash book, Bank book and Balance
          sheet, the way a thumb already expects it to. */}
      <Swipe {...swipe}>
      {busy ? (
        <View style={{ paddingTop: 40 }}><ActivityIndicator color={C.accent} /></View>
      ) : failed ? (
        <View style={{ padding: 20 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: C.danger }}>
            Could not read the books
          </Text>
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 6, lineHeight: 19 }}>{failed}</Text>
        </View>
      ) : tab === 'sheet' ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          <Text style={[S.eyebrow, { paddingHorizontal: 14, paddingTop: 16 }]}>
            What the shop has
          </Text>
          <SheetRow label="Cash in hand" amount={sheet?.cash} />
          {(sheet?.banks || []).map((b) => (
            <SheetRow key={b.id} label={b.name} amount={b.amount} indent={0} />
          ))}
          {!(sheet?.banks || []).length && <SheetRow label="In the bank" amount={sheet?.bank} />}
          <SheetRow label="Owed by customers" amount={sheet?.debtors} />
          <SheetRow label="Goods on the shelf (at cost)" amount={sheet?.stock} />
          {!!unpricedNote && (
            <TouchableOpacity onPress={() => navigation.navigate('Items')}
              style={{ paddingHorizontal: 14, paddingTop: 7, paddingBottom: 9 }}>
              <Text style={{ fontSize: 12, color: C.muted, lineHeight: 17 }}>
                {unpricedNote}
                <Text style={{ fontWeight: '700', color: C.accent }}>
                  {'Put a purchase price on them under Items \u203A'}
                </Text>
              </Text>
            </TouchableOpacity>
          )}
          {/* GST ALREADY IN HAND. It has been worked out on this sheet all
              along and never shown; a credit balance is money the government
              owes him and belongs among what he has. */}
          {!!num(sheet?.gst_credit) && (
            <SheetRow label="GST credit in hand" amount={sheet?.gst_credit} />
          )}
          {/* WHAT HE OWNS THAT NO BILL WILL EVER MENTION. */}
          {(sheet?.standing || []).filter((x) => x.kind === 'owns').map((x) => (
            <SheetRow key={x.id} label={x.name} amount={x.amount} />
          ))}
          <SheetRow label="Total" amount={sheet?.assets} strong />

          <Text style={[S.eyebrow, { paddingHorizontal: 14, paddingTop: 22 }]}>
            What the shop owes
          </Text>
          <SheetRow label="Owed to suppliers" amount={sheet?.creditors} tone={C.danger} />
          {!!num(sheet?.gst_payable) && (
            <SheetRow label="GST to pay" amount={sheet?.gst_payable} tone={C.danger} />
          )}
          {(sheet?.standing || []).filter((x) => x.kind === 'owes').map((x) => (
            <SheetRow key={x.id} label={x.name} amount={x.amount} tone={C.danger} />
          ))}
          {(!!num(sheet?.creditors) || !!num(sheet?.gst_payable) || !!num(sheet?.loans)) && (
            <SheetRow label="Total" amount={sheet?.liabilities} strong tone={C.danger} />
          )}

          <Text style={[S.eyebrow, { paddingHorizontal: 14, paddingTop: 22 }]}>
            What is left — your own money in the business
          </Text>
          <SheetRow label="Capital" amount={sheet?.capital} strong />

          {/* THE PARAGRAPH THAT USED TO APOLOGISE IS NOW A DOOR.
              It said a loan and a vehicle were missing and left him to finish
              the sum on paper. He can put them in. */}
          <TouchableOpacity onPress={() => navigation.navigate('Standing')}
            style={{ margin: 14, marginTop: 22, padding: 13, borderRadius: 12,
                     backgroundColor: C.surface, borderWidth: 1, borderColor: C.line }}>
            <Text style={{ fontSize: 14.5, fontWeight: '700', color: C.accent }}>
              {(sheet?.standing || []).length
                ? `What you own and owe outside the books \u00B7 ${(sheet?.standing || []).length}`
                : 'Add a loan, the shop, a vehicle \u203A'}
            </Text>
            <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 18 }}>
              A loan, the shop, a vehicle, machinery — nothing in your bills or
              receipts can find these, so they are entered once and kept current.
              With them in, the figure above is your net worth and not a piece of it.
            </Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          <View style={[S.card, { margin: 14, padding: 14 }]}>
            <View style={[S.row, { gap: 10 }]}>
              <Cell label="OPENING" value={opening} />
              <Cell label="IN" value={inTotal} tone={C.ok} />
              <Cell label="OUT" value={outTotal} tone={C.danger} />
            </View>
            <View style={{ height: 1, backgroundColor: C.line, marginVertical: 12 }} />
            <View style={[S.row, { justifyContent: 'space-between', alignItems: 'flex-end' }]}>
              <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.muted }}>CLOSING</Text>
              <Text style={[S.num, { fontSize: 24, fontWeight: '800',
                                     color: closing < 0 ? C.danger : C.ink }]}>
                ₹{rupee(closing)}
              </Text>
            </View>
            {closing < 0 && (
              <Text style={{ fontSize: 11.5, color: C.danger, marginTop: 5, lineHeight: 16 }}>
                Below zero — more has gone out than ever came in. Usually an
                opening figure that was never entered. Put it in under Settings.
              </Text>
            )}
          </View>

          <ColHead cols={[{ label: 'DATE', width: 38 },
                          { label: 'PARTICULARS' },
                          { label: 'IN', width: 62 },
                          { label: 'OUT', width: 62 }]} />

          {!newest && bfLine}

          {rows.map((r, i) => (
            <Rule key={r.id} last={i === rows.length - 1}>
              <Figure width={38} size={11} weight="400" tone={C.muted}>{dmy(r.d)}</Figure>
              <Words name={r.who} sub={[r.what, r.note].filter(Boolean).join(' · ')} />
              <Figure width={62} size={13} tone={num(r.in) ? C.ok : C.faint}>
                {num(r.in) ? rupee(r.in) : '—'}
              </Figure>
              <Figure width={62} size={13} tone={num(r.out) ? C.danger : C.faint}>
                {num(r.out) ? rupee(r.out) : '—'}
              </Figure>
            </Rule>
          ))}

          {!!book?.more && (
            <Text style={{ fontSize: 12.5, color: C.muted, textAlign: 'center',
                           marginTop: 16, paddingHorizontal: 24, lineHeight: 19 }}>
              Showing the last {book.shown} of {book.total} movements in this period.
              Choose a shorter period to see them all.
            </Text>
          )}

          {newest && bfLine}

          {!rows.length && (
            <Text style={{ fontSize: 13.5, color: C.muted, textAlign: 'center',
                           marginTop: 26, paddingHorizontal: 30, lineHeight: 20 }}>
              Nothing moved through {tab === 'cash' ? 'the cash box' : 'this account'} in
              this period. The opening figure above is what it started with.
            </Text>
          )}
        </ScrollView>
      )}
      </Swipe>
    </Screen>
  );
}

const Cell = ({ label, value, tone }) => (
  <View style={{ flex: 1 }}>
    <Text style={{ fontSize: 10.5, letterSpacing: 0.8, color: C.muted, fontWeight: '700' }}>
      {label}
    </Text>
    <Text style={[S.num, { fontSize: 16, fontWeight: '800', marginTop: 2, color: tone || C.ink }]}>
      ₹{rupee(value)}
    </Text>
  </View>
);
