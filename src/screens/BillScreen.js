import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Alert, Modal, Platform, BackHandler,
  Keyboard,
  Linking,
} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as IntentLauncher from 'expo-intent-launcher';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';

import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import {
  compositionCannotSupply,
  computeBill, fmt, fmt0, hsnApplies, num, pct, placeOfSupply, purchaseTaxMode,
  parseDate, qty, rateIsGuessed, rcmTaxMode, saleRate, settle, showDate, taxIsCost,
  taxModeFor, today, topRate,
  SUPPLY_KINDS, supplyOf, supplyShort,
} from '../lib/money';
import { folderName, pdfName, renamed, saveToDownloads, sharePdf } from '../lib/pdf';
import { STATES } from '../lib/states';
import { showBatch, showExpiry, showGodowns, showRcmIn, showRcmOut, showStock, showThumbRail } from '../lib/features';
import { searchItems, parseQuery, highlightParts, tok, itemsWithCode } from '../lib/search';
import { uqcShort } from '../lib/uqc';
import { checkHsn } from '../lib/hsn';
import { HsnField, UomField, StateField } from '../components/Pickers';
import { invoiceHtml } from '../lib/invoice';
import { thermalHtml } from '../lib/receipt';
import {
  uuid, withTimeout, looksOffline, cacheItems, cacheParties,
  cachedItems, cachedParties, takeLocalNumber, queueAdd, flushQueue, sayPlainly,
} from '../lib/offline';
import {
  BackButton, Bar, Box, Foot, goHome, KeyForm, Screen, TopSheet, useKeyboardGap, NumCell }
  from '../components/Chrome';
import { ScanSheet, ScanButton } from '../components/Scan';
import { ColHead } from '../components/Register';
import { CalButton, Calendar } from '../components/DatePick';
import ThumbRail from '../components/ThumbRail';
import { C, S } from '../theme';

// Matched letters shown marked, the way the estimate app does it.
// HIS ITEM NAMES ARE LONG, AND THE SIZE IS AT THE END OF THEM.
// "STAINLESS STEEL THALI TEN INCH HEAVY GAUGE" cut to one line on a phone
// leaves two different sizes of the same thali looking like the same match,
// so a search result is allowed a second line rather than an ellipsis.
const Marked = ({ text, toks, style }) => (
  <Text style={style} numberOfLines={2}>
    {highlightParts(text, toks).map((p, i) => (
      <Text key={i} style={p.hit ? { backgroundColor: C.greenL, color: C.greenD } : null}>
        {p.text}
      </Text>
    ))}
  </Text>
);

// THE DAY AFTER, IN HIS OWN TIME, NOT IN UTC.
// toISOString would hand back yesterday's date for the whole of the Indian
// morning, which is the bug the check in tools/check.mjs exists to catch.
const dayAfter = (iso) => {
  if (!iso) return undefined;
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return today(d);
};

export default function BillScreen({ route, navigation }) {
  const vtypeParam = route.params?.vtype || 'sale';
  const editId = route.params?.voucherId || null;    // set when opening a saved bill
  const { org } = useApp();
  const insets = useSafeAreaInsets();
  const keyGap = useKeyboardGap();      // > 0 while the keyboard is up
  const estimateMode = org?.mode === 'estimate';
  // A saved bill keeps the kind it was saved as, whatever the screen was opened with.
  const [loadedType, setLoadedType] = useState(null);
  const [loadedNo, setLoadedNo] = useState('');     // the number a bill already has
  const vtype  = loadedType
    || (vtypeParam === 'sale' && estimateMode ? 'estimate' : vtypeParam);
  const isOut  = vtype === 'sale' || vtype === 'estimate';     // going out of the shop
  const isBuy  = vtype === 'purchase';

  const [items, setItems]     = useState([]);
  const [parties, setParties] = useState([]);

  // STRAIGHT ONTO THE GOODS.
  //
  // Every new bill used to open on a full page asking who it was for, and
  // nothing else could be done until that was answered. But the counter is
  // usually already reading out items while the customer is still deciding
  // what he wants, and on a cash sale there is no name at all. The name is a
  // bar at the top of the bill now — tap it whenever you like, and the bill
  // will not save without it, which is the only moment it is actually needed.
  // A NEW BILL OPENS ON THE NAME, WITH THE KEYPAD UP.
  //
  // "When I click on Sale, or Purchase, direct a page opens ... where cursor is
  // on bar, that types customer in case of sale, and supplier in case of
  // purchase, and keypad opens automatically, this way we save around 2-3 taps,
  // and that's being fast."
  //
  // It used to take three taps to type a letter: the page showed "Choose a
  // customer" waiting to be tapped, tapping it opened a SHEET, and the sheet
  // put the cursor in its box and left the keyboard down -- because a field
  // focused inside a modal is focused before the modal has finished appearing,
  // and the keypad never gets the message.
  //
  // The sheet was the mistake, not the missing keypad. The box belongs on the
  // page, with the names listed under it, exactly as his own app does it -- and
  // then it FOLDS AWAY into the title bar the moment a name is picked, so the
  // goods get the whole screen. Tapping the name there brings it back.
  // The sheet is only for CHANGING a name that is already on the bill. A bill
  // with no name on it yet shows the box on the PAGE -- see custPicker below.
  const [custOpen, setCustOpen] = useState(false);
  const custRef = useRef(null);        // the box on the page
  const custSheetRef = useRef(null);   // the same box inside the sheet
  const [cq, setCq]       = useState('');
  const [cust, setCust]   = useState(null);          // {id?, name, phone, state_code…}
  const [isCash, setIsCash] = useState(false);
  const [rcharge, setRcharge] = useState(false);
  // WHERE THE TRANSPORTER IS, IN HIS OWN WORDS.
  //
  // null means "work it out from the party", which is what every bill did
  // before this existed. 'cgst_sgst' or 'igst' is his own answer, and it wins.
  // The reasoning is written out beside rcmTaxMode in money.js.
  const [rcmHead, setRcmHead] = useState(null);
  const [less, setLess] = useState('');        // one discount, on the whole bill

  const [q, setQ]         = useState('');
  const [lines, setLines] = useState([]);            // newest FIRST
  const [swapFor, setSwapFor] = useState(null);
  const [sq, setSq]       = useState('');
  // A WALK-IN IS BILLED ON WHATEVER THE SHOP SAID IN SETTINGS.
  // A firm row that has not been told yet — an app ahead of its database —
  // reads as list 1, which is what every shop did before this existed.
  const walkInList = Number(org?.walkin_price_list) === 2 ? 2 : 1;
  const [priceList, setPriceList] = useState(walkInList);
  const [extra, setExtra] = useState('');
  const [extraNote, setExtraNote] = useState('');
  const [showExtra, setShowExtra] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [pendingCode, setPendingCode] = useState('');   // a code waiting for an item
  const [partySheet, setPartySheet] = useState(null);   // the sheet for a name not in the book
  const [godowns, setGodowns] = useState([]);
  const [godown, setGodown] = useState(null);           // which store the goods move through
  // WHAT IS ON THE SHELF, ASKED FOR ONCE AND KEPT.
  //
  // The batches a line can be sold from are read from the server, and this
  // screen re-draws on every keystroke of every quantity box. Asking each
  // time would put a request on the wire for every letter he types, on a
  // cheap phone on a mobile pack. It is asked when he opens the list for a
  // line, and the answer is held for that item and that store.
  const [inStock, setInStock] = useState({});   // item+godown -> the batches there

  // WHAT IS ON THE SHELF, WHILE HE IS STILL LOOKING FOR THE ITEM.
  //
  // He said it plainly: the rate on the search list is worth nothing, because
  // the moment he picks the item the rate lands in the line in front of him.
  // What he cannot see anywhere, at the one moment he needs it — a customer
  // asking for forty and him about to promise them — is how many there are.
  //
  // `null` means NOT KNOWN YET, and is not the same as nought. Until the
  // figures land, or on a shop that keeps no stock, the list shows the rate as
  // it always did. Showing "0 in hand" because a read had not come back would
  // be worse than showing nothing.
  const [stock, setStock] = useState(null);   // { all: {id:qty}, at: {godown: {id:qty}} }
  const [pickFor, setPickFor] = useState(null); // the line whose batch list is open
  const asking = useRef({});                    // one request per item, not one per tap
  const [extraGst, setExtraGst] = useState('');    // '' = the dearest rate on the bill
  const [supNo, setSupNo] = useState('');
  // whether the purchase's header is open. A bill being re-opened starts
  // folded: it was filled in the day it was written.
  const [headOpen, setHeadOpen] = useState(true);
  // What he TYPED, and what Skwik made of it, kept apart so a half-written
  // date is never handed to the database as a whole one.
  const [supDateText, setSupDateText] = useState(showDate(today()));
  const [supCal, setSupCal] = useState(false);
  const supDate = parseDate(supDateText);
  const [vdate, setVdate] = useState(today());
  // WHICH DAYS THIS BILL MAY CARRY.
  //
  // A bill number is always the next one in the series, so a bill dated
  // before the one numbered below it leaves the book with numbers running
  // backwards against dates. The server works out the window and says why;
  // the calendar then simply has no wrong day on it, so there is no warning
  // to read and no mistake to make. Null means Skwik could not ask -- no
  // signal, most likely -- and then the date is today, as it always was.
  const [win, setWin] = useState(null);
  const [dateCal, setDateCal] = useState(false);
  const [loadingBill, setLoadingBill] = useState(!!route.params?.voucherId);

  // HAS ANYTHING ACTUALLY CHANGED?
  //
  // "Leave this bill? 3 lines will be lost" used to fire on HAVING lines, not
  // on having changed any of them — so opening an old bill to look at it and
  // stepping back always accused him of losing work that was saved weeks ago.
  // A man who is told that every time stops reading it, and then it is no
  // warning at all on the day it matters.
  //
  // This is a fingerprint of everything he can edit. It is taken when the
  // bill finishes loading (or empty, for a new one) and compared on the way
  // out: identical, no question asked.
  const fingerprint = () => JSON.stringify({
    c: cust?.id || cust?.name || '', k: !!isCash, g: godown || '',
    d: String(less || ''), x: String(extra || ''), xg: String(extraGst || ''),
    xn: String(extraNote || ''), r: !!rcharge, rh: rcmHead || '',
    sn: String(supNo || ''), sd: String(supDateText || ''), v: String(vdate || ''),
    l: (lines || []).map((l) => [l.item_id || l.name || '', String(l.qty), String(l.rate),
                                 String(l.disc || ''), l.batch || '', l.godown_id || '']),
  });
  const asOpened = useRef(null);
  const markSaved = () => { asOpened.current = fingerprint(); };
  const changedSince = () => asOpened.current !== null && asOpened.current !== fingerprint();
  // read through a ref, so the copy taken when the bill lands is the newest
  // one and not the closure from the render that started the load
  const markSavedRef = useRef(markSaved);
  markSavedRef.current = markSaved;

  // WHEN THE FINGERPRINT IS TAKEN, AND WHY IT WAS ALWAYS WRONG.
  //
  // He opened an old bill, touched nothing, pressed back, and was asked
  // whether to throw his changes away. Every time.
  //
  // The fingerprint was taken on a setTimeout of zero, on the reasoning that
  // it would land "after the lines". It does not. A zero timer only waits for
  // the current block to finish; React has not applied any of the setters by
  // then, so what got fingerprinted was an EMPTY NEW BILL — no customer, no
  // godown, today's date, no lines — and comparing that against the bill he
  // was actually looking at of course came out different. Measured, on his own
  // build and on mine:
  //
  //     at load:  c:""            g:""     v:"2026-09-26"  l:[]
  //     on leave: c:"Ganesh Store" g:"g1"  v:"2026-09-20"  l:[2 lines]
  //
  // So it is taken in an effect instead, which by definition runs AFTER the
  // screen has been drawn with the bill on it. `needMark` makes it happen once.
  const needMark = useRef(false);
  useEffect(() => {
    if (!needMark.current || loadingBill) return;
    needMark.current = false;
    markSavedRef.current();
  });

  const [busy, setBusy]   = useState(false);
  const [nudged, setNudged] = useState(false);
  const [saved, setSaved] = useState(null);
  const [quick, setQuick] = useState(null);
  const qRef = useRef(null);
  const xRef = useRef(null);                       // freight amount
  const qName = useRef(null), qAlias = useRef(null);
  const npName = useRef(null), npPhone = useRef(null), npAddr = useRef(null);
  const npArea = useRef(null), npOpen = useRef(null);
  const npGst = useRef(null), npState = useRef(null);
  const qGst  = useRef(null), qRate  = useRef(null);
  const qRate2 = useRef(null), qBuy = useRef(null), qOpen = useRef(null);
  const seq  = useRef(0);
  // ONE BILL, ONE ID, HOWEVER MANY TIMES HE PRESSES SAVE.
  //
  // A fresh uuid on every press meant that anything going wrong AFTER the
  // server had written the bill turned each retry into another bill in the
  // books. save_voucher() treats the id as the bill's identity and hands back
  // the one it already has, so holding the id steady makes a retry harmless.
  // It is cleared once a bill is safely away, so the next bill is its own.
  const billId = useRef(null);
  const priceAsQty = useRef(false);        // the "is that a price?" nudge, asked once
  // WHAT THIS BILL ALREADY TOOK OFF THE SHELF, as it stands SAVED.
  //
  // Only filled when a saved bill is opened for editing. See the stock check
  // at save time for why it has to exist.
  const wasOut = useRef({});
  // Every qty and rate box on the bill, so the keyboard's next key can
  // walk from one to the next without anybody tapping.
  const cell = useRef({});
  const focusCell = (key, which) =>
    setTimeout(() => cell.current[`${key}:${which}`]?.focus(), 60);

  // Items and customers are kept on the phone as well, so this screen opens
  // and bills can be written whether or not there is any signal.
  const [offline, setOffline] = useState(false);
  const newParty = useRef(null);     // a customer invented with no signal
  const newItems = useRef([]);       // items added mid-bill with no signal

  useEffect(() => {
    (async () => {
      // LAST TIME'S COPY GOES UP FIRST.
      //
      // This screen is opened fresh for every bill — forty times a day — and
      // it used to sit blank until eight hundred items and three hundred names
      // had come down the wire. On a throttled pack that is the best part of a
      // minute with a customer waiting, before he can type a single thing. The
      // copy on the phone is on the screen in milliseconds, and the fresh list
      // replaces it underneath him a moment later without him noticing.
      try {
        const [ci, cp] = await Promise.all([cachedItems(), cachedParties()]);
        if (ci.length) setItems(ci);
        if (cp.length) setParties(cp);
      } catch (_) { /* nothing cached yet: the first bill waits, the rest do not */ }

      try {
        // EVERY item and EVERY name, not the first thousand of each.
        // PostgREST stops at 1,000 rows without a word, so a shop with 1,200
        // items simply could not find the last 200 anywhere on this screen.
        const [i, p] = await withTimeout(Promise.all([
          allRows(() => supabase.from('items').select('*')
            .eq('is_active', true).order('name').order('id')),
          allRows(() => supabase.from('parties').select('*').order('name').order('id')),
        ]));
        setItems(i || []);
        setParties(p || []);
        setOffline(false);
        // A BILL HE IS ENTERING BECAUSE THE PORTAL SAYS IT EXISTS.
        //
        // The 2B comparison finds bills his supplier has filed that are not in
        // his books at all -- the ones that come to light at audit, months
        // later, when nobody can remember them. Tapping one lands here with
        // the supplier, the bill number and its date already in place, so all
        // he types is the goods. The number matters most: entered by hand it
        // comes out as SGS-7 against the portal's SGS/007 and the same bill is
        // a stranger again next month.
        //
        // The portal knows nothing about what was ON the bill, so the goods
        // are his to enter. Nothing is invented here.
        const seed = route.params?.from2b;
        if (seed && !editId) {
          const mine = (p || []).find((x) => x.gstin
            && String(x.gstin).toUpperCase() === String(seed.gstin || '').toUpperCase());
          if (mine) setCust(mine);
          else if (seed.party) setCust({ name: seed.party, gstin: seed.gstin || '',
                                         kind: 'supplier' });
          if (seed.docNo) setSupNo(String(seed.docNo));
          if (seed.docDate) setSupDateText(showDate(seed.docDate));
          setHeadOpen(true);
        }
        if (showGodowns(org)) {
          const gs = await allRows(() => supabase.from('godowns')
            .select('*').order('name').order('id'));
          setGodowns(gs || []);
          // A BILL BEING RE-OPENED ALREADY KNOWS ITS OWN GODOWN.
          //
          // This list comes down the wire, so it lands whenever the signal
          // allows — often AFTER a saved bill has put its own godown back on
          // the screen. Writing the shop's default over it moved the goods of
          // every re-saved bill into whichever store Skwik opens on. Whatever
          // is already chosen stands; the default is only for a blank bill.
          //
          // AND NOT ONTO AN OLD BILL THAT NEVER HAD ONE EITHER. The line below
          // said the default was only for a blank bill and then applied it to
          // any bill with nothing chosen — including a bill written before
          // this shop kept stores at all. That quietly moved its goods into a
          // godown, and it also moved the fingerprint above, which is half of
          // why he was accused of changes he had not made.
          setGodown((cur) => cur || (editId ? null
            : (org?.default_godown_id
               || (gs || []).find((g) => g.is_main)?.id || (gs || [])[0]?.id || null)));
        }
        // KEEP A COPY FOR THE DAY THE SIGNAL GOES.
        //
        // This read `i.data` and `p.data` for a while. It used to be right:
        // supabase hands back { data, error }. Then the 1,000-row fix put
        // allRows() in front of it, which hands back the rows themselves — so
        // `i.data` became undefined, and every successful load quietly wrote an
        // EMPTY cache over the real one. Offline billing looked finished and
        // worked on the day it was written; by the time the signal actually
        // dropped there was nothing left to bill with.
        cacheItems(i || []);
        cacheParties(p || []);

        // ASKED FOR SEPARATELY, AND NEVER WAITED ON.
        //
        // Billing must not get slower because of a courtesy figure, so this
        // is not part of the load above: the items and the names are already
        // on screen by the time it answers, and if it never answers the list
        // simply goes on showing the rate.
        if (org?.stock_enabled) {
          const byGodown = showGodowns(org);
          (byGodown
            ? allRows(() => supabase.from('stock_in_hand_detail')
                .select('item_id, godown_id, qty'))
            : allRows(() => supabase.from('stock_in_hand').select('item_id, qty')))
            .then((rows) => {
              const all = {}, at = {};
              // GOODS SITTING AT NO STORE AT ALL. Stock written before he
              // turned stores on, or brought in without one, has no godown on
              // it -- so it belongs to the firm's total and to no store's, and
              // it is counted here on its own rather than being quietly read as
              // "at the other store", which is a figure with nowhere to go.
              let loose = 0;
              (rows || []).forEach((r) => {
                const id = r.item_id;
                if (!id) return;
                all[id] = num(all[id]) + num(r.qty);
                if (byGodown) {
                  if (r.godown_id) {
                    (at[r.godown_id] = at[r.godown_id] || {})[id] =
                      num(at[r.godown_id][id]) + num(r.qty);
                  } else if (num(r.qty)) { loose += 1; }
                }
              });
              // `byStore` is the fact that matters to every figure below: when
              // stock is kept store by store, a store with nothing in it means
              // NOTHING IN IT -- not "look at the firm's total instead".
              setStock({ all, at, byStore: byGodown, loose });
            })
            .catch(() => {});
        }
      } catch (e) {
        // no signal, or the server is not answering: use what we copied last time
        const [ci, cp] = await Promise.all([cachedItems(), cachedParties()]);
        setItems(ci); setParties(cp);
        setOffline(true);
      }
    })();
  }, []);

  // The days this document may be dated. A purchase is not asked about: it
  // belongs to the day it was entered, and the supplier's own date has its
  // own box.
  useEffect(() => {
    if (isBuy) return;
    let alive = true;
    supabase.rpc('bill_date_window', { p_vtype: vtype, p_id: editId || null })
      .then(({ data, error }) => {
        if (!alive || error || !data || !data.bounded) return;
        setWin(data);
        // a date left over from before the window moved is pulled inside it
        setVdate((d) => (d && d >= data.from && d <= data.to ? d : data.to));
      });
    return () => { alive = false; };
  }, [isBuy, vtype, editId]);

  // Opening a bill that was already saved: put it back on the screen exactly
  // as it was written, ready to be changed.
  useEffect(() => {
    if (!editId) return;
    let alive = true;
    (async () => {
      const [{ data: v, error: vErr }, { data: ls, error: lErr }] = await Promise.all([
        supabase.from('vouchers').select('*, parties(*)').eq('id', editId).maybeSingle(),
        supabase.from('voucher_lines').select('*').eq('voucher_id', editId).order('line_no'),
      ]);
      if (!alive) return;
      if (vErr) { setLoadingBill(false);
                  return Alert.alert('Could not open it', sayPlainly(vErr)); }
      if (!v) { setLoadingBill(false);
                return Alert.alert('Not found', 'That bill is no longer in your books.'); }

      // HALF A BILL IS WORSE THAN NO BILL.
      //
      // The header and the lines are asked for together. If the lines do not
      // arrive the screen used to open anyway, empty, and saving it wrote the
      // bill back with nothing on it — a bill of five items became a bill of
      // none, and the stock and the customer's account went with it. If the
      // lines cannot be read, the bill does not open.
      if (lErr) { setLoadingBill(false);
                  return Alert.alert('Could not open it',
                    'Skwik could not read the items on this bill, so it will not '
                    + 'open it half-written. Try again when you have signal.'); }
      if (!ls || !ls.length) { setLoadingBill(false);
                  return Alert.alert('Nothing on this bill',
                    'This bill has no items on it. Open it again when you have '
                    + 'signal; if it is still empty, it was saved that way.'); }

      // Remembered BEFORE anything is changed on screen: the quantities that
      // are already sitting in his stock figures because of this very bill.
      const took = {};
      (ls || []).forEach((l) => {
        if (!l.item_id) return;
        took[l.item_id] = (took[l.item_id] || 0) + Number(l.qty || 0);
      });
      wasOut.current = took;

      setLoadedType(v.vtype);
      setLoadedNo(v.voucher_no || '');
      setVdate(v.vdate);
      setCust(v.parties || { name: v.printed_name || 'CASH' });
      setIsCash(!!v.is_cash);
      setRcharge(!!v.reverse_charge);
      // THE HEAD IT WAS SAVED WITH, not one worked out again now. The party's
      // state can have moved since -- Greatx's did, on 1 April 2026 -- and a
      // bill already in a filed return must read the same today as it did then.
      setRcmHead(v.reverse_charge && (v.tax_mode === 'igst' || v.tax_mode === 'cgst_sgst')
        ? v.tax_mode : null);
      setLess(Number(v.discount) ? String(v.discount) : '');
      setExtra(Number(v.extra_amount) ? String(v.extra_amount) : '');
      setExtraGst(Number(v.extra_gst_rate) ? String(v.extra_gst_rate) : '');
      setExtraNote(v.extra_note || '');
      setShowExtra(!!Number(v.extra_amount));
      setSupNo(v.supplier_invoice_no || '');
      // A bill being re-opened was filled in the day it was written, so its
      // header starts folded and the goods get the whole screen.
      setHeadOpen(false);
      if (v.supplier_invoice_date) setSupDateText(showDate(v.supplier_invoice_date));
      // The store the goods really moved through, not today's default.
      if (v.godown_id) setGodown(v.godown_id);

      /* the fingerprint is taken once the loaded bill is ON THE SCREEN — see
         the effect below. It cannot be taken here, on a timer, and it never
         could: the setters on this and the next few lines have not been
         applied yet when a zero-millisecond timer fires. */
      needMark.current = true;
      setLines((ls || []).map((l) => {
        seq.current += 1;
        return {
          key: seq.current, item_id: l.item_id, item_name: l.item_name,
          hsn: l.hsn || '', unit: l.unit || 'PCS', gst_rate: Number(l.gst_rate) || 0,
          per: Number(l.per) || 1,
          supply: supplyOf(l),
          qty: String(Number(l.qty)), rate: String(Number(l.rate)),
          disc: Number(l.disc) || 0,
          batch: l.batch || '', expiry: l.expiry || '',
          expiryText: showDate(l.expiry || ''),
          // empty means this line followed the bill, which is how it was saved
          godown_id: l.godown_id || null,
          rateEdited: true, flag: !!l.flag, checked: !!l.checked, note: l.note || '',
        };
      }));
      setLoadingBill(false);
    })();
    return () => { alive = false; };
  }, [editId]);

  /* ---------------- customer ---------------- */

  const cashInfo = useMemo(() => {
    const t = cq.trim();
    if (!isOut) return { isCash: false, name: t };
    const m = t.match(/^cash\b\s*(.*)$/i);
    return m ? { isCash: true, name: m[1].trim() } : { isCash: false, name: t };
  }, [cq, isOut]);

  // by name OR phone number
  // Only what he is typing towards. A shop with three hundred customers does
  // not want the first eight of them in alphabetical order.
  // A purchase is to a supplier and a bill is to a customer, and nobody wants
  // to scroll past the wrong half of his book to find either. Anyone marked
  // "both" shows on both sides, and so does anyone never marked at all.
  const forThisBill = (p) => {
    const k = String(p.kind || '').toLowerCase();
    if (!k || k === 'both') return true;
    return isBuy ? k === 'supplier' : k === 'customer';
  };

  // AN EMPTY BOX SHOWS THE BOOK, IT DOES NOT SHOW NOTHING.
  //
  // This listed names only once he had typed something, so the page opened on
  // a box and a blank space beneath it. His own app lists everybody from the
  // first moment -- which is what a man wants nine times in ten, because the
  // customer he is billing is one of the same twenty people, and tapping a name
  // is quicker than typing it.
  //
  // More of them are offered when nothing is typed, because the list IS the
  // screen then; once he is filtering, eight is plenty.
  const custHits = useMemo(() => {
    const mine = parties.filter(forThisBill);
    const s = cashInfo.name.toLowerCase();
    if (!cq.trim() || !s) {
      return mine.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40);
    }
    return mine.filter((p) => p.name.toLowerCase().indexOf(s) > -1
                           || String(p.phone || '').indexOf(s) > -1).slice(0, 8);
    // Sorting a shop's whole customer book on every keystroke is work nobody
    // asked for; it only changes when the book, or what he typed, does.
  }, [parties, cq, cashInfo.name, isBuy]);

  const chooseCust = (p) => {
    setCust(p); setIsCash(cashInfo.isCash); setCustOpen(false);
    // his own list if he has one, otherwise the shop's answer for a walk-in
    applyList(Number(p.price_list) === 2 ? 2 : (p.price_list ? 1 : walkInList));
    setTimeout(() => qRef.current?.focus(), 150);   // known name: straight to products
  };
  // THE COMMONEST SALE IN THE SHOP: a stranger, cash, no name.
  //
  // The picker told him to "type CASH" and then had nothing for him. With no
  // name typed there were no matches, the "bill him as a new customer" button
  // was hidden, the enter key did nothing and CLOSE was hidden too — the only
  // way out was the hardware back button, onto a bill screen with no entry
  // box on it. He is given the straight road now: one tap, or one press of
  // enter, and he is on the products.
  //
  // No customer row is written for him. A walk-in with no name is not a name
  // to keep, and a book full of "CASH" is a book nobody can read.
  // THE NAME BOX, WRITTEN ONCE AND SHOWN IN TWO PLACES.
  //
  // On the page while the bill has no name on it, and in a sheet when he taps
  // the name in the title bar to change it. It is one function rather than two
  // copies, because a picker that behaves differently depending on where it is
  // drawn is how the two halves drift apart.
  const custPicker = ({ inline }) => (
    <>
      <TextInput
        ref={inline ? custRef : custSheetRef}
        autoFocus={inline}
        style={[S.input, inline ? { marginTop: 8 } : { marginTop: 14 }]}
        placeholder={isOut ? 'Type the customer name' : 'Type the supplier name'}
        placeholderTextColor={C.faint}
        returnKeyType="next" submitBehavior="submit"
        onSubmitEditing={() => {
          // A NAME THAT MATCHES NOTHING IS A NEW CUSTOMER.
          //
          // Pressing next used to do nothing at all when the list was empty, so
          // a name nobody has bought from before was a dead end — he had to
          // find the + button with his other hand. Anything typed that matches
          // nobody now opens the new-customer sheet with the name already in it.
          if (custHits.length) return chooseCust(custHits[0]);
          if (cashInfo.name) return newCust();
          if (cashWalkIn) return startWalkIn();
          if (cq.trim().length >= 2) return newCust();
        }}
        value={cq} onChangeText={setCq} />

      {isOut && cashInfo.isCash && (
        <Text style={{ marginTop: 8, fontSize: 12.5, fontWeight: '700', color: C.green }}>
          Cash sale{cashInfo.name ? ` · ${cashInfo.name}'s name prints on the bill` : ''}
        </Text>
      )}

      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled
        style={inline ? { maxHeight: 330, marginTop: 8 } : { marginTop: 12, flexShrink: 1 }}>
        {custHits.map((p) => (
          <TouchableOpacity key={p.id} onPress={() => chooseCust(p)}
            style={{ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>{p.name}</Text>
            <Text style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              {[p.phone, p.state_name].filter(Boolean).join(' · ')}
            </Text>
          </TouchableOpacity>
        ))}
        {cashWalkIn && (
          <TouchableOpacity onPress={startWalkIn}
            style={{ paddingVertical: 15, marginTop: 8, borderRadius: 12,
                     backgroundColor: C.greenL, alignItems: 'center' }}>
            <Text style={{ fontWeight: '800', color: C.green, fontSize: 15.5 }}>
              Cash sale — go to the items
            </Text>
            <Text style={{ fontSize: 12, color: C.green, marginTop: 3 }}>
              No name goes in your customer book
            </Text>
          </TouchableOpacity>
        )}
        {!!cashInfo.name && (
          <TouchableOpacity onPress={newCust}
            style={{ paddingVertical: 14, marginTop: 8, borderRadius: 12,
                     backgroundColor: C.greenL, paddingHorizontal: 13 }}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: C.greenD }}>
              + Bill “{cashInfo.name}” as a new {isBuy ? 'supplier' : 'customer'}
            </Text>
          </TouchableOpacity>
        )}
        {!custHits.length && (
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 14, lineHeight: 19 }}>
            {cq.trim() ? 'Nobody of that name yet — press the tab key to add them.'
                       : 'Type a name or a phone number.'}
            {isOut ? '\nFor a cash sale, type CASH, or CASH and the name.' : ''}
          </Text>
        )}
      </ScrollView>
    </>
  );

  const cashWalkIn = isOut && cashInfo.isCash && !cashInfo.name;
  const startWalkIn = () => {
    setCust({ name: 'CASH', walkIn: true });
    setIsCash(true);
    setCustOpen(false);
    applyList(walkInList);          // the shop's answer, given once in Settings
    setTimeout(() => qRef.current?.focus(), 150);
  };

  const newCust = () => {
    // Asked once, here, rather than left for later — a customer with no phone
    // number is a reminder that can never be sent, and one with no state is a
    // bill that may carry the wrong tax.
    setPartySheet({
      // whatever he typed, if it was not a cash sale — the name he was
      // half-way through writing should not have to be written twice
      name: cashInfo.name || (cq.trim() || 'CASH'),
      kind: isBuy ? 'supplier' : 'customer',
      phone: '', area: '', address: '', gstin: '',
      opening_balance: '', opening_type: 'owes_you',
      price_list: String(priceList || walkInList),
      state_code: String(org?.state_code || ''),
    });
    setIsCash(cashInfo.isCash);
    setCustOpen(false);
  };

  // What the sheet collected, taken as the customer for this bill. He is
  // written to the book when the bill is saved, not before — a sheet closed
  // halfway leaves nothing behind.
  const takeNewParty = () => {
    const np = partySheet;
    if (!np?.name?.trim()) return Alert.alert('Name', 'Type the name.');
    const code = String(np.state_code || '').trim();
    setCust({
      name: np.name.trim(), isNew: true,
      kind: np.kind,
      phone: String(np.phone || '').replace(/\D/g, '').slice(-10),
      area: np.area?.trim() || '',
      address: np.address?.trim() || '',
      gstin: String(np.gstin || '').toUpperCase().trim(),
      opening_balance: num(np.opening_balance),
      opening_type: np.opening_type === 'you_owe' ? 'you_owe' : 'owes_you',
      price_list: Number(np.price_list) === 2 ? 2 : 1,
      state_code: code || org?.state_code,
      state_name: STATES[code] || org?.state_name,
    });
    if (!isBuy) applyList(Number(np.price_list) === 2 ? 2 : 1);
    setPartySheet(null);
    setTimeout(() => qRef.current?.focus(), 150);

    // A NAME ENTERED IS A NAME KEPT, WHETHER OR NOT A BILL FOLLOWS.
    //
    // He was only written when the bill was saved. A counter who takes the
    // man's name, his phone and his old dues and is then interrupted — the
    // customer walks off, the phone rings, the bill is abandoned — had typed
    // all of it for nothing, and typed it again the next time.
    //
    // He goes in now. If there is no signal, the same queue that carries the
    // bill carries him, exactly as before.
    (async () => {
      try {
        const saved = await findOrCreateParty(np.name.trim(), {
          state_code: code || org?.state_code,
          kind: np.kind, phone: np.phone, area: np.area, address: np.address,
          gstin: np.gstin, opening_balance: np.opening_balance,
          opening_type: np.opening_type, price_list: np.price_list,
        });
        if (saved?.id) setCust((c) => (c && c.name === np.name.trim()
          ? { ...saved, isNew: false } : c));
      } catch (e) { /* the save path writes him again if this did not stick */ }
    })();
  };

  /* ---------------- product entry ---------------- */

  // WHAT HE HAS COMES FIRST, AND WHAT HE HAS NONE OF COMES LAST.
  //
  // He sells what is on the shelf. An item he has run out of is still worth
  // finding — he may be billing it anyway, or about to reorder — but it has
  // no business sitting above three things he can actually hand over. So the
  // search still finds everything and still ranks by how well the name
  // matches; nought-stock items are simply moved to the end of that list.
  //
  // The test is the TOTAL across every store, not the bill's own store. An
  // item with forty in the other godown is not out of stock; it is in the
  // wrong place, and the row says so and offers to move the line there.
  //
  // A shop that keeps no stock has no figures at all, and the order it has
  // always had is left exactly as it was.
  const hits = useMemo(() => {
    const found = searchItems(items, q);
    if (!stock || !org?.stock_enabled) return found;
    const has = [], none = [];
    found.forEach((h) => (num(stock.all[h.p.id] || 0) > 0 ? has : none).push(h));
    return has.concat(none);
  }, [items, q, stock, org?.stock_enabled]);
  const parsed = parseQuery(q);

  /* ---------------- ONE-HANDED PICKING ---------------------------------- */
  //
  // Type "steel" and four things come back: steel thali, steel balti, steel
  // batti, steel glass. The one he wants is third. Until now that meant
  // either typing more of the name — with the packet in his other hand — or
  // reaching a thumb up into the middle of a six-inch screen and aiming at a
  // row forty pixels high, across a counter, standing up.
  //
  // So: a bar down the RIGHT of the list, where his thumb already is. One big
  // down arrow walks the highlight a line at a time and comes back round to
  // the top at the end; a small OK under it puts the highlighted item on the
  // bill. Enter does the same thing, and so does Tab on a keyboard, for a
  // shop billing off a laptop.
  //
  // Nothing is taken away: every row is still a row he can tap, and a shop
  // that never turns this on sees exactly what it saw before.
  const wantRail = showThumbRail(org);
  const [sel, setSel] = useState(0);
  // which row has been asked "where is it?", if any
  const [whereOpen, setWhereOpen] = useState(null);
  const hitsRef = useRef(null);

  // A new search is a new list, so the highlight goes back to the top. It is
  // also clamped, because a list can get shorter under it while he types.
  useEffect(() => { setSel(0); setWhereOpen(null); rowAt.current = {}; seenY.current = 0; }, [q]);
  const at = hits.length ? Math.min(sel, hits.length - 1) : 0;

  // WHERE EACH ROW ACTUALLY IS, MEASURED RATHER THAN ASSUMED.
  //
  // "When we tap on floating arrow, the selection goes down, but the rows
  // remain there itself, so after 3 taps, the selection hides behind keypad."
  //
  // The scroll was `n * 56 - 112`: a guess that every row is 56 points tall.
  // They are not. A row for an item held at the other store carries a second
  // line under it with the store on it and is half again as tall -- so in a
  // two-store shop the arithmetic drifted further out with every tap, and the
  // highlight walked off the bottom of the window while the list sat still.
  // Which is precisely the shop this feature was built for.
  //
  // So each row says where it is and how tall it is as it is laid out, the
  // window says how tall IT is, and the list is moved only as far as it takes
  // to bring the highlighted row inside -- never past it, so the page does not
  // jump about under his thumb.
  const rowAt = useRef({});      // where each row starts, and how tall it is
  const boxH = useRef(0);        // how tall the window over the list is
  const seenY = useRef(0);       // how far down the list is scrolled now

  const showRow = (n) => {
    const r = rowAt.current[n];
    const box = boxH.current;
    if (!r || !box) {
      // nothing measured yet, on the very first tap: the old guess will do,
      // and the next tap has real figures to work with
      hitsRef.current?.scrollTo({ y: Math.max(0, n * 56 - 112), animated: true });
      return;
    }
    const pad = 6;
    const top = seenY.current;
    if (r.y < top + pad) {
      hitsRef.current?.scrollTo({ y: Math.max(0, r.y - pad), animated: true });
    } else if (r.y + r.h > top + box - pad) {
      hitsRef.current?.scrollTo({ y: Math.max(0, r.y + r.h - box + pad), animated: true });
    }
  };

  const walk = () => {
    if (!hits.length) return;
    const n = (at + 1) % hits.length;
    setSel(n);
    showRow(n);
  };

  const takeSel = () => {
    if (hits.length) return addHit(hits[at]);
    if (q.trim()) {
      setQuick({ name: parsed.base || parsed.full, alias: '', unit: 'PCS', hsn: '',
                 gst_rate: '', rate: '', rate2: '', other: '', opening_stock: '',
                 qty: parsed.qty == null ? '' : String(parsed.qty) });
    }
  };

  // Which list this bill is on decides the rate. A rate already typed by hand
  // is never touched by it.
  // On a purchase bill the rate is what he pays. On a sale bill it is what he
  // charges — and if nobody ever set that, it is his cost plus a tenth rather
  // than nothing at all, because a line at zero gives the goods away.
  const listRate = (p, list) => {
    if (isBuy) return p.purchase_price || p.sale_price;
    return saleRate(p, list || priceList);
  };

  // A packet scanned at the counter. Known code: the line goes on and the
  // quantity box is waiting. Scanned twice: the quantity goes up by one
  // instead of a second line appearing, which is what a shop actually wants.
  // Unknown code: he is asked once what it is, and it is remembered.
  const scanned = async (code) => {
    const take = (hit) => {
      const already = lines.find((l) => l.item_id === hit.id);
      if (already) setLine(already.key, { qty: String(num(already.qty) + 1) });
      else addHit({ p: hit, qty: 1, toks: [] });
    };

    // The list this screen is holding, compared properly — a space typed into
    // the item screen, a hyphen off the label or the thirteenth zero an EAN
    // reader puts in front of a UPC no longer make it a different packet.
    const hit = itemsWithCode(items, code)[0];
    if (hit) return take(hit);

    // NOT IN THE LIST IS NOT THE SAME AS NOT IN THE BOOK.
    //
    // This screen reads the items once, when it opens. A code put against an
    // item a minute ago on the item screen, or on the owner's phone while the
    // counter boy had the bill screen open, or against an item that has since
    // been switched off, is simply not in the copy it is holding — and he was
    // told, flatly, that no product carries that code, standing there with
    // the packet in his hand. So before saying that, ask the database.
    try {
      // the same three spellings the in-memory match already forgives
      const c = String(code).trim();
      const tries = [...new Set([c, c.replace(/^0+/, ''), `0${c}`])].filter(Boolean);
      const { data } = await supabase.from('items').select('*')
        .in('barcode', tries).limit(1);
      const server = (data || [])[0];
      if (server) {
        setItems((old2) => (old2.some((x) => x.id === server.id)
          ? old2.map((x) => (x.id === server.id ? server : x))
          : [...old2, server]));
        return take(server);
      }
    } catch (_) {
      // no signal. Fall through and offer to add it, which is what he would
      // have been offered anyway.
    }

    // SAID IN WORDS HE CAN ACT ON.
    //
    // "No item in your book carries that code. Add it to an item now?" told
    // him a fact about Skwik's insides and then asked a question he could not
    // answer — add it to WHICH item? And a shop that has just brought its
    // goods over from Tally sees this on the FIRST packet it scans, because
    // Tally holds no barcodes at all, so nothing in the list has one yet. The
    // packet is not the problem and neither is he; the code has simply never
    // been written down. So say that, and say what happens next.
    setScanOpen(false);
    Alert.alert('This packet has no code against it yet',
      'Nothing in your item list carries this barcode. Find the item by name, '
      + 'and Skwik keeps the code on it — from then on, scanning that packet '
      + 'puts it straight on the bill.',
      [{ text: 'Not now' },
       { text: 'Find the item',
         onPress: () => { setPendingCode(code); setQ(''); qRef.current?.focus(); } }]);
  };

  // `fromGodown` is set when he taps "40 in Na-Paukhry" on a search result:
  // the line is added already pointed at the store that has the goods, so he
  // never bills out of a store that is empty.
  const addHit = (h, fromGodown) => {
    // A SCANNED CODE THAT TURNED OUT TO BE AN ITEM HE ALREADY HAS.
    //
    // He scans a packet, is told nothing carries that code, says yes to
    // adding it — and then types the name and finds the item sitting there
    // all along, under a name he had entered by hand. Skwik used to keep the
    // code only for an item it CREATED, so the next scan of that same packet
    // asked him the same question again, for ever. Now the code goes onto
    // whichever item he picked, and that is the end of it.
    if (pendingCode && h.p?.id && !String(h.p.barcode || '').trim()) {
      const code = pendingCode;
      setPendingCode('');
      setItems((old2) => old2.map((x) => (x.id === h.p.id ? { ...x, barcode: code } : x)));
      (async () => {
        try { await supabase.from('items').update({ barcode: code }).eq('id', h.p.id); }
        catch (_) { /* no signal: the next scan asks again, which is honest */ }
      })();
    } else if (pendingCode) {
      // He picked an item that ALREADY carries a code — a different packet of
      // the same goods, most likely. The waiting code cannot go there without
      // overwriting one he chose himself, so it is dropped rather than left
      // hanging over every item he picks for the rest of the bill.
      setPendingCode('');
    }

    const rate = listRate(h.p);
    seq.current += 1;
    const line = {
      key: seq.current, item_id: h.p.id, item_name: h.p.name, hsn: h.p.hsn || '',
      unit: h.p.unit || 'PCS', gst_rate: Number(h.p.gst_rate) || 0,
      // HOW MANY ON THE SHELF ONE OF THESE IS. One, until he taps the unit
      // pill and sells it by the dozen. Carried on the line rather than
      // looked up at save time, because the item's factor may be changed
      // tomorrow and this bill must keep saying what it said today.
      per: 1,
      altUnit: h.p.alt_unit || '', altPer: Number(h.p.alt_per) || 0,
      stockUnit: h.p.unit || 'PCS',
      stockRate: rate,
      // WHAT A DOZEN COSTS ON THE LIST THIS BILL IS ON.
      //
      // The dozen price on the item is the one that goes with its main
      // selling price — a dozen is priced as a dozen and 600 is not twelve
      // times 55. But this bill may be on the retail list, or on a customer's
      // own, and that dozen price is not his. So the hand-set figure is used
      // only when the rate on this line IS the item's main price; on any
      // other list the dozen is that list's rate times the factor, which is
      // at least right rather than somebody else's price.
      //
      // Worked out once, here, from the list in force as the item was picked.
      altRate: (Number(h.p.alt_rate) > 0 && num(rate) === num(h.p.sale_price))
        ? Number(h.p.alt_rate)
        : Math.round(num(rate) * (Number(h.p.alt_per) || 1) * 100) / 100,
      // Milk is always nil-rated; the item master knows it, so the line does
      // not have to be told every time.
      supply: supplyOf(h.p),
      // A LINE WITH NO QUANTITY IS NOT SAVED AT ALL, and an empty box does not
      // look like a problem — it looks like a box. One is right far more often
      // than nothing is, and the cursor still lands here with it selected, so
      // typing a different number replaces it.
      qty: h.qty == null ? '1' : String(h.qty), rate: String(rate || ''),
      // the rate was worked out from cost, not set by anyone: the line says so
      rateGuessed: !isBuy && rateIsGuessed(h.p, priceList),
      rateEdited: false, flag: false, checked: false, note: '',
      batch: '', expiry: '',
      // empty = wherever the bill says. A line only carries a store of its
      // own once he has pointed it at one — or once he picked it off a search
      // result that told him where the goods actually are.
      godown_id: fromGodown && fromGodown !== godown ? fromGodown : null,
    };
    setLines((ls) => [line, ...ls]);                 // newest at the TOP
    setQ('');
    // quantity was typed: on to the next product. Not typed: ask for it,
    // with the cursor already sitting in the quantity box.
    if (h.qty != null) setTimeout(() => qRef.current?.focus(), 80);
    else focusCell(line.key, 'qty');

    if (cust?.id) lastRate(line.key, h.p.id);
  };

  const lastRate = async (key, itemId) => {
    const { data } = await supabase
      .from('voucher_lines')
      .select('rate, vouchers!inner(party_id, vtype, vdate)')
      .eq('item_id', itemId).eq('vouchers.party_id', cust.id)
      .in('vouchers.vtype', isBuy ? ['purchase'] : ['sale', 'estimate'])
      .order('vdate', { foreignTable: 'vouchers', ascending: false }).limit(1);
    // This comes back seconds later, by which time he may already be typing
    // the rate himself. Whatever he has put in wins — a box that changes under
    // his finger is worse than no help at all.
    if (!data?.[0]?.rate) return;
    setLines((ls) => ls.map((l) => (
      l.key === key && !l.rateEdited && !l.rateTouched
        ? { ...l, rate: String(data[0].rate), fromHistory: true }
        : l)));
  };

  // SWITCHING PRICE LIST MUST NOT EMPTY A RATE.
  //
  // This read the price straight off the item and wrote whatever it found.
  // An item with no price of its own — anything that came in as opening
  // stock — has nothing there, so the line's rate became an empty string and
  // the cost-plus-a-tenth figure the app had worked out was thrown away.
  // Tapping the other price list on a bill full of such items zeroed it.
  //
  // saleRate() is the one place that knows what a line should charge, so it
  // is the one place asked. If it has nothing to offer either, the rate that
  // is already on the line stands.
  const applyList = (list) => {
    setPriceList(list);
    setLines((ls) => ls.map((l) => {
      if (l.rateEdited || isBuy) return l;
      const p = items.find((x) => x.id === l.item_id);
      if (!p) return l;
      const r = saleRate(p, list);
      if (!(r > 0)) return l;
      return { ...l, rate: String(r) };
    }));
  };

  const setLine = (key, patch) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));
  const toggleFlag  = (key) => setLines((ls) => ls.map((l) => l.key === key ? { ...l, flag: !l.flag } : l));
  const toggleCheck = (key) => setLines((ls) => ls.map((l) => l.key === key ? { ...l, checked: !l.checked } : l));

  /* ---------------- which store this line came out of ---------------- */

  // A line follows the bill unless he has pointed it somewhere else.
  // HOW MANY OF THIS ONE, IN THE STORE THIS BILL IS COMING OUT OF.
  //
  // A shop with two godowns that was shown the firm's total would be told it
  // had forty when thirty of them are three miles away at the other store —
  // exactly the promise a shopkeeper must not make. With a store chosen, the
  // figure is that store's. With none chosen, or only one store kept, it is
  // the firm's. `null` back means the figures are not in yet.
  // A STORE WITH NOTHING IN IT IS NOT THE WHOLE SHOP.
  //
  // This read `if (godown && stock.at[godown])` -- and `stock.at` only gets a
  // key for a store that had at least one row of stock in it. So the moment his
  // small store ran out of everything, or on a store just created, the test
  // fell through and every row reported THE FIRM'S TOTAL as available here:
  // "240 here" with all 240 of them three miles away. That is the one promise
  // the comment above this function says must never be made, and it was being
  // made in exactly the shop that most needed it not to be.
  //
  // The question is whether stock is being kept store by store at all, not
  // whether this store happens to have something in it today.
  const haveOf = (id) => {
    if (!stock || !id) return null;
    if (stock.byStore && godown) return num((stock.at[godown] || {})[id] || 0);
    return num(stock.all[id] || 0);
  };

  // EVERYTHING HE HAS OF IT, WHEREVER IT IS.
  //
  // The figure beside a search result used to be the bill's own store alone,
  // and he was right that it misleads: an item with forty in the other godown
  // showed as nought, dropped to the bottom of the list, and looked finished.
  // What he needs to see is both — what he can hand over from here, and what
  // the shop holds altogether.
  const totalOf = (id) => (stock && id ? num(stock.all[id] || 0) : null);

  // And WHICH store has it, so one tap can move the line there rather than
  // sending him to the stock screen to find out.
  const whereItIs = (id) => {
    if (!stock || !id || !godowns.length) return [];
    return godowns
      .map((g) => ({ id: g.id, name: g.name, qty: num((stock.at[g.id] || {})[id] || 0) }))
      .filter((g) => g.qty > 0)
      .sort((a, b) => b.qty - a.qty);
  };

  const lineGodown = (l) => l.godown_id || godown;
  const godownName = (id) => godowns.find((g) => g.id === id)?.name || '';

  // ONE TAP, BECAUSE A SHOP WITH TWO GODOWNS TAPS THIS ALL DAY.
  //
  // It walks to the next store and round again. Landing back on the bill's
  // own store CLEARS the line's choice instead of freezing it there, so
  // changing the bill's godown afterwards still carries that line with it —
  // otherwise a line he had put back would quietly stay behind in the old
  // store and the stock of both godowns would be wrong.
  const cycleGodown = (l) => {
    if (godowns.length < 2) return;
    const at = godowns.findIndex((g) => g.id === lineGodown(l));
    const next = godowns[(at + 1) % godowns.length];
    const own = next.id === godown ? null : next.id;
    setLine(l.key, { godown_id: own });
    // The batches on offer belong to a STORE. Moving the line moves the list
    // with it, so an open list can never be left showing the other godown's
    // batches — picking one of those would write the goods out of a store the
    // line no longer comes from.
    if (pickFor === l.key) loadBatches(l.item_id, own || godown);
  };

  /* ---------------- the batches he actually has ---------------- */

  // What is in stock depends on the item AND on the store it is coming out
  // of, so both name the answer that is kept.
  const stockKey = (l) => `${l.item_id}|${lineGodown(l) || ''}`;

  // A BATCH TYPED FROM MEMORY SELLS FROM A BATCH NOBODY HAS.
  //
  // On a purchase the batch is being created, so typing it is right. On a
  // sale it already exists, on a strip in his hand, and one wrong letter
  // writes the goods out of a batch that was never there — the stock of the
  // real batch never moves and the expiry report goes on counting it. So on
  // a sale he is shown what is actually left, and picks.
  const loadBatches = async (itemId, gid) => {
    const key = `${itemId}|${gid || ''}`;
    if (inStock[key] || asking.current[key]) return;
    asking.current[key] = true;
    try {
      const { data, error } = await withTimeout(supabase.rpc('batches_in_stock',
        { p_item: itemId, p_godown: gid || null }));
      if (error) throw error;
      setInStock((m) => ({ ...m, [key]: data || [] }));
    } catch (_) {
      // A PHONE UPDATED BEFORE THE DATABASE MUST STILL WRITE THE BILL.
      //
      // The list simply has nothing in it, the typing box above it is
      // untouched, and he bills the way he always did. Nothing is said and
      // nothing is asked again — this is the busiest screen in the app and it
      // is not the place to explain a database to a shopkeeper.
      setInStock((m) => ({ ...m, [key]: [] }));
    }
    asking.current[key] = false;
  };

  // The expiry belongs to the batch, so it is taken with it. He is not asked
  // to remember which date went with which lot — that is the typing mistake
  // this whole list exists to stop.
  const takeBatch = (l, b) => {
    setLine(l.key, {
      batch: b.batch || '',
      expiry: b.expiry ? String(b.expiry).slice(0, 10) : '',
      expiryText: b.expiry ? showDate(String(b.expiry).slice(0, 10)) : '',
    });
    setPickFor(null);
  };

  // A BATCH TYPED IN BY HAND SHOULD BRING ITS EXPIRY TOO.
  //
  // The list beside the box takes the expiry with the batch, and that always
  // worked. But most of the time he does not open the list — the batch is on
  // the strip in his hand and typing it is faster — and then the expiry box
  // sat there empty, waiting for a date he would have to read off the foil
  // and turn round into the order the box wanted. It is the same lot either
  // way: Skwik already knows when B-101 goes off.
  //
  // So the moment what he has typed matches a batch of that item Skwik holds,
  // the expiry fills itself in. Only when the box is empty — a date he has
  // put in himself is his, and is never overwritten.
  const fillExpiryFromBatch = (l, typed) => {
    const want = String(typed || '').trim().toUpperCase();
    if (!want) return;
    const have = inStock[stockKey(l)];
    if (!have || !have.length) return;
    const b = have.find((x) => String(x.batch || '').trim().toUpperCase() === want);
    if (!b || !b.expiry) return;
    const iso = String(b.expiry).slice(0, 10);
    setLines((ls) => ls.map((x) => (x.key !== l.key || (x.expiryText || x.expiry) ? x
      : { ...x, expiry: iso, expiryText: showDate(iso) })));
  };

  // CHANGE ITEM READS THE SAME WAY THE SEARCH BAR DOES.
  //
  // "When we click on Change item, same kind of search bar will be more
  // useful." It was a plain list of names -- no unit, no stock, no quantity --
  // so choosing between "Steel Utensils (A)" and "Steel Utensils (M)" meant
  // remembering which one he had any of. It is the same reader as the bar now:
  // it takes "balty 5" and changes the item AND the quantity in one go, and
  // every row says what is on the shelf here the way the bar's rows do.
  const swapAsked = useMemo(() => parseQuery(sq), [sq]);
  const swapHits = useMemo(
    () => (swapFor == null ? [] : searchItems(items, sq || ' ', 12)), [items, sq, swapFor]);

  // Swap the product, keep the quantity unless he typed a new one, take the
  // new rate.
  const doSwap = (h, storeId) => {
    const patch = {
      item_id: h.p.id, item_name: h.p.name, hsn: h.p.hsn || '', unit: h.p.unit || 'PCS',
      gst_rate: Number(h.p.gst_rate) || 0,
      supply: supplyOf(h.p),
      rate: String(listRate(h.p) || ''),
      rateGuessed: !isBuy && rateIsGuessed(h.p, priceList),
      rateEdited: false,
    };
    // A figure typed after the name is a new quantity, exactly as it is in the
    // bar above. `h.qty` is what the reader found on the row itself.
    const asked = h.qty != null ? h.qty : swapAsked.qty;
    if (asked != null && asked > 0) patch.qty = String(asked);
    // And if he picked it out of a particular store, the line goes to that
    // store -- otherwise it follows the bill, as it always did.
    if (storeId !== undefined) patch.godown_id = storeId === godown ? null : storeId;
    setLine(swapFor, patch);
    setSwapFor(null); setSq('');
  };

  /* ---------------- totals ---------------- */

  // A purchase on reverse charge still carries tax — his own.
  const mode = isBuy
      ? (rcharge ? rcmTaxMode(org, cust, rcmHead) : purchaseTaxMode(org, cust))
    : estimateMode ? 'none' : taxModeFor(org, cust, isCash);
  const good = lines.filter((l) => l.item_name.trim() && num(l.qty) > 0);
  const extraAmt  = num(extra);
  // Freight carries the dearest rate on the bill unless he says otherwise.
  // FREIGHT CARRIES THE DEAREST RATE ON THE BILL unless he says otherwise --
  // and on a bill with no goods at all there is nothing to copy from, so
  // topRate([]) answered 0 and a reverse-charge freight bill would have saved
  // with no tax on it. 5% is the goods transport agency rate and what all 66
  // of his April and May freight bills carry; he can still type over it.
  const extraRate = extraGst !== '' ? num(extraGst)
                  : good.length ? topRate(good)
                  : (rcharge && isBuy) ? 5
                  : 0;
  const discAsked = num(less);
  // `discount` is passed even when the box is empty — 0 is how a discount is
  // TAKEN OFF a bill that already had one, and leaving it out was why it could
  // not be removed once saved.
  const calc = computeBill(good, mode,
    { amount: extraAmt, gst_rate: extraRate, discount: discAsked,
      reverseCharge: !!rcharge && !isBuy,
      selfTax:       !!rcharge && isBuy });
  const grand = calc.total;
  const roundOff = calc.round_off;
  const checked = lines.filter((l) => l.checked).length;
  const discTotal = calc.discount;
  const wantBatch  = showBatch(org);
  const wantExpiry = showExpiry(org);

  /* ---------------- new product, mid-bill ---------------- */

  const saveQuick = async () => {
    const taxed = org?.is_gst_registered && !org?.is_composition;
    if (!quick.name.trim()) return Alert.alert('Name needed', 'Type the item name.');
    if (!quick.unit) return Alert.alert('Unit needed', 'Choose how this item is counted.');
    const problem = checkHsn(quick.hsn, org);
    if (problem) return Alert.alert('HSN code', problem);

    const write = async () => {
      const body = {
        id: uuid(),
        org_id: org.id, name: quick.name.trim(), alias: quick.alias.trim(),
        unit: quick.unit, hsn: quick.hsn.trim(), gst_rate: num(quick.gst_rate),
        barcode: pendingCode || null,
        // `rate` is whichever rate this bill is asking for; `other` is the one
        // it is not. An item born on a purchase bill used to go in with no
        // sale price at all, which left it priceless on every sale bill after
        // and invisible to anything that reads the shelf by value.
        sale_price:     isBuy ? num(quick.other) : num(quick.rate),
        purchase_price: isBuy ? num(quick.rate)  : num(quick.other),
        price2:         num(quick.rate2),
        opening_stock:  num(quick.opening_stock),
        is_active: true,
      };
      let saved = body;
      try {
        const { data, error } = await withTimeout(
          supabase.from('items').insert(body).select().single());
        if (error) throw error;
        saved = data;
      } catch (e) {
        if (!looksOffline(e)) return Alert.alert('Could not save', sayPlainly(e));
        newItems.current = [...newItems.current, body];   // saved when the line comes back
        setOffline(true);
      }
      setItems((xs) => [...xs, saved]);
      setQuick(null);
      setPendingCode('');
      addHit({ p: saved, qty: quick.qty ? Number(quick.qty) : null, toks: [] });
    };

    // A tax invoice with a 0% line on it undercharges the customer and
    // understates the return. The rate is the one field on this sheet with
    // money behind it, so it is the one field nobody may skip past.
    if (taxed && !num(quick.gst_rate)) {
      return Alert.alert('GST rate?',
        'This item has no GST rate. A bill with it on will charge no tax. '
        + 'Put the rate in, or set it to 0 on purpose.',
        [{ text: 'Go back' }, { text: 'It really is 0%', onPress: write }]);
    }

    // An item bought but never priced is a rate typed by hand on every sale
    // bill for the rest of its life, and it is missing from anything that
    // reads the shelf by value. Asked once, here, while it is cheap to answer.
    if (isBuy && !num(quick.other)) {
      return Alert.alert('No sale rate',
        'This item has nothing to sell at. Every sale bill with it on will come '
        + 'up blank and you will type the rate in by hand.',
        [{ text: 'Let me put it in' }, { text: 'Leave it for now', onPress: write }]);
    }
    write();
  };

  /* ---------------- save ---------------- */

  const findOrCreateParty = async (name, from) => {
    const hit = parties.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;

    // The phone decides the id, so the same customer cannot be created twice
    // when the queue is sent.
    const src = from || cust;
    const code = String(src?.state_code || org.state_code || '').trim();
    const body = {
      id: uuid(),
      org_id: org.id, name,
      kind: src?.kind || (isBuy ? 'supplier' : 'customer'),
      phone: src?.phone || null,
      area: src?.area || null,
      address: src?.address || null,
      gstin: src?.gstin || null,
      is_registered: !!src?.gstin,
      // what he already owed before this bill — asked on the sheet, because a
      // customer entered mid-bill with a balance left out of him reads as
      // settled, and the udhar list is then wrong from the first day
      opening_balance: num(src?.opening_balance),
      opening_type: src?.opening_type === 'you_owe' ? 'you_owe' : 'owes_you',
      opening_date: src?.opening_balance ? today() : null,
      price_list: isBuy ? 1 : (Number(src?.price_list) || priceList),
      state_code: code,
      state_name: STATES[code] || src?.state_name || org.state_name,
    };

    try {
      const { data, error } = await withTimeout(
        supabase.from('parties').insert(body).select().single());
      if (error) throw error;
      setParties((ps) => [...ps, data]);
      return data;
    } catch (e) {
      if (!looksOffline(e)) throw e;
      newParty.current = body;              // created when the line comes back
      setParties((ps) => [...ps, body]);
      setOffline(true);
      return body;
    }
  };

  // asked once per save, like the quantity-looks-like-a-price question
  const shortOk = useRef(false);
  const save = async (holdOnly) => {
    // A BILL CAN BE A CHARGE AND NOTHING ELSE.
    //
    // This refused any bill with no item carrying a quantity, which is most of
    // what a shop buys that is not goods: the transporter's bill, the
    // electricity, the consumables. His plastic company's own Tally book has
    // 26 such purchases out of 48, worth 20,77,739.94 -- Consumable Exp and
    // Transportation -- and the freight bill he sat down to enter could not be
    // saved at all.
    //
    // A SALE still needs goods on it. Nobody sells a charge across a counter,
    // and a sale with no lines is a mistake every time.
    const chargeOnly = isBuy && !good.length && extraAmt > 0;
    if (!good.length && !chargeOnly) {
      return Alert.alert('Nothing to save', isBuy
        ? 'Add an item with a quantity, or put the amount in the charge box below '
          + 'if this bill is only freight or an expense.'
        : 'Add at least one item with a quantity.');
    }
    if (!cust?.name) return Alert.alert('Who is it for?', 'Choose a customer first.');

    // SECTION 10(2)(c): A COMPOSITION DEALER MAY NOT SELL OUTSIDE HIS STATE.
    //
    // Not a tax question with a right answer -- the sale is not open to him,
    // and making one puts his composition out of order from that date. So it
    // is stopped here rather than priced. The reasoning is beside
    // compositionCannotSupply in money.js.
    if (!isBuy && vtype !== 'estimate') {
      const no = compositionCannotSupply(org, cust?.id ? cust : null);
      if (no) return Alert.alert('Not allowed on composition', no);
    }

    // NOTHING LEAVES THE SHOP AT NOTHING. A rate of zero on a sale is not a
    // discount, it is a giveaway, and it prints as 0.00 on the customer's copy.
    // Anything with a cost behind it has already been given cost plus a tenth
    // by the time it reaches here, so a zero at this point means the item has
    // no price of any kind and only he can say what it is worth.
    if (isOut) {
      const free = good.filter((l) => num(l.rate) <= 0);
      if (free.length) {
        return Alert.alert('This line has no rate',
          `${free[0].item_name} would go out at ₹0`
          + (free.length > 1 ? `, and ${free.length - 1} other line(s) too` : '')
          + '.\n\nThis item has no selling price and no purchase price either, '
          + 'so there is nothing to work one out from. Put the rate in.');
      }
    }
    // "bucket 250" MEANT TWO HUNDRED AND FIFTY RUPEES, NOT 250 BUCKETS.
    //
    // A number at the end of what he types is always the quantity — that rule
    // is what makes the search fast and it is worth keeping. But the price is
    // the other number he has in his head at that moment, and when the two
    // come out the same the bill is almost always wrong by a factor of
    // hundreds. Ask once; he taps save again and it goes through.
    if (!priceAsQty.current) {
      const odd = good.find((l) => num(l.qty) >= 20 && num(l.qty) === num(l.rate));
      if (odd) {
        priceAsQty.current = true;
        return Alert.alert('Is that the quantity?',
          `${odd.item_name}: ${fmt0(num(odd.qty))} at ₹${fmt0(num(odd.rate))} each `
          + `comes to ₹${fmt0(num(odd.qty) * num(odd.rate))}.\n\n`
          + 'The quantity and the rate are the same number, which usually means '
          + 'the price was typed into the quantity box. Change it, or tap save '
          + 'again to go ahead.');
      }
    }
    // MORE THAN THE SHOP HAS.
    //
    // Nothing anywhere in the billing path ever looked at stock. A counter
    // could sell four hundred of something he has eleven of, and the only
    // sign was a minus figure on the stock screen weeks later. It is NOT
    // blocked — the goods are on the floor whatever the app believes, and a
    // customer standing at the counter is not going to wait for a stock
    // correction — but he is told once, with the figures, before it is
    // written. Asked once per save, for the whole bill, so it costs one
    // request and not one per keystroke.
    if (isOut && org?.stock_enabled && !shortOk.current) {
      try {
        const ids = [...new Set(good.map((l) => l.item_id).filter(Boolean))];
        if (ids.length) {
          const { data: have } = await supabase.from('stock_in_hand')
            .select('item_id, qty').in('item_id', ids);
          // A BILL BEING EDITED HAS ALREADY TAKEN ITS OWN GOODS OFF THE SHELF.
          //
          // He had two dozen of two items and sold exactly two dozen of each.
          // His stock is now nought — correctly. Then he opened that bill to
          // change something else entirely, and Skwik said the stock was zero
          // and did he want to go ahead, about lines he had not touched.
          //
          // Of course it did: it asked "is there two dozen on the shelf?" when
          // the two dozen on the bill in front of it are the very ones that
          // left. What it has to ask is whether there is enough IF this bill
          // were taken back out first — so what this bill already took is added
          // back before the comparison. On a new bill nothing was taken and
          // this changes nothing at all.
          const inHand = {};
          (have || []).forEach((r) => {
            inHand[r.item_id] = num(r.qty) + num(wasOut.current[r.item_id] || 0);
          });
          const want = {};
          good.forEach((l) => { if (l.item_id)
            want[l.item_id] = num(want[l.item_id]) + num(l.qty); });
          const short = Object.keys(want)
            .filter((id) => inHand[id] !== undefined && want[id] > inHand[id])
            .map((id) => {
              const l = good.find((x) => x.item_id === id);
              return `${l.item_name}: ${fmt0(want[id])} going out, ${fmt0(inHand[id])} in hand`;
            });
          if (short.length) {
            shortOk.current = true;
            return Alert.alert('More than you have',
              short.slice(0, 5).join('\n')
              + (short.length > 5 ? `\n+ ${short.length - 5} more` : '')
              + '\n\nSave it anyway if the goods really went out — the stock '
              + 'figure is what needs correcting, not the bill.',
              [{ text: 'Let me check' },
               { text: 'It really went out', onPress: () => save(holdOnly) }]);
          }
        }
      } catch (e) { /* stock is a courtesy here; it never stops a bill */ }
    }
    // A DATE SKWIK CANNOT READ IS SAID SO HERE — not left to the database to
    // refuse it in a sentence about quantities being far too large.
    if (isBuy && supDateText.trim() && !supDate) {
      return Alert.alert('Check the date on his bill',
        `Skwik cannot read "${supDateText.trim()}" as a date.\n\n`
        + 'Write it as 19-09-2026, or 19/9/26, or 19 Sep 2026.');
    }
    if (isOut && isCash && !cashInfo.name && grand >= 50000) {
      return Alert.alert('Name needed',
        'A cash bill of ₹50,000 or more must show the customer name.');
    }
    // some ticked and some not: ask once
    if (!nudged && checked > 0 && checked < lines.length) {
      setNudged(true);
      return Alert.alert('Not all lines ticked',
        `${lines.length - checked} line(s) are not ticked yet. Tap save again to go ahead.`);
    }

    setBusy(true);
    let wrote = false;                 // outside the try, so the catch can see it
    try {
      const pty = cust.walkIn ? null
                : cust.id ? cust
                : await findOrCreateParty(cust.name);
      const m = isBuy
          ? (rcharge ? rcmTaxMode(org, pty, rcmHead) : purchaseTaxMode(org, pty))
        : estimateMode ? 'none' : taxModeFor(org, pty, isCash);
      const c = computeBill(good, m,
        { amount: extraAmt, gst_rate: extraRate, discount: discAsked,
          reverseCharge: !!rcharge && !isBuy,
          selfTax:       !!rcharge && isBuy });
      const total = c.total;

      const payload = {
        id: editId || (billId.current || (billId.current = uuid())),
        vtype,
        // A purchase belongs to the date on the supplier's bill. He often
        // enters August's bills in September, and they must land in August.
        // THE DAY IT WENT INTO YOUR BOOKS, NOT THE DAY THEY WROTE IT.
        //
        // A new purchase used to take the SUPPLIER'S bill date as its own.
        // Goods are received in September against a bill written in July, so
        // the entry landed in July's day book and July's GST period — a
        // period already filed. Their date is kept, on its own column, where
        // it belongs for the law and for matching 2B; the books use the day
        // the entry was actually made.
        //
        // Purchases already entered keep the dates they have. Rewriting them
        // would move figures in months that are closed.
        // A SALE CARRIES THE DAY HE SAYS. A purchase carries the day it was
        // entered -- goods received in September against a July bill belong
        // in September, and their own date is kept on its own column.
        // A purchase carries the day it went into the books, which he can now
        // set himself -- it defaults to today, so nothing changes for a man who
        // never touches it. Its own bill date is kept on its own column.
        vdate: vdate || today(),
        party_id: pty?.id || null, printed_name: cust.name, is_cash: isCash,
        supplier_invoice_no: isBuy ? supNo : null,
        supplier_invoice_date: isBuy ? supDate : null,
        // SECTION 10(1)(c): WHERE THE GOODS ARE HANDED OVER.
        //
        // When goods leave the counter with the buyer there is no movement to
        // follow, so the place of supply is the shop, not wherever the buyer
        // happens to live. Skwik used the buyer's state either way, which
        // turned a local sale to a visitor from another state into IGST and
        // reported it in the wrong table of GSTR-1.
        //
        // A cash sale with nobody named on it is a counter sale. A named
        // customer with a GST number is being supplied wherever he is
        // registered, so his state stands.
        place_of_supply_code: placeOfSupply(org, pty, isCash),
        reverse_charge: !!rcharge,
        godown_id: godown || null,
        tax_mode: m,
        taxable: c.taxable, cgst: c.cgst, sgst: c.sgst, igst: c.igst,
        // GSTR-1 Table 8 wants these three apart from the taxable turnover
        nil_rated: c.nil_rated, exempt: c.exempt, non_gst: c.non_gst,
        discount: c.discount,
        extra_amount: extraAmt, extra_note: extraNote, extra_gst_rate: c.extra_gst_rate,
        round_off: c.round_off, total,
        lines: c.lines.map((l) => ({
          item_id: l.item_id, item_name: l.item_name, hsn: l.hsn, unit: l.unit,
          qty: num(l.qty), rate: num(l.rate), gst_rate: l.gst_rate, disc: l.disc || 0,
          // the shelf moves by qty x per; the bill prints qty and unit
          per: num(l.per) || 1,
          supply: l.supply || 'taxable',
          batch: (l.batch || '').trim() || null,
          expiry: (l.expiry || '').trim() || null,
          // Empty means "wherever the bill says": save_voucher falls back to
          // the bill's godown, so an untouched line must send nothing.
          godown_id: l.godown_id || null,
          taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst,
          amount: l.amount, flag: !!l.flag, checked: !!l.checked,
          note: (l.note || '').trim() || null,
        })),
      };
      // Try the server. If there is no signal the bill is written into a
      // queue on this phone with its own number, printed straight away, and
      // sent by itself the next time anything gets through.
      let data, queued = false;
      try {
        const r = await withTimeout(supabase.rpc(
          editId ? 'update_voucher' : 'save_voucher', { p: payload }));
        if (r.error) throw r.error;
        data = r.data;
        wrote = true;
        setOffline(false);
        // We have signal; send anything waiting. If one of those bills could
        // not keep the number that is printed on the customer's copy, that is
        // the one thing he has to hear about, and this is the moment it
        // happens. It used to be worked out and then thrown away.
        flushQueue(supabase).then((out) => {
          const changed = out?.renumbered || [];
          if (!changed.length) return;
          const one = changed[0];
          Alert.alert('A waiting bill has a new number',
            `The copy you handed over says ${one.printed}. That number was `
            + `already used, so your books now hold it as ${one.saved}.`
            + (changed.length > 1 ? `\n\n${changed.length - 1} more changed too.` : '')
            + '\n\nOpen it under Past bills and tell the customer.');
        }).catch(() => {});
      } catch (e) {
        if (!looksOffline(e)) throw e;
        if (editId) {
          throw new Error('Changing a bill needs the internet. '
            + 'This bill is already saved and is safe — try again when you have signal.');
        }
        const localNo = await takeLocalNumber(org, vtype);
        payload.voucher_no = localNo;
        await queueAdd({
          id: payload.id, kind: 'bill', payload,
          newParty: newParty.current, newItems: newItems.current,
        });
        data = { voucher_no: localNo };
        queued = true; wrote = true;
        setOffline(true);
      }

      const rec = {
        voucher: { ...payload, voucher_no: data.voucher_no || supNo,
                   // A WALK-IN HAS NO PARTY ROW AT ALL. pty is null on the
                   // commonest sale in the shop, so every read of it here has
                   // to survive that — the place of supply is simply the shop.
                   place_of_supply_name: (isCash && !pty?.gstin)
                     ? (org?.state_name || pty?.state_name || '')
                     : (pty?.state_name || org?.state_name || '') },
        party: pty, lines: c.lines, queued,
      };
      newParty.current = null; newItems.current = []; billId.current = null;
      if (holdOnly) { setSaved(null); goHome(navigation); }
      else setSaved(rec);
      // The series has moved on. Ask again, so the next bill's number on the
      // bar is the next bill's number and not this one's.
      setPeekNo('');
      askTheNumber();
    } catch (e) {
      // IF THE BOOKS WERE ALREADY WRITTEN, SAYING "could not save" IS A LIE,
      // and he answers it by writing the bill again. Tell him where it stands.
      if (wrote) {
        Alert.alert('The bill is saved',
          'It is in your books. Skwik could not open the send-and-print sheet '
          + 'for it.\n\nFind it under Past bills to print it or send it on '
          + 'WhatsApp. Do not write it again.',
          [{ text: 'OK', onPress: () => goHome(navigation) }]);
      } else {
        Alert.alert('Could not save', sayPlainly(e));
      }
    } finally { setBusy(false); }
  };

  // A4 for the file, a roll for the counter. The shop says which in Settings.
  const paper = String(org?.print_width || 'a4');
  const html = () => (paper === 'a4'
    ? invoiceHtml({ org, voucher: saved.voucher, party: saved.party, lines: saved.lines })
    : thermalHtml({ org, voucher: saved.voucher, party: saved.party, lines: saved.lines,
                    width: paper }));
  // Pratik_59 — who it is for, and which bill. Not a row of random hex.
  const billFileName = () => {
    const v = saved?.voucher || {};
    return pdfName({
      who: cust?.name || v.printed_name || org?.name,
      no: v.voucher_no || supNo,
      fallback: org?.name || 'Bill',
    });
  };

  const onShare = async () => {
    const { uri } = await Print.printToFileAsync({ html: html() });
    await sharePdf(uri, billFileName());
  };

  // DOWNLOAD MEANS THE FILE IS ON HIS PHONE, NOT THAT A SHEET OPENED.
  //
  // This button used to do exactly what Send does: open the sharing sheet and
  // leave him to find something in it that means "keep it". Now the bill goes
  // into his Download folder and the message says where. Android asks him to
  // point at the folder once, ever; after that it is silent.
  const onDownload = async () => {
    try {
      const name = billFileName();
      const { uri } = await Print.printToFileAsync({ html: html() });
      const r = await saveToDownloads(uri, name);
      if (r.saved) {
        return Alert.alert('Saved on this phone',
          `${name} is in your ${folderName(r.where)} folder.`);
      }
      if (r.why === 'cancelled') return;      // he backed out; he knows he did
      // No folder to write into — an iPhone, or the phone refused. The sheet
      // is the honest fallback, and he is told why he is looking at it.
      Alert.alert('Choose where to keep it',
        r.why === 'unsupported'
          ? 'This phone does not let an app write into a folder by itself, so '
            + 'pick where the bill should go.'
          : `The bill could not be written to the folder — ${r.why}. Pick where `
            + 'it should go instead.',
        [{ text: 'Not now' },
         { text: 'Choose', onPress: () => sharePdf(uri, name).catch(() => {}) }]);
    } catch (e) {
      Alert.alert('Could not save the bill', sayPlainly(e));
    }
  };

  // THE PDF, STRAIGHT INTO WHATSAPP.
  //
  // Android can be told which app a file is going to, so the general sharing
  // sheet — WhatsApp, Gmail, Drive, Bluetooth, twenty icons — can be skipped
  // and WhatsApp opened directly with the bill already attached.
  //
  // What it still cannot do is choose the chat. Android gives no way to name
  // a recipient AND carry a file in the same breath; WhatsApp asks. So this
  // saves the sheet, not the tap. On anything that is not Android, or if
  // WhatsApp is not installed, it falls back to the sheet rather than failing.
  const onWhatsAppPdf = async () => {
    try {
      const { uri } = await Print.printToFileAsync({ html: html() });
      if (Platform.OS !== 'android') {
        return sharePdf(uri, billFileName());
      }
      // a name the customer will recognise in his chat
      const sendUri = renamed(uri, billFileName());

      const content = await FileSystem.getContentUriAsync(sendUri);
      await IntentLauncher.startActivityAsync('android.intent.action.SEND', {
        type: 'application/pdf',
        packageName: 'com.whatsapp',
        extra: { 'android.intent.extra.STREAM': content },
        flags: 1,                       // FLAG_GRANT_READ_URI_PERMISSION
      });
    } catch (e) {
      // no WhatsApp, or it refused the handover: the ordinary sheet still works
      try {
        const { uri } = await Print.printToFileAsync({ html: html() });
        await sharePdf(uri, billFileName());
      } catch (e2) {
        Alert.alert('Could not send it', sayPlainly(e2));
      }
    }
  };

  // The plain-text route to a named chat used to live here. It could open
  // the customer's own conversation, which the PDF route cannot — but all it
  // could carry was six typed lines, and a bill nobody can keep is not worth
  // the biggest button on the screen. If it is ever wanted back, the trick
  // was: whatsapp://send?phone=<91xxxxxxxxxx>&text=<the lines>

  // A PRINT THAT FAILS MUST SAY SO. With no catch here, tapping Print with no
  // printer set up on the phone did nothing at all — no paper, no message —
  // and he had no way to tell whether the customer's copy had gone out.
  const onPrint = async () => {
    try { await Print.printAsync({ html: html() }); }
    catch (e) { Alert.alert('Could not print', sayPlainly(e)); }
  };

  // What this bill will be numbered. An edit already has its number; a new
  // one gets the next in the series, with the prefix and the year the shop
  // has set, the same shape takeLocalNumber and the server both produce.
  // THE NUMBER ON THE BAR IS THE NUMBER THAT GETS PRINTED.
  //
  // "In top Bar we see new Bill No 26-27/1, but we actually print other
  // number." It was guessing, out of the copy of the firm the app loaded when
  // it started -- and nothing reloads that after a bill is saved, so it said
  // 26-27/1 for every bill written all session while the server handed out
  // 1, 2, 3, 4. Three more ways the guess could be wrong even when fresh:
  //
  //   · it used the phone's idea of today while the server keys the series off
  //     the BILL's date, so a bill backdated to 31 March got 25-26/n
  //   · sales and estimates share one uniqueness check but count separately, so
  //     an estimate numbered 5 makes the next sale skip past 5 in silence
  //   · an offline bill and an imported bill both advance the real series
  //     without touching the figure the guess was reading
  //
  // So it asks the server instead. peek_invoice_no() is the allocator's twin
  // with every write taken out -- same year, same prefix, same rules, and it
  // consumes nothing, so it can be asked as often as the screen likes. It is
  // asked when the screen comes to the front, when the bill's date moves, and
  // after each save.
  //
  // The old guess is still here as a fallback, for a phone updated ahead of its
  // database. A number that is sometimes wrong beats no number at all.
  const [peekNo, setPeekNo] = useState('');
  const guessNo = useMemo(() => {
    const est = vtype === 'estimate';
    const n = Number(est ? org?.next_estimate_no : org?.next_invoice_no) || 0;
    if (!n) return '';
    let pre = (est ? org?.estimate_prefix : org?.invoice_prefix) || '';
    if (org?.restart_each_year && org?.year_in_prefix !== false) {
      const d = new Date();
      const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
      pre += `${String(y).slice(2)}-${String(y + 1).slice(2)}/`;
    }
    return `${pre}${n}`;
  }, [vtype, org?.next_invoice_no, org?.next_estimate_no,
      org?.invoice_prefix, org?.estimate_prefix, org?.restart_each_year, org?.year_in_prefix]);

  const askTheNumber = useCallback(async () => {
    if (editId || isBuy) return;
    try {
      const { data, error } = await supabase.rpc('peek_invoice_no',
        { p_date: vdate || today(), p_kind: vtype === 'estimate' ? 'estimate' : 'sale' });
      if (!error && data) setPeekNo(String(data));
    } catch (e) { /* no signal: the guess below stands */ }
  }, [editId, isBuy, vtype, vdate]);

  useFocusEffect(useCallback(() => { askTheNumber(); }, [askTheNumber]));

  const nextNo = useMemo(() => {
    if (editId) return loadedNo || '';
    if (isBuy) return '';
    return peekNo || guessNo;
  }, [editId, loadedNo, isBuy, peekNo, guessNo]);

  const docName = editId
    ? (vtype === 'estimate' ? 'Editing estimate' : isBuy ? 'Editing purchase' : 'Editing bill')
    : (vtype === 'estimate' ? 'Estimate' : isBuy ? 'Purchase' : 'New Bill');

  /* ---------------- going back ---------------- */

  // One way out, used by both the arrow and the phone's own back button, so the
  // two never disagree. A bill with lines on it is never thrown away silently.
  // THE PHONE'S BACK BUTTON, WITH THE CURSOR IN A BOX.
  //
  // "When cursor is on top name bar, and we press back button, we are unable
  // to do that." Quite: every branch below returns true, which tells Android
  // the press has been dealt with -- and React Native only closes the keyboard
  // on back when nothing else claims the press. So with the cursor in the item
  // box, back either did nothing he could see or threw up "Leave this bill?"
  // over a bill he was in the middle of writing, and there was no way to just
  // put the keyboard away.
  //
  // Back now does what it does everywhere else on a phone: the first press
  // closes the keyboard, the second leaves. `hardware` is true only for the
  // phone's own button -- tapping the arrow at the top of the screen means
  // leave, and always did.
  const leave = (hardware) => {
    if (hardware && keyGap > 0) { Keyboard.dismiss(); return true; }
    if (quick)          { setQuick(null);   return true; }
    if (swapFor != null){ setSwapFor(null); return true; }
    if (saved)          { return true; }              // already saved: use Done
    if (custOpen) {
      if (!cust) { navigation.goBack(); return true; } // no customer picked yet
      setCustOpen(false); return true;
    }
    // An old bill nobody touched goes back without a word.
    if (editId && !changedSince()) { navigation.goBack(); return true; }
    if (lines.length && (!editId || changedSince())) {
      Alert.alert(editId ? 'Unsaved changes' : 'Leave this bill?',
        editId
          ? 'What you have changed on this bill has not been saved.'
          : `${lines.length} line${lines.length > 1 ? 's' : ''} will be lost.`,
        [{ text: 'Stay on the bill' },
         { text: editId ? 'Throw the changes away' : 'Leave', style: 'destructive',
           onPress: () => navigation.goBack() }]);
      return true;
    }
    navigation.goBack();
    return true;
  };

  // ONLY WHILE THIS SCREEN IS THE ONE IN FRONT.
  //
  // A bill screen stays alive underneath whatever is opened on top of it, so a
  // listener registered for as long as it is mounted goes on answering the
  // phone's back button from the ledger, from Stock, from anywhere — which is
  // how "Leave this bill?" ended up appearing on screens that have no bill on
  // them. useFocusEffect ties it to being in front instead of to being alive.
  //
  // The handler is read through a ref so it always runs the newest `leave`
  // without the listener being torn down and rebuilt on every keystroke.
  // ONCE A NAME IS PICKED the cursor goes to the goods, and chooseCust,
  // startWalkIn and newCust each do that themselves -- one call, from the thing
  // that knows the name has been settled. An effect here as well would be two
  // things reaching for the cursor on one tap.

  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress',
      () => leaveRef.current(true));
    return () => sub.remove();
  }, []));

  /* ---------------- screen ---------------- */

  return (
    <Screen ruler={!!org?.debug_keyboard}>

      {/* PINNED HEAD — who it is for, and what it comes to.
          It goes to one slim line while the keyboard is up: the second line
          and the running total are both repeated at the foot, and every pixel
          of furniture up here is a pixel of his own bill he cannot see. */}
      {/* only the BOTTOM padding is trimmed: the top is the notch, and taking
          that would put the name under the status bar */}
      <Bar style={keyGap > 0 ? { paddingBottom: 6 } : null}>
        <BackButton navigation={navigation} onPress={leave} />
        {/* THE NAME IS NOT A TITLE, SO IT NO LONGER SITS WHERE A TITLE SITS.
            It was up here on the dark bar, in the same place and the same
            type as the screen's own heading — so it read as furniture, and a
            box he has to fill in before he can save looked like a label. It
            is a field now, in the page, above the goods, where he can see it
            is waiting for him. The bar is left doing what a bar does: which
            document this is, its number, and what it comes to. */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={S.barName}>
            {docName}
          </Text>
          {/* THE NUMBER AND THE NAME, ON ONE LINE, WITH A PENCIL.
              *
              * Once a name is on the bill the card below goes away, so this is
              * where the name lives -- beside the bill number, where he can see
              * it without it costing a line of the goods, and tappable for the
              * one bill in fifty made out to the wrong man. The pencil is there
              * so it reads as something that can be changed rather than as a
              * heading. */}
          <TouchableOpacity onPress={() => { setCq(''); setCustOpen(true); }}
            disabled={!cust}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text numberOfLines={1} style={S.barSub}>
              {nextNo || ''}
              {nextNo && cust ? '  ·  ' : ''}
              {cust
                ? `${isCash ? `CASH ${cust.name}`.replace(/^CASH CASH$/, 'CASH') : cust.name}  ✎`
                : ''}
            </Text>
          </TouchableOpacity>
        </View>
        {/* CASH OR UDHAR, SAID OUT LOUD.
            This was decided only by whether he happened to type "cash" in
            front of the name. A regular customer who paid at the counter was
            booked as udhar, his ledger said he owed money he had already
            handed over, and nothing on the screen ever said so. Now it is on
            the bar, in two words, and one tap changes it. */}
        {!!cust && !cust.walkIn && !estimateMode && (
          <TouchableOpacity onPress={() => setIsCash((v) => !v)}
            hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
            style={{ paddingHorizontal: 11, paddingVertical: 8, borderRadius: 999,
                     marginRight: 8,
                     backgroundColor: isCash ? C.greenL : C.flagSoft }}>
            <Text style={{ fontSize: 12, fontWeight: '800', letterSpacing: 0.3,
                           color: isCash ? C.green : C.flagInk }}>
              {isCash ? 'PAID' : (isBuy ? 'UNPAID' : 'UDHAR')}
            </Text>
          </TouchableOpacity>
        )}
        {keyGap === 0 && <ScanButton light onPress={() => setScanOpen(true)} />}
        {keyGap === 0 && (
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={S.barTotL}>TOTAL</Text>
            <Text style={[S.barTot, S.num]}>₹{fmt0(grand)}</Text>
          </View>
        )}
      </Bar>

      {offline && (
        <View style={{ backgroundColor: C.flagSoft, borderBottomWidth: 1,
                       borderBottomColor: C.flagLine, paddingHorizontal: 12, paddingVertical: 7 }}>
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.flagInk }}>
            No internet — carry on billing. It sends itself when the line comes back.
          </Text>
        </View>
      )}

      {/* A SUPPLIER'S BILL IS READ FROM THE TOP: his name, his bill number,
          its date, then the goods. Asking for the number at the end meant
          finding the paper again after the typing was done. */}
      {/* THE DAY THE GOODS WENT OUT.
          It shows at all times so he can see what the bill is dated, and it
          only offers to be changed when there is more than one day he could
          honestly choose. When the window is a single day there is nothing
          to pick, so there is no button to press and nothing to wonder
          about. */}
      {!isBuy && !!win && (
        <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                       borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={[S.row, { alignItems: 'center', gap: 10 }]}>
            <Text style={[S.cellLabel, { flex: 0 }]}>DATED</Text>
            <Text style={[{ fontSize: 15, fontWeight: '700', color: C.ink }, S.num]}>
              {showDate(vdate)}
            </Text>
            {win.from !== win.to && (
              <TouchableOpacity onPress={() => setDateCal(true)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={{ fontSize: 13.5, fontWeight: '800', color: C.green }}>
                  change
                </Text>
              </TouchableOpacity>
            )}
            <View style={{ flex: 1 }} />
            {vdate !== win.to && (
              <Text style={{ fontSize: 11.5, fontWeight: '700', color: C.muted }}>
                not today
              </Text>
            )}
          </View>
        </View>
      )}

      {/* THE HEAD OF A PURCHASE, FOLDED AWAY ONCE IT IS WRITTEN.
          *
          * "Once we enter suppliers Bill Number, Date, Supplier Name, we should
          * be able to press done, and this hides the fields, and small edit
          * button appears, so that if we need to change anything, we can
          * reactivate that field, doing this will give us more space."
          *
          * Three boxes and two lines of explanation sat above the goods for the
          * whole of a purchase -- a third of a phone screen, on the one entry
          * where the list of goods is longest. They are filled in once, at the
          * start, off the paper in his hand, and then they are just furniture.
          *
          * So: Done folds them into one line, and the line can be tapped to
          * open them again. It folds itself when he moves to the goods, because
          * a man who has started typing item names has finished with the header
          * whether or not he pressed anything.
          */}
      {isBuy && !!cust && !headOpen && (
        <TouchableOpacity onPress={() => setHeadOpen(true)}
          style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                   borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={[S.row, { alignItems: 'center', gap: 8 }]}>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 12.5, color: C.muted }}>
              <Text style={{ fontWeight: '800', color: C.ink }}>{cust.name}</Text>
              {supNo ? `  \u00b7  his bill ${supNo}` : '  \u00b7  no bill number'}
              {supDate ? `  \u00b7  ${showDate(supDate)}` : ''}
              {vdate && vdate !== today() ? `  \u00b7  entered ${showDate(vdate)}` : ''}
            </Text>
            <Text style={{ fontSize: 12.5, fontWeight: '800', color: C.green }}>edit</Text>
          </View>
        </TouchableOpacity>
      )}

      {isBuy && !!cust && headOpen && (
        <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingTop: 10,
                       paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={[S.row, { gap: 10, alignItems: 'flex-start' }]}>
            <View style={{ flex: 1.2 }}>
              <Text style={S.cellLabel}>His bill number</Text>
              <TextInput style={S.cell} value={supNo} onChangeText={setSupNo}
                placeholder="e.g. 1024" placeholderTextColor={C.faint}
                autoCapitalize="characters"
                returnKeyType="next" submitBehavior="submit" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={S.cellLabel}>Its date</Text>
              <View style={[S.row, { gap: 6 }]}>
                <TextInput style={[S.cell, S.num, { flex: 1 }]} value={supDateText}
                  onChangeText={setSupDateText}
                  onBlur={() => { const d = parseDate(supDateText);
                                  if (d) setSupDateText(showDate(d)); }}
                  placeholder="19-09-2026" placeholderTextColor={C.faint}
                  keyboardType="numbers-and-punctuation"
                  returnKeyType="next" submitBehavior="submit"
                  onSubmitEditing={() => qRef.current?.focus()} />
                <TouchableOpacity onPress={() => setSupCal(true)}
                  style={{ width: 40, height: 40, borderRadius: 9, borderWidth: 1,
                           borderColor: C.line, backgroundColor: C.surface,
                           alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 17 }}>📅</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
          {/* AND THE DAY IT GOES INTO HIS OWN BOOKS.
              *
              * "Also we should be able to provide date of entry, as we might
              * enter transaction in some other date." A purchase has always
              * taken the day it was entered, on purpose -- a July bill entered
              * in September belongs in September, not back in a filed month --
              * but "the day it was entered" was whatever day he got to the
              * phone. Goods received on Saturday and typed on Monday belonged
              * to Saturday. So it is a figure he can set, defaulting to today,
              * fenced by the same rules a sale's date is: nothing in a month he
              * has closed, and nothing in the future.
              */}
          <View style={[S.row, { alignItems: 'center', gap: 10, marginTop: 4,
                                 marginBottom: 8 }]}>
            <Text style={[S.cellLabel, { flex: 0 }]}>ENTERED</Text>
            <Text style={[{ fontSize: 14.5, fontWeight: '700', color: C.ink }, S.num]}>
              {showDate(vdate)}
            </Text>
            <TouchableOpacity onPress={() => setDateCal(true)}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: C.green }}>change</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            {vdate !== today() && (
              <Text style={{ fontSize: 11.5, fontWeight: '700', color: C.muted }}>not today</Text>
            )}
          </View>

          <Text style={[S.hint, { marginBottom: 6 }]}>
            His bill's own date is for the law and for matching 2B. Your books use
            the ENTERED day, so a July bill entered now does not land back in July.
          </Text>

          <TouchableOpacity onPress={() => { setHeadOpen(false); qRef.current?.focus(); }}
            style={{ alignSelf: 'flex-start', marginBottom: 10, paddingHorizontal: 14,
                     paddingVertical: 8, borderRadius: 9, borderWidth: 1,
                     borderColor: C.accent, backgroundColor: C.accentSoft }}>
            <Text style={{ fontSize: 13, fontWeight: '800', color: C.accent }}>
              Done — on to the goods
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* THE ENTRY LINE — one box, product and quantity together.
          Its key is the arrow, not the tick: every box on a bill carries you
          forward to the next one, so they all show the same thing.
          It is here from the first moment now: the bill opens on the goods,
          and the name is a bar at the top that can be filled in at any point
          before it is saved. */}
      {(
        <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                       borderBottomWidth: 1, borderBottomColor: C.line }}>

          <TextInput
            ref={qRef}
            style={S.input}
            placeholder="Type item and quantity — thali 12"
            placeholderTextColor={C.faint}
            value={q} onChangeText={setQ}
            returnKeyType="next" submitBehavior="submit"
            onSubmitEditing={takeSel}
            // Tab, for the shops billing off a laptop with a keyboard plugged
            // in. It confirms whatever the rail is sitting on, exactly as the
            // OK button does.
            onKeyPress={(e) => {
              const k = e?.nativeEvent?.key;
              if (k === 'Tab') { e.preventDefault?.(); takeSel(); }
              else if (k === 'ArrowDown') { e.preventDefault?.(); walk(); }
            }} />

          {/* THE NAME, ON THE PAGE, WITH THE NAMES UNDER IT.
              *
              * Shown only while the bill has no name on it. The moment one is
              * picked this whole card goes, the name appears in the title bar
              * with a pencil beside it, and the goods have the screen. */}
          {!cust && (
            <View style={{ marginTop: 10, borderWidth: 1.5, borderColor: C.line,
                           borderRadius: 12, backgroundColor: C.card,
                           paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 }}>
              <Text style={{ fontSize: 10.5, letterSpacing: 0.8, fontWeight: '700',
                             color: C.muted }}>
                {isBuy ? 'SUPPLIER' : 'CUSTOMER'}
              </Text>
              {custPicker({ inline: true })}
            </View>
          )}

          {/* A CODE STILL LOOKING FOR ITS ITEM.
              He said "find the item", the sheet shut, and then there was
              nothing on the screen to say why he was being asked to type a
              name — so he typed one, the code went quietly onto that item, and
              he never knew it had. Now it says so while he looks, and he can
              drop it if he picked up the wrong packet. */}
          {!!pendingCode && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
                           marginTop: 7 }}>
              <Text style={{ flex: 1, fontSize: 11.5, color: C.edit, lineHeight: 16 }}>
                Barcode <Text style={S.num}>{pendingCode}</Text> goes onto whichever
                item you pick next.
              </Text>
              <TouchableOpacity onPress={() => setPendingCode('')}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={{ fontSize: 11.5, fontWeight: '800', color: C.muted }}>DROP IT</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* THE PRICE LIST IS NOT A QUESTION ABOUT THIS BILL.
              Two buttons sat here, above the goods, on every counter sale —
              and the answer was the same every time, because it is a fact
              about the CUSTOMER and every customer already carries it on his
              own row. The stranger paying cash is the one who does not, and
              that is now said once in Settings instead of forty times a day.
              What is left is a line saying which rates are being used, and it
              can still be tapped on the odd bill that needs the other one. */}
          {isOut && (
            <TouchableOpacity onPress={() => applyList(priceList === 1 ? 2 : 1)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={{ paddingTop: 7 }}>
              <Text style={{ fontSize: 11.5, color: C.muted }}>
                {priceList === 1 ? (org?.price1_name || 'Wholesale') : (org?.price2_name || 'Retail')}
                {' rates'}
                {cust?.price_list ? ` · ${cust.name}'s list` : ''}
                <Text style={{ color: C.accent, fontWeight: '700' }}>
                  {'   use '}
                  {priceList === 1 ? (org?.price2_name || 'Retail') : (org?.price1_name || 'Wholesale')}
                </Text>
              </Text>
            </TouchableOpacity>
          )}

          {/* WHICH STORE THESE FIGURES ARE, SAID ONCE.
              Every row used to end in the word "here", forty times down a list,
              and "here" never said where here was. The store is named once
              above the list instead, and the rows are left to be figures. */}
          {!!q.trim() && godowns.length >= 2 && !!stock?.byStore && !!godown && (
            <Text style={{ fontSize: 11, color: C.muted, marginTop: 7 }}>
              {'Billing from '}
              <Text style={{ fontWeight: '800', color: C.ink }}>{godownName(godown)}</Text>
              {' \u00b7 tap a figure to see where the rest is'}
            </Text>
          )}

          {!!q.trim() && (
            <View style={{ marginTop: 6, maxHeight: 280, borderWidth: 1, borderColor: C.line,
                           borderRadius: 9, backgroundColor: C.surface, overflow: 'hidden' }}>
              <ScrollView ref={hitsRef} keyboardShouldPersistTaps="handled"
                scrollEventThrottle={16}
                onLayout={(e) => { boxH.current = e.nativeEvent.layout.height; }}
                onScroll={(e) => { seenY.current = e.nativeEvent.contentOffset.y; }}>
                {hits.map((h, hi) => (
                  <View key={h.p.id}
                    onLayout={(e) => {
                      const { y, height } = e.nativeEvent.layout;
                      rowAt.current[hi] = { y, h: height };
                    }}>
                  <TouchableOpacity onPress={() => addHit(h)}
                    style={[S.hit, wantRail && hi === at && {
                      backgroundColor: C.accentSoft,
                      borderLeftWidth: 3, borderLeftColor: C.accent,
                      paddingHorizontal: 11 }]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={[S.row, { gap: 6 }]}>
                        <Marked text={h.p.name} toks={h.toks} style={[S.hitName, { flexShrink: 1 }]} />
                        {h.qty != null && (
                          <Text style={[S.qbadge, S.num]}>&times; {h.qty}</Text>
                        )}
                      </View>
                      <Text numberOfLines={1} style={S.hitSub}>
                        {uqcShort(h.p.unit)}{h.p.alias ? ` · ${h.p.alias}` : ''}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      {(() => {
                        const here = haveOf(h.p.id);
                        // not a stock shop, or the figures have not landed:
                        // the rate, exactly as it always was
                        if (here === null) return (
                          <>
                            <Text style={[S.hitPr, S.num]}>{fmt0(listRate(h.p))}</Text>
                            <Text style={{ fontSize: 10, color: C.muted }}>
                              {priceList === 1 ? (org?.price1_name || 'Wholesale')
                                               : (org?.price2_name || 'Retail')}
                            </Text>
                          </>
                        );
                        // WHERE IT IS, BEHIND A TAP.
                        //
                        // He picked this shape out of five. The row stays a row
                        // -- one figure, this store's -- and what is at the
                        // other store waits behind a small word he can tap,
                        // instead of a second figure competing with the first on
                        // every line of a list he reads forty times a day.
                        //
                        // "elsewhere" is gone. It was the one word that hid the
                        // answer: it never said WHICH store, and it counted
                        // goods sitting at no store at all, so a row could
                        // offer 46 elsewhere and then no store to fetch them
                        // from.
                        const where = whereItIs(h.p.id).filter((g) => g.qty > 0);
                        const others = where.filter((g) => g.id !== godown);
                        const many = godowns.length >= 2 && stock.byStore;
                        return (
                          <>
                            <Text style={[S.hitPr, S.num, here <= 0 && { color: C.red }]}>
                              {qty(here)}
                            </Text>
                            <Text style={{ fontSize: 10, color: here <= 0 ? C.red : C.muted }}>
                              {uqcShort(h.p.unit)}
                            </Text>
                            {many && (
                              <TouchableOpacity
                                onPress={() => setWhereOpen(whereOpen === h.p.id ? null : h.p.id)}
                                hitSlop={{ top: 8, bottom: 8, left: 10, right: 10 }}>
                                <Text style={{ fontSize: 10, marginTop: 2, fontWeight: '700',
                                               color: others.length ? C.accent : C.faint }}>
                                  {!where.length ? 'nowhere'
                                    : !others.length ? 'here only'
                                    : `${others.length + (here > 0 ? 1 : 0)} store${
                                        others.length + (here > 0 ? 1 : 0) === 1 ? '' : 's'} ${'\u203A'}`}
                                </Text>
                              </TouchableOpacity>
                            )}
                          </>
                        );
                      })()}
                    </View>
                  </TouchableOpacity>

                  {/* AND WHAT IS BEHIND THE TAP.
                      *
                      * Every store that has any of it, with how much, and a
                      * button that writes the line against that store -- so
                      * "we generally won't bill them" stops being true: the
                      * goods at the other store are one tap from being on this
                      * bill, with the store already set on the line.
                      *
                      * It opens only for the row he asked about, and closes when
                      * he asks again or picks anything, so the list never grows
                      * two panels deep.
                      */}
                  {whereOpen === h.p.id && (() => {
                    const where = whereItIs(h.p.id).filter((g) => g.qty > 0);
                    const loose = num(stock.all[h.p.id] || 0)
                                - where.reduce((t, g) => t + g.qty, 0);
                    return (
                      <View style={{ paddingHorizontal: 12, paddingBottom: 11, marginTop: -2,
                                     borderTopWidth: 1, borderTopColor: C.line, paddingTop: 9 }}>
                        {!where.length && (
                          <Text style={{ fontSize: 12, color: C.muted }}>
                            None of this at any store.
                          </Text>
                        )}
                        {where.map((g) => {
                          const isHere = g.id === godown;
                          return (
                            <View key={g.id} style={[S.row, { alignItems: 'center', gap: 10,
                                                              paddingVertical: 4 }]}>
                              <Text numberOfLines={1}
                                style={{ flex: 1, fontSize: 12.5, fontWeight: '700', color: C.ink }}>
                                {g.name}{isHere ? '  (billing from here)' : ''}
                              </Text>
                              <Text style={[{ fontSize: 12.5, color: C.ink }, S.num]}>
                                {qty(g.qty)} {uqcShort(h.p.unit)}
                              </Text>
                              <TouchableOpacity onPress={() => { setWhereOpen(null); addHit(h, g.id); }}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                style={{ paddingHorizontal: 9, paddingVertical: 5, borderRadius: 7,
                                         borderWidth: 1, borderColor: C.accent,
                                         backgroundColor: C.accentSoft }}>
                                <Text style={{ fontSize: 11, fontWeight: '800', color: C.accent }}>
                                  {isHere ? 'Add' : 'Bill from here'}
                                </Text>
                              </TouchableOpacity>
                            </View>
                          );
                        })}
                        {loose > 0.0001 && (
                          <Text style={{ fontSize: 11, color: C.muted, marginTop: 5, lineHeight: 16 }}>
                            {qty(loose)} {uqcShort(h.p.unit)} is not at any store yet — set a store
                            on it under Stock before you bill it from one.
                          </Text>
                        )}
                      </View>
                    );
                  })()}
                  </View>
                ))}
                <TouchableOpacity
                  onPress={() => setQuick({ name: parsed.base || parsed.full, alias: '', unit: 'PCS',
                                            hsn: '', gst_rate: '', rate: '',
                                            rate2: '', other: '', opening_stock: '',
                                            qty: parsed.qty == null ? '' : String(parsed.qty) })}
                  style={{ paddingVertical: 12, paddingHorizontal: 12, backgroundColor: C.soft }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: C.accent }}>
                    + Add “{parsed.base || parsed.full}” as a new item
                  </Text>
                </TouchableOpacity>
              </ScrollView>

            </View>
          )}
        </View>
      )}

      {/* the strip that names the columns, the way a ruled book does */}
      {!!lines.length && (
        <ColHead cols={[{ label: 'PARTICULARS' },
                        { label: 'QTY \u00D7 RATE', width: 118 },
                        { label: 'AMOUNT', width: 74 }]} />
      )}

      <ScrollView keyboardShouldPersistTaps="handled"
                  style={{ flex: 1 }}
                  contentContainerStyle={{ paddingBottom: 30 }}>

        {!lines.length && (
          <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center',
                         marginTop: 40, paddingHorizontal: 24, lineHeight: 20 }}>
            Type an item above. Put the quantity after it — “thali 12” — and it
            goes straight in.
          </Text>
        )}

        {lines.map((l) => {
          const amt = num(l.qty) * num(l.rate);
          return (
            <View key={l.key} style={{
              backgroundColor: l.flag ? C.flagSoft : l.checked ? C.okSoft : C.surface,
              borderBottomWidth: 1, borderBottomColor: C.line,
              borderLeftWidth: (l.flag || l.checked) ? 3 : 0,
              borderLeftColor: l.flag ? C.flag : C.ok,
              paddingHorizontal: 14, paddingVertical: 12 }}>

              {/* the name line: what it is, and the two things you can do to it */}
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6,
                             marginBottom: 12 }}>
                <TouchableOpacity onPress={() => toggleCheck(l.key)}
                  accessibilityLabel="I have re-checked this line"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
                  style={{ width: 24, height: 24, borderWidth: 1.5, borderRadius: 7,
                           alignItems: 'center', justifyContent: 'center', marginTop: 1,
                           borderColor: l.checked ? C.ok : C.greyB,
                           backgroundColor: l.checked ? C.ok : 'transparent' }}>
                  <Text style={{ fontSize: 14, fontWeight: '700',
                                 color: l.checked ? '#fff' : C.greyB }}>✓</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => toggleFlag(l.key)}
                  accessibilityLabel="Highlight this line on the bill"
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  style={{ paddingHorizontal: 2 }}>
                  <Text style={{ fontSize: 20, color: l.flag ? C.flag : C.greyB }}>
                    {l.flag ? '★' : '☆'}
                  </Text>
                </TouchableOpacity>

                <View style={{ flex: 1, minWidth: 0, paddingLeft: 2 }}>
                  <Text numberOfLines={2} style={S.lineNm}>{l.item_name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <TouchableOpacity style={S.tapPill} hitSlop={S.pillSlop}
                      onPress={() => { setSwapFor(swapFor === l.key ? null : l.key); setSq(''); }}>
                      <Text style={S.tapPillText}>change</Text>
                    </TouchableOpacity>
                    {/* THE UNIT, AND — WHEN THE ITEM SELLS TWO WAYS — A TAP
                        TO SWITCH IT.
                        *
                        * A customer takes two dozen spoons; the next takes
                        * fifteen. Tapping the pill changes what the bill SAYS
                        * and what it charges; what comes off the shelf follows
                        * the factor, so two dozen is twenty-four pieces either
                        * way. The quantity is left as it is rather than
                        * converted — he is about to type it anyway, and a
                        * figure that changes under his thumb is worse than one
                        * he retypes.
                        */}
                    {l.altUnit && l.altPer > 0 ? (
                      <TouchableOpacity style={S.tapPill} hitSlop={S.pillSlop}
                        onPress={() => {
                          const toAlt = num(l.per) === 1;
                          setLine(l.key, toAlt
                            ? { unit: l.altUnit, per: l.altPer,
                                rate: String(l.altRate
                                  || Math.round(num(l.stockRate) * l.altPer * 100) / 100),
                                rateEdited: true }
                            : { unit: l.stockUnit, per: 1,
                                rate: String(l.stockRate || ''), rateEdited: true });
                        }}>
                        <Text style={S.tapPillText}>
                          {uqcShort(l.unit)}
                          {num(l.per) > 1 ? ` \u00B7 ${qty(l.per)} ${uqcShort(l.stockUnit)}` : ''}
                          {'  \u21C4'}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <Text style={S.unitPill}>{uqcShort(l.unit)}</Text>
                    )}

                    {/* NIL-RATED, EXEMPT, OR OUTSIDE GST.
                        Most of a kirana counter is not taxable: milk, bread,
                        fresh produce. Billed as an ordinary 0% line they land
                        in the taxable turnover and leave Table 8 of the return
                        empty. The item master usually knows already; this is
                        here for the times it does not. Tap to cycle. */}
                    {org?.is_gst_registered && !org?.is_composition && !estimateMode && (
                      <TouchableOpacity
                        onPress={() => {
                          const i = SUPPLY_KINDS.findIndex((k) => k.key === supplyOf(l));
                          setLine(l.key, {
                            supply: SUPPLY_KINDS[(i + 1) % SUPPLY_KINDS.length].key,
                          });
                        }}
                        style={[S.tapPill, supplyOf(l) !== 'taxable' && {
                          backgroundColor: C.flagSoft, borderColor: C.flag }]}>
                        <Text style={[S.tapPillText, supplyOf(l) !== 'taxable' && {
                          color: C.flag, fontWeight: '800' }]}>
                          {supplyOf(l) === 'taxable'
                            ? `${pct(l.gst_rate)}%`
                            : supplyShort(l.supply)}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                <TouchableOpacity onPress={() => removeLine(l.key)} accessibilityLabel="Remove line"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ paddingHorizontal: 4 }}>
                  <Text style={{ fontSize: 22, color: C.danger }}>×</Text>
                </TouchableOpacity>
              </View>

              {swapFor === l.key && (
                <View style={{ marginBottom: 9 }}>
                  <TextInput style={[S.input, { paddingVertical: 9 }]} autoFocus
                    placeholder="Change to another item — balty 5" value={sq} onChangeText={setSq}
                    returnKeyType="next" submitBehavior="submit"
                    onSubmitEditing={() => { if (swapHits.length) doSwap(swapHits[0]); }} />
                  <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled">
                    {swapHits.map((h) => {
                      const here = haveOf(h.p.id);
                      const where = whereItIs(h.p.id).filter((g) => g.qty > 0);
                      const others = where.filter((g) => g.id !== godown);
                      return (
                        <View key={h.p.id}
                          style={{ borderBottomWidth: 1, borderBottomColor: C.line }}>
                          <TouchableOpacity onPress={() => doSwap(h)}
                            style={[S.row, { paddingVertical: 10, gap: 8, alignItems: 'center' }]}>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <View style={[S.row, { gap: 6 }]}>
                                <Marked text={h.p.name} toks={h.toks}
                                  style={[{ fontSize: 14.5, fontWeight: '700', color: C.ink,
                                            flexShrink: 1 }]} />
                                {h.qty != null && (
                                  <Text style={[S.qbadge, S.num]}>&times; {h.qty}</Text>
                                )}
                              </View>
                              <Text numberOfLines={1} style={S.hitSub}>
                                {uqcShort(h.p.unit)}{h.p.alias ? ` \u00b7 ${h.p.alias}` : ''}
                              </Text>
                            </View>
                            {here !== null ? (
                              <View style={{ alignItems: 'flex-end' }}>
                                <Text style={[{ fontSize: 14, fontWeight: '700' }, S.num,
                                              here <= 0 && { color: C.red }]}>
                                  {qty(here)}
                                </Text>
                                <Text style={{ fontSize: 10, color: here <= 0 ? C.red : C.muted }}>
                                  {uqcShort(h.p.unit)}
                                </Text>
                              </View>
                            ) : (
                              <Text style={[{ fontSize: 14, color: C.muted }, S.num]}>
                                {fmt0(listRate(h.p))}
                              </Text>
                            )}
                          </TouchableOpacity>
                          {/* and the other store, one tap away, same as the bar */}
                          {here !== null && here <= 0 && !!others.length && (
                            <View style={[S.row, { gap: 6, flexWrap: 'wrap', paddingBottom: 9,
                                                   marginTop: -3 }]}>
                              {others.slice(0, 2).map((g) => (
                                <TouchableOpacity key={g.id} onPress={() => doSwap(h, g.id)}
                                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                                  style={{ paddingHorizontal: 9, paddingVertical: 5, borderRadius: 7,
                                           borderWidth: 1, borderColor: C.accent,
                                           backgroundColor: C.accentSoft }}>
                                  <Text style={{ fontSize: 11, fontWeight: '800', color: C.accent }}>
                                    {qty(g.qty)} in {g.name}  {'\u2192'}
                                  </Text>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </ScrollView>
                  <TouchableOpacity onPress={() => setSwapFor(null)} style={{ paddingVertical: 8 }}>
                    <Text style={{ fontWeight: '700', color: C.muted }}>Keep this one</Text>
                  </TouchableOpacity>
                </View>
              )}

              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={S.cellLabel}>Qty</Text>
                  {/* THE KEY AFTER THE QUANTITY GOES BACK TO THE SEARCH BOX.
                      It used to jump to Rate, and that was Skwik deciding
                      something it has no business deciding: the rate is
                      already there, off his own price list, and on nineteen
                      lines out of twenty he does not touch it. What he does
                      next is name the next item. So the tick goes where his
                      hand was going anyway, and the rate is still one tap away
                      on the odd line that needs it. */}
                  <NumCell style={[S.cell, S.num]} value={String(l.qty)}
                    ref={(r) => { cell.current[`${l.key}:qty`] = r; }}
                    selectTextOnFocus
                    onType={(t) => setLine(l.key, { qty: t })}
                    onDone={(t) => { const v = settle(t); setLine(l.key, { qty: v }); return v; }}
                    // and the real Tab key on a plugged-in keyboard does the
                    // same thing as the tick, because he asked for Tab
                    onKeyPress={(e) => {
                      if (e?.nativeEvent?.key === 'Tab') {
                        e.preventDefault?.();
                        setLine(l.key, { qty: settle(String(l.qty)) });
                        qRef.current?.focus();
                      }
                    }}
                    onSubmit={() => qRef.current?.focus()} />
                </View>
                <Text style={{ fontSize: 14, color: C.muted, paddingBottom: 11 }}>×</Text>
                <View style={{ flex: 1 }}>
                  <Text style={S.cellLabel}>Rate</Text>
                  <NumCell style={[S.cell, S.num]} value={String(l.rate)}
                    ref={(r) => { cell.current[`${l.key}:rate`] = r; }}
                    selectTextOnFocus
                    onFocus={() => setLine(l.key, { rateTouched: true })}
                    onType={(t) => setLine(l.key, { rate: t, rateEdited: true })}
                    onDone={(t) => { const v = settle(t); setLine(l.key, { rate: v }); return v; }}
                    onSubmit={() => qRef.current?.focus()} />
                </View>
                <Text style={[S.amt, { paddingBottom: 10, minWidth: 74 }]}>
                  {amt ? `₹${fmt0(amt)}` : '–'}
                </Text>
              </View>

              {/* the rate nobody set: say where it came from, so a worked-out
                  figure is never mistaken for a price somebody chose */}
              {l.rateGuessed && !l.rateEdited && (
                <Text style={{ fontSize: 11.5, color: C.edit, marginTop: 7, lineHeight: 16 }}>
                  No selling price on this item — this is what you paid plus 10%.
                  Change it if that is not your rate.
                </Text>
              )}

              {(wantBatch || wantExpiry) && (
                <View style={[S.row, { marginTop: 10, gap: 8, alignItems: 'flex-start' }]}>
                  {wantBatch && (
                    <View style={{ flex: 1 }}>
                      <Text style={S.cellLabel}>Batch</Text>
                      <TextInput style={S.cell} value={l.batch || ''}
                        placeholder="B-77" placeholderTextColor={C.faint}
                        autoCapitalize="characters"
                        returnKeyType="next" submitBehavior="submit"
                        onFocus={() => l.item_id && loadBatches(l.item_id, lineGodown(l))}
                        onBlur={() => fillExpiryFromBatch(l, l.batch)}
                        onChangeText={(t) => { setLine(l.key, { batch: t });
                                               fillExpiryFromBatch(l, t); }} />
                    </View>
                  )}
                  {wantExpiry && (
                    <View style={{ flex: 1 }}>
                      <Text style={S.cellLabel}>Expiry</Text>
                      {/* Same trap as the supplier's bill date: he writes
                          31/03/2027 and the database wanted the other way
                          round. Read his way, kept the only way it stores. */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <TextInput style={[S.cell, S.num, { flex: 1 }]}
                          value={l.expiryText ?? (l.expiry || '')}
                          placeholder="31-03-2027" placeholderTextColor={C.faint}
                          keyboardType="numbers-and-punctuation"
                          returnKeyType="next" submitBehavior="submit"
                          onSubmitEditing={() => qRef.current?.focus()}
                          onBlur={() => { const d = parseDate(l.expiryText ?? l.expiry);
                                          setLine(l.key, d ? { expiry: d, expiryText: showDate(d) }
                                                           : { expiry: '' }); }}
                          onChangeText={(t) => setLine(l.key, { expiryText: t })} />
                        <CalButton value={l.expiry || ''} size={38}
                          title="When does this lot go off?"
                          onPick={(iso) => setLine(l.key,
                            { expiry: iso, expiryText: showDate(iso) })} />
                      </View>
                    </View>
                  )}
                </View>
              )}

              {/* AND THE PILL SITS ON ITS OWN LINE.
                  Inside the batch column it made that column taller than the
                  expiry one beside it, and the row centres what it holds — so
                  the two labels and the two boxes stopped lining up. Typing
                  stays possible either way: a shop may hold stock Skwik was
                  never told about, and a sale must never wait on a list. */}
              {isOut && wantBatch && (
                <TouchableOpacity hitSlop={S.pillSlop}
                  style={[S.tapPill, { marginTop: 8, alignSelf: 'flex-start' }]}
                  onPress={() => {
                    const open = pickFor === l.key;
                    setPickFor(open ? null : l.key);
                    if (!open) loadBatches(l.item_id, lineGodown(l));
                  }}>
                  <Text style={S.tapPillText}>
                    {pickFor === l.key ? 'close' : 'pick a batch from stock'}
                  </Text>
                </TouchableOpacity>
              )}

              {/* WHAT IS LEFT, EARLIEST EXPIRY FIRST — the order a chemist
                  sells in anyway. Only the batches with goods still in them
                  are here, so nothing on this list can be sold short. */}
              {isOut && wantBatch && pickFor === l.key && (
                <View style={{ marginTop: 8, borderWidth: 1, borderColor: C.line,
                               borderRadius: 9, backgroundColor: C.surface,
                               overflow: 'hidden' }}>
                  {!inStock[stockKey(l)] ? (
                    <Text style={{ fontSize: 12.5, color: C.muted, padding: 11 }}>
                      Looking…
                    </Text>
                  ) : !inStock[stockKey(l)].length ? (
                    <Text style={{ fontSize: 12.5, color: C.muted, padding: 11, lineHeight: 17 }}>
                      Nothing left under a batch here. Type the batch in above.
                    </Text>
                  ) : inStock[stockKey(l)].map((b, i) => (
                    <TouchableOpacity key={`${b.batch || ''}|${b.godown_id || ''}|${i}`}
                      onPress={() => takeBatch(l, b)}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 8,
                               paddingHorizontal: 11, paddingVertical: 11,
                               borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1}
                          style={{ fontSize: 14.5, fontWeight: '700', color: C.ink }}>
                          {b.batch || 'No batch'}
                        </Text>
                        <Text numberOfLines={1}
                          style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                          {[b.expiry ? `Expires ${showDate(String(b.expiry).slice(0, 10))}` : null,
                            (!lineGodown(l) && b.godown_name) ? b.godown_name : null]
                            .filter(Boolean).join(' \u00B7 ') || 'No expiry on it'}
                        </Text>
                      </View>
                      <Text style={[S.num, { fontSize: 14.5, fontWeight: '700', color: C.ink }]}>
                        {qty(b.qty)} {uqcShort(l.unit)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* a word about this line, printed under it on the bill */}
              {(l.noteOpen || l.note) && (
                <TextInput
                  style={[S.cell, { marginTop: 10, paddingVertical: 9, fontSize: 14 }]}
                  placeholder="Size, colour, anything the customer should see"
                  placeholderTextColor={C.faint} value={l.note || ''} autoFocus={!l.note}
                  returnKeyType="next" submitBehavior="submit"
                  onSubmitEditing={() => qRef.current?.focus()}
                  onChangeText={(t) => setLine(l.key, { note: t })} />
              )}

              {/* THE ONE LINE THAT CAME OUT OF THE OTHER GODOWN.
                  Nearly every bill is all from one store and the control under
                  the lines says which, so that stays. But one item off the
                  back shelf meant writing the bill twice to say so — or, far
                  more often, not saying so at all, and the books then held
                  goods in a godown they had already left. One tap points this
                  line somewhere else, and it is marked in the hand-changed
                  colour so an odd line is seen without reading the bill. */}
              {(!(l.noteOpen || l.note) || godowns.length > 1) && (
                <View style={[S.row, { gap: 8, marginTop: 10 }]}>
                  {!(l.noteOpen || l.note) && (
                    <TouchableOpacity hitSlop={S.pillSlop} style={S.tapPill}
                      onPress={() => setLine(l.key, { noteOpen: true })}>
                      <Text style={S.tapPillText}>+ note</Text>
                    </TouchableOpacity>
                  )}
                  <View style={{ flex: 1 }} />
                  {godowns.length > 1 && (
                    <TouchableOpacity hitSlop={S.pillSlop} onPress={() => cycleGodown(l)}
                      accessibilityLabel="Which godown this line moves through"
                      style={[S.tapPill, !!l.godown_id && l.godown_id !== godown && {
                        borderColor: C.edit, backgroundColor: C.editSoft }]}>
                      <Text style={[S.tapPillText, !!l.godown_id && l.godown_id !== godown && {
                        color: C.edit, fontWeight: '800' }]}>
                        {godownName(lineGodown(l)) || 'Godown'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
          );
        })}

        {godowns.length > 1 && (
          <View style={[S.card, { paddingVertical: 10, marginHorizontal: 14, marginTop: 14 }]}>
            <Text style={S.eyebrow}>{isBuy ? 'Goods came into' : 'Goods went out of'}</Text>
            <View style={[S.row, { gap: 8, flexWrap: 'wrap' }]}>
              {godowns.map((g) => {
                const on = godown === g.id;
                return (
                  <TouchableOpacity key={g.id}
                    onPress={() => { setGodown(g.id); setPickFor(null); }}
                    style={{ paddingHorizontal: 13, paddingVertical: 8, borderRadius: 9,
                             borderWidth: 1, borderColor: on ? C.accent : C.line,
                             backgroundColor: on ? C.accentSoft : C.surface }}>
                    <Text style={{ fontSize: 13, fontWeight: '700',
                                   color: on ? C.accent : C.muted }}>{g.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {!!lines.length && (
          <View style={[S.card, { marginHorizontal: 14, marginTop: 14 }]}>
            <Text style={S.eyebrow}>Totals</Text>
            <Row k="Gross Total" v={fmt(calc.gross)} />
            {!!extraAmt && (
              <Row k={`Add : ${extraNote || 'Expenses'}${mode !== 'none' && extraRate
                        ? ` (in the ${pct(extraRate)}% above)` : ''}`} v={fmt(extraAmt)} />
            )}
            {!showExtra ? (
              <TouchableOpacity onPress={() => setShowExtra(true)} style={{ paddingTop: 8 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: C.accent }}>
                  + Freight or other charge
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={[S.row, { marginTop: 10 }]}>
                <TextInput style={[S.input, { flex: 1 }]} placeholder="What for?"
                  value={extraNote} onChangeText={setExtraNote}
                  returnKeyType="next" submitBehavior="submit"
                  onSubmitEditing={() => xRef.current?.focus()} />
                <TextInput style={[S.input, { width: 110 }, S.num]} ref={xRef}
                  keyboardType="numeric" placeholder="0" value={extra} onChangeText={setExtra}
                  returnKeyType="next" onBlur={() => setExtra(settle(extra))} />
              </View>
            )}

            {/* Freight is part of what is being supplied, so it carries tax
                like the goods do. The dearest rate on the bill is the usual
                answer and is offered; he can say otherwise. */}
            {showExtra && mode !== 'none' && !!extraAmt && (
              <View style={[S.row, { marginTop: 8, gap: 8, flexWrap: 'wrap' }]}>
                <Text style={{ fontSize: 12.5, color: C.muted }}>GST on it</Text>
                {[...new Set([topRate(good), 0, 5, 18, 40])].map((r) => {
                  const on = extraRate === r;
                  return (
                    <TouchableOpacity key={r} onPress={() => setExtraGst(String(r))}
                      style={{ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8,
                               borderWidth: 1, borderColor: on ? C.accent : C.line,
                               backgroundColor: on ? C.accentSoft : C.surface }}>
                      <Text style={{ fontSize: 12.5, fontWeight: '700',
                                     color: on ? C.accent : C.muted }}>{pct(r)}%</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            {/* ONE DISCOUNT, AND IT COMES OFF AFTER THE EXPENSES.
                Gross Total, add what was spent on top, take the discount off
                that, and what is left is what he has to pay. The screen used
                to take the discount off before the freight had been added,
                which is not how anybody adds up a bill.
                It is shared out across the lines behind the scenes so each
                tax rate is charged on what was really taken for it — the
                customer sees one round figure, the return sees the truth. */}
            <View style={[S.row, { marginTop: 6, marginBottom: 2, gap: 8 }]}>
              <Text style={{ flex: 1, fontSize: 14, color: C.muted }}>Less : Discount</Text>
              <TextInput style={[S.cell, S.num, { width: 120, textAlign: 'right' }]}
                keyboardType="numeric" placeholder="0" placeholderTextColor={C.faint}
                selectTextOnFocus value={less}
                onChangeText={setLess} onBlur={() => setLess(settle(less))}
                returnKeyType="next" />
            </View>
            {discAsked > discTotal && (
              <Text style={{ fontSize: 11.5, color: C.flagInk, marginBottom: 4 }}>
                Only {fmt(discTotal)} can come off — that is the whole bill.
              </Text>
            )}


            <Row k={extraAmt || discAsked ? 'Taxable value' : 'Net of goods'} v={fmt(calc.taxable)} />
            {isBuy && taxIsCost(org) && mode !== 'none' && (
              <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2, lineHeight: 17 }}>
                You cannot claim this tax back, so Skwik puts it into what the
                goods cost you. Ten pieces at 100 with 5% on them become 105 each.
              </Text>
            )}
            {mode === 'cgst_sgst' && (<><Row k="CGST" v={fmt(calc.cgst)} /><Row k="SGST" v={fmt(calc.sgst)} /></>)}
            {mode === 'igst' && <Row k="IGST" v={fmt(calc.igst)} />}
            {!!roundOff && <Row k="Round off" v={fmt(roundOff)} />}


            {/* REVERSE CHARGE.
                Ticking this means the BUYER pays the tax to the government
                himself, so the shop must not collect it. Skwik used to tick
                the box, print "Reverse charge: Yes", and add CGST and SGST to
                the total anyway — which is tax collected without authority:
                section 76 takes 100% of it as penalty, in cash, with no
                set-off. Now the tax comes off the bill the moment it is
                ticked, and the total below changes in front of him. */}
            {/* REVERSE CHARGE, WHICH MEANS TWO OPPOSITE THINGS.
              *
              * On a SALE the buyer pays the tax instead of the shop, and
              * almost no shop selling goods ever issues one — so it waits
              * behind a switch in Settings. The sentence used to read "Tax on
              * this bill is payable by the buyer (reverse charge)" with the
              * explanation appearing only AFTER it was ticked, which is the
              * wrong way round for a control that silently removes GST from a
              * bill. The explanation now comes first.
              *
              * On a PURCHASE the shop owes the tax — freight, most weeks —
              * and that is on for any registered shop.
              */}
            {!estimateMode && isOut && showRcmOut(org)
              && org?.is_gst_registered && !org?.is_composition && (
              <TouchableOpacity onPress={() => setRcharge(!rcharge)}
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 14 }}>
                <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5,
                               alignItems: 'center', justifyContent: 'center', marginTop: 1,
                               borderColor: rcharge ? C.accent : C.greyB,
                               backgroundColor: rcharge ? C.accent : 'transparent' }}>
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
                    {rcharge ? '✓' : ''}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13.5, color: C.ink }}>
                    Buyer pays the GST himself, not to you
                  </Text>
                  <Text style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 17 }}>
                    {rcharge
                      ? 'No GST is on this bill. He pays it to the government '
                        + 'himself, and the bill says so.'
                      : 'Rare. Only for the few supplies the law names — ask '
                        + 'your accountant before ticking this.'}
                  </Text>
                </View>
              </TouchableOpacity>
            )}

            {/* The side a shop meets every week. */}
            {isBuy && showRcmIn(org) && (
              <TouchableOpacity onPress={() => setRcharge(!rcharge)}
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 14 }}>
                <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5,
                               alignItems: 'center', justifyContent: 'center', marginTop: 1,
                               borderColor: rcharge ? C.accent : C.greyB,
                               backgroundColor: rcharge ? C.accent : 'transparent' }}>
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>
                    {rcharge ? '✓' : ''}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13.5, color: C.ink }}>
                    He charged no GST — the GST on this is mine to pay
                  </Text>
                  <Text style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 17 }}>
                    {rcharge
                      ? `You pay him ${'\u20B9'}${fmt0(calc.taxable)} and `
                        + `${'\u20B9'}${fmt0(calc.cgst + calc.sgst + calc.igst)} of GST to the `
                        + 'government. It is in "GST owed" under Books, and in '
                        + 'Reports for your accountant.'
                      : 'Freight from a transporter is the usual one. Tick it and '
                        + 'Skwik works out what you owe.'}
                  </Text>
                </View>
              </TouchableOpacity>
            )}

            {/* WHERE THE TRANSPORTER IS -- ASKED, NOT GUESSED.
              *
              * This decides whether the GST he owes is CGST+SGST or IGST, which
              * is two different cash ledgers for the same rupees. It used to be
              * worked out from the party's state_code, with a comment admitting
              * a transporter with no state was "treated as local, which is what
              * a small shop's transporter almost always is".
              *
              * A reverse-charge party is the one party most likely to have NO
              * GST NUMBER, so state_code is the only input -- and until the
              * dated-rows fix, 578 of his 607 names had no state at all and
              * fell back to his own. April's 33,780 Greatx bill came out right
              * only because the voucher carried a GSTIN Tally had already
              * withdrawn.
              *
              * NO POPUP AND NO KEYPAD. Two taps in a row, the same shape as the
              * tick above it, with the worked-out answer already chosen so a man
              * entering sixty freight bills a month need not touch it.
              */}
            {isBuy && showRcmIn(org) && rcharge && (
              <View style={{ marginTop: 12, paddingLeft: 30 }}>
                <Text style={{ fontSize: 12.5, color: C.muted, marginBottom: 6 }}>
                  Where is he?
                  {cust?.state_name ? `  ${'—'}  on file: ${cust.state_name}` : ''}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {[['cgst_sgst', 'Same state'], ['igst', 'Other state']].map(([mode, label]) => {
                    // The one in force -- his answer if he gave one, otherwise
                    // whatever the party's state works out to, so the screen
                    // always shows what will actually be saved.
                    const on = rcmTaxMode(org, cust, rcmHead) === mode;
                    return (
                      <TouchableOpacity key={mode}
                        onPress={() => setRcmHead(rcmHead === mode ? null : mode)}
                        style={{ paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8,
                                 borderWidth: 1.5,
                                 borderColor: on ? C.accent : C.greyB,
                                 backgroundColor: on ? C.accent : 'transparent' }}>
                        <Text style={{ fontSize: 13, fontWeight: on ? '700' : '500',
                                       color: on ? '#fff' : C.ink }}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={{ fontSize: 12, color: C.muted, marginTop: 6, lineHeight: 17 }}>
                  {rcmHead
                    ? 'Your answer. It is saved on this bill, so it stays put even '
                      + 'if his state changes later.'
                    : 'Worked out from his state. Tap to set it yourself.'}
                </Text>
              </View>
            )}

            <View style={[S.tline, { borderTopWidth: 2, borderTopColor: C.ink, marginTop: 8, paddingTop: 10 }]}>
              <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink }}>Net Total</Text>
              <Text style={[{ fontSize: 20, fontWeight: '700', color: C.ink }, S.num]}>₹{fmt0(grand)}</Text>
            </View>

            {!!lines.length && checked > 0 && (
              <Text style={{ marginTop: 10, fontSize: 11.5, fontWeight: '600',
                             color: checked === lines.length ? C.ok : C.flagInk }}>
                {checked === lines.length
                  ? `All ${checked} lines re-checked.`
                  : `${checked} of ${lines.length} lines re-checked.`}
              </Text>
            )}
          </View>
        )}
      </ScrollView>

      {/* THE FOOT GETS OUT OF THE WAY WHILE HE IS TYPING.
          With the keyboard down this is a ruled book's foot: the total on
          paper, big, with nothing crowding it, and the buttons on their own
          dark bar below.

          With the keyboard UP it is one slim dark line — the figure on the
          left, Save on the right — because at that moment the furniture is
          not what he needs to see. He needs the LINES. A tall foot and a
          keyboard together leave room for one item, which is the opposite of
          what a bill screen is for. So the foot gives its height back to the
          list for as long as he is typing, and takes it again the moment he
          is done. */}
      {keyGap > 0 ? (
        <Foot style={{ backgroundColor: C.barInk, borderTopWidth: 0,
                       paddingHorizontal: 12, paddingTop: 8, gap: 10,
                       alignItems: 'center' }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 10, fontWeight: '700', letterSpacing: 0.7,
                           color: C.barMuted }}>
              {good.length} ITEM{good.length === 1 ? '' : 'S'}
            </Text>
            <Text style={[S.num, { fontSize: 19, fontWeight: '800', color: '#FFFFFF' }]}>
              ₹{fmt0(grand)}
            </Text>
          </View>
          <TouchableOpacity onPress={() => save(false)} disabled={busy}
            style={[S.darkBtn, S.darkBtnOn, { flex: 0, paddingHorizontal: 20,
                                              paddingVertical: 11 },
                    busy && { opacity: 0.5 }]}>
            <Text style={S.darkBtnTextOn}>
              {busy ? 'Saving…' : editId ? 'Save' : 'Save & send'}
            </Text>
          </TouchableOpacity>
        </Foot>
      ) : (
        <>
          <View style={{ backgroundColor: C.surface, borderTopWidth: 1.5, borderTopColor: C.ink,
                         paddingHorizontal: 14, paddingVertical: 10,
                         flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={S.footL}>
                {good.length} ITEM{good.length === 1 ? '' : 'S'}
                {mode !== 'none' && (calc.cgst + calc.sgst + calc.igst) > 0
                  ? ` · GST ₹${fmt0(calc.cgst + calc.sgst + calc.igst)}` : ''}
              </Text>
              <Text style={S.footTot}>₹{fmt0(grand)}</Text>
            </View>
          </View>

          <Foot style={{ backgroundColor: C.barInk, borderTopWidth: 0,
                         paddingHorizontal: 12, gap: 8 }}>
            <TouchableOpacity onPress={() => save(true)} disabled={busy}
              style={[S.darkBtn, { flex: 0.8 }, busy && { opacity: 0.5 }]}>
              <Text style={S.darkBtnText}>Save only</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => save(false)} disabled={busy}
              style={[S.darkBtn, S.darkBtnOn, { flex: 1.4 }, busy && { opacity: 0.5 }]}>
              <Text style={S.darkBtnTextOn}>
                {busy ? 'Saving…' : editId ? 'Save changes' : 'Save & send'}
              </Text>
            </TouchableOpacity>
          </Foot>
        </>
      )}

      {/* ---------- customer picker ----------

          IT STAYS ON THE BILL. He wrote an estimate, tapped the customer line,
          and was thrown onto what looked like a different screen — his bill
          gone, a BACK button where CLOSE should be. It was a full-screen modal,
          and there was never any reason for it to be: the only thing it needs
          is a box to type a name into and the names underneath.

          So it is a sheet now, the same shape as the new-customer sheet next to
          it. The bill stays visible above it, tapping the dark part puts it
          away, and nothing about where he is has changed. */}
      {/* THE CUSTOMER PICKER, DROPPED FROM THE TOP.
          *
          * It used to rise from the bottom, which put the box he types into
          * down beside the keyboard, with every match that appeared shoving
          * it about. He has asked twice for search boxes to be at the top of
          * the screen; this is the one that was not.
          *
          * Still a sheet, not a page: the bill shows through behind it and a
          * tap on the bill closes it — but only once there IS a customer, so
          * a new bill cannot be left with nobody on it by a stray tap.
          */}
      <TopSheet visible={custOpen}
        onShow={() => custSheetRef.current?.focus()}
        onClose={() => { if (cust) setCustOpen(false); }}
        onBackdrop={() => { if (cust) setCustOpen(false); }}>
          <View style={S.row}>
            <Text style={[S.h1, { flex: 1 }]}>{isBuy ? 'Who did you buy from?' : 'Who is it for?'}</Text>
            <TouchableOpacity hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              onPress={() => { if (cust) setCustOpen(false); else navigation.goBack(); }}>
              <Text style={{ fontWeight: '800', color: C.muted }}>
                {cust ? 'CLOSE' : 'BACK'}
              </Text>
            </TouchableOpacity>
          </View>
          {custPicker({ inline: false })}
      </TopSheet>

      {/* ---------- a name that is not in the book yet ---------- */}
      <Modal visible={!!partySheet} transparent animationType="slide"
             onRequestClose={() => setPartySheet(null)}>
        <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end' }}>
          <KeyForm style={{ maxHeight: '92%' }}
            contentContainerStyle={{ backgroundColor: C.bg, borderTopLeftRadius: 26,
                                     borderTopRightRadius: 26, padding: 20 }}>
            {!!partySheet && (
              <>
                <Text style={{ fontSize: 21, fontWeight: '800', color: C.ink }}>
                  New {partySheet.kind === 'supplier' ? 'supplier' : 'customer'}
                </Text>
                <Text style={{ fontSize: 13, fontWeight: '600', color: C.muted, marginTop: 4 }}>
                  Asked once. Everything here can be changed later under Customers.
                </Text>

                <Text style={[S.label, { marginTop: 16 }]}>NAME</Text>
                <Box ref={npName} next={npPhone} style={{ marginTop: 6 }} autoFocus
                  value={partySheet.name}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, name: t }))} />

                <Text style={[S.label, { marginTop: 14 }]}>PHONE — FOR WHATSAPP</Text>
                <Box ref={npPhone} next={npArea} style={[S.num, { marginTop: 6 }]}
                  keyboardType="phone-pad" maxLength={10} placeholder="98640 12345"
                  value={partySheet.phone}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, phone: t }))} />
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                  Without it his bill cannot be sent and no reminder can reach him.
                </Text>

                <Text style={[S.label, { marginTop: 14 }]}>AREA</Text>
                <Box ref={npArea} next={npAddr} style={{ marginTop: 6 }}
                  placeholder="Fancy Bazar, Ward 4, GS Road"
                  value={partySheet.area}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, area: t }))} />
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                  His locality, in your own words. Bills sort by it when you send
                  a boy out with four of them.
                </Text>

                <Text style={[S.label, { marginTop: 14 }]}>ADDRESS</Text>
                {/* The GST field below only exists for a registered shop. An
                    estimate-mode kirana used to reach ADDRESS, press next, and
                    have the key do nothing — the form stopped halfway with no
                    sign of why. Skip to the field that IS there. */}
                <Box ref={npAddr} next={org?.is_gst_registered ? npGst : npOpen}
                  style={{ marginTop: 6 }}
                  placeholder="Shop and street"
                  value={partySheet.address}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, address: t }))} />

                {/* THE STATE IS ALWAYS ASKED.
                    It used to be hidden behind "is this shop GST registered",
                    which meant a shop writing estimates today collected no
                    states at all — and the day it registers, every customer
                    on its book is silently assumed to be in its own state and
                    every out-of-state bill carries the wrong tax. It is one
                    field. It is asked now. */}
                {!!org?.is_gst_registered && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>GST NUMBER</Text>
                    <Box ref={npGst} next={npOpen} style={{ marginTop: 6 }}
                      autoCapitalize="characters" maxLength={15}
                      placeholder="Leave empty if he is unregistered"
                      value={partySheet.gstin}
                      onChangeText={(t) => {
                        const g = t.toUpperCase().trim();
                        setPartySheet((x) => ({ ...x, gstin: g,
                          state_code: g.length >= 2 && STATES[g.slice(0, 2)]
                            ? g.slice(0, 2) : x.state_code }));
                      }} />

                  </>
                )}

                {/* The state by its name. The code fills itself in. */}
                <Text style={[S.label, { marginTop: 14 }]}>STATE</Text>
                <View style={{ marginTop: 6 }}>
                  <StateField value={String(partySheet.state_code || '')}
                    homeCode={String(org?.state_code || '')}
                    onChange={(code) => setPartySheet((x) => ({ ...x, state_code: code }))} />
                </View>
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                  {STATES[partySheet.state_code]
                    ? (org?.is_gst_registered
                        ? (String(partySheet.state_code) === String(org?.state_code)
                            ? 'His bills carry CGST and SGST.' : 'His bills carry IGST.')
                        : 'Kept for the day you register.')
                    : 'It decides whether a bill carries CGST and SGST or IGST, and it '
                      + 'is needed the day you register.'}
                </Text>

                {!isBuy && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>WHICH PRICE LIST</Text>
                    <View style={[S.row, { gap: 8, marginTop: 6 }]}>
                      {[[1, org?.price1_name || 'Wholesale'], [2, org?.price2_name || 'Retail']]
                        .map(([v, label]) => {
                          const on = Number(partySheet.price_list) === v;
                          return (
                            <TouchableOpacity key={v}
                              onPress={() => setPartySheet((x) => ({ ...x, price_list: String(v) }))}
                              style={{ flex: 1, paddingVertical: 11, borderRadius: 9,
                                       alignItems: 'center', borderWidth: 1,
                                       borderColor: on ? C.accent : C.line,
                                       backgroundColor: on ? C.accentSoft : C.surface }}>
                              <Text style={{ fontSize: 14, fontWeight: '700',
                                             color: on ? C.accent : C.muted }}>{label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                    </View>
                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                      Chosen once. Every bill for him uses that list from now on.
                    </Text>
                  </>
                )}

                <Text style={[S.label, { marginTop: 14 }]}>
                  {isBuy ? 'ALREADY OWED TO HIM' : 'ALREADY OWES YOU'}
                </Text>
                <Box ref={npOpen} onSubmit={takeNewParty} style={[S.num, { marginTop: 6 }]}
                  keyboardType="numeric" placeholder="0"
                  value={partySheet.opening_balance}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, opening_balance: t }))} />
                {num(partySheet.opening_balance) > 0 ? (
                  <View style={[S.row, { gap: 8, marginTop: 8 }]}>
                    {[['owes_you', isBuy ? 'You owe him' : 'He owes you'],
                      ['you_owe',  isBuy ? 'He owes you' : 'You owe him']]
                      .map(([v, label]) => {
                        const on = (partySheet.opening_type || 'owes_you') === v;
                        return (
                          <TouchableOpacity key={v}
                            onPress={() => setPartySheet((x) => ({ ...x, opening_type: v }))}
                            style={{ flex: 1, paddingVertical: 11, borderRadius: 9,
                                     alignItems: 'center', borderWidth: 1,
                                     borderColor: on ? C.accent : C.line,
                                     backgroundColor: on ? C.accentSoft : C.surface }}>
                            <Text style={{ fontSize: 14, fontWeight: '700',
                                           color: on ? C.accent : C.muted }}>{label}</Text>
                          </TouchableOpacity>
                        );
                      })}
                  </View>
                ) : (
                  <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                    Old dues from before Skwik. Leave it empty if the slate is clean —
                    put in later and his account will read as settled when it is not.
                  </Text>
                )}

                <TouchableOpacity style={[S.btn, { marginTop: 22 }]} onPress={takeNewParty}>
                  <Text style={S.btnText}>Start his bill</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setPartySheet(null); setCustOpen(true); }}
                  style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Back</Text>
                </TouchableOpacity>
                <View style={{ height: 30 }} />
              </>
            )}
          </KeyForm>
        </View>
      </Modal>

      {/* ---------- new item, mid-bill ---------- */}
      <Modal visible={!!quick} transparent animationType="slide" onRequestClose={() => setQuick(null)}>
        <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end' }}>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: '90%' }}
            contentContainerStyle={{ backgroundColor: C.bg, borderTopLeftRadius: 26,
                                     borderTopRightRadius: 26, padding: 20 }}>
            {!!quick && (
              <>
                <Text style={{ fontSize: 21, fontWeight: '800', color: C.ink }}>New item</Text>
                <Text style={{ fontSize: 13, fontWeight: '600', color: C.muted, marginTop: 4 }}>
                  Asked once. Next time it fills itself.
                </Text>

                <Text style={[S.label, { marginTop: 16 }]}>ITEM NAME</Text>
                <Box ref={qName} next={qAlias} style={{ marginTop: 6 }} value={quick.name}
                  onChangeText={(t) => setQuick((x) => ({ ...x, name: t }))} />

                <Text style={[S.label, { marginTop: 14 }]}>ALSO CALLED</Text>
                <Box ref={qAlias} next={hsnApplies(org) ? qGst : qRate} style={{ marginTop: 6 }}
                  placeholder="balti, bucket, tub"
                  value={quick.alias} onChangeText={(t) => setQuick((x) => ({ ...x, alias: t }))} />
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 5 }}>
                  Any of these words will find this item later.
                </Text>

                <Text style={[S.label, { marginTop: 14 }]}>UNIT</Text>
                <View style={{ marginTop: 6 }}>
                  <UomField value={quick.unit} onChange={(v) => setQuick((x) => ({ ...x, unit: v }))} />
                </View>

                {hsnApplies(org) && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>
                      {isBuy ? "HSN — COPY FROM YOUR SUPPLIER'S BILL" : 'HSN CODE'}
                    </Text>
                    <View style={{ marginTop: 6 }}>
                      <HsnField value={quick.hsn} org={org}
                        onChange={(v) => setQuick((x) => ({ ...x, hsn: v }))}
                        onRate={(v) => setQuick((x) => ({ ...x, gst_rate: v }))} />
                    </View>
                    <Text style={[S.label, { marginTop: 14 }]}>GST RATE %</Text>
                    <Box ref={qGst} next={qRate} style={{ marginTop: 6 }} keyboardType="numeric"
                      value={quick.gst_rate}
                      onChangeText={(t) => setQuick((x) => ({ ...x, gst_rate: t }))} />
                  </>
                )}

                <Text style={[S.label, { marginTop: 14 }]}>
                  {isBuy ? 'PURCHASE RATE' : `RATE — ${(org?.price1_name || 'WHOLESALE').toUpperCase()}`}
                </Text>
                <Box ref={qRate} next={isBuy ? qBuy : qRate2} style={{ marginTop: 6 }}
                  keyboardType="numeric"
                  value={quick.rate} onChangeText={(t) => setQuick((x) => ({ ...x, rate: t }))} />

                {!isBuy && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>
                      RATE — {(org?.price2_name || 'RETAIL').toUpperCase()}
                    </Text>
                    <Box ref={qRate2} next={qBuy} style={{ marginTop: 6 }} keyboardType="numeric"
                      placeholder="Leave empty to use the same rate"
                      value={quick.rate2}
                      onChangeText={(t) => setQuick((x) => ({ ...x, rate2: t }))} />
                  </>
                )}

                <Text style={[S.label, { marginTop: 14 }]}>
                  {isBuy ? 'SALE RATE' : 'PURCHASE RATE — WHAT IT COSTS YOU'}
                </Text>
                <Box ref={qBuy} next={showStock(org) ? qOpen : null}
                  onSubmit={showStock(org) ? undefined : saveQuick}
                  style={{ marginTop: 6 }} keyboardType="numeric"
                  placeholder={isBuy ? 'What you will sell it at' : 'For the profit figure'}
                  value={quick.other} onChangeText={(t) => setQuick((x) => ({ ...x, other: t }))} />
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                  {isBuy
                    ? 'Without it this item has no rate on any sale bill, and you will '
                      + 'be typing it in by hand every time.'
                    : 'Without it the profit figure counts this item as pure profit.'}
                </Text>

                {showStock(org) && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>
                      OPENING STOCK{quick.unit ? ` — ${uqcShort(quick.unit)}` : ''}
                    </Text>
                    <Box ref={qOpen} onSubmit={saveQuick} style={{ marginTop: 6 }}
                      keyboardType="numeric" placeholder="How many you already have"
                      value={quick.opening_stock}
                      onChangeText={(t) => setQuick((x) => ({ ...x, opening_stock: t }))} />
                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                      {isBuy
                        ? 'What was on the shelf BEFORE this purchase bill. The quantity '
                          + 'on this bill is added on top.'
                        : 'What is on the shelf now, before this bill goes out.'}
                    </Text>
                  </>
                )}

                <TouchableOpacity style={[S.btn, { marginTop: 22 }]} onPress={saveQuick}>
                  <Text style={S.btnText}>SAVE AND USE</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setQuick(null)}
                  style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Cancel</Text>
                </TouchableOpacity>
                <View style={{ height: 30 }} />
              </>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* ---------- saved ---------- */}
      <Modal visible={!!saved} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: '#3B3A35EE', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18,
                         padding: 20, paddingBottom: 20 + Math.max(insets.bottom, 10) }}>
            <Text style={{ fontSize: 13, color: C.muted, letterSpacing: 1 }}>
              {docName.toUpperCase()} {saved?.voucher?.voucher_no || ''}
            </Text>
            {saved?.queued && (
              <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.flagInk, marginTop: 6 }}>
                Saved on this phone. Give the customer the bill as usual — it
                reaches your books by itself when the internet is back.
              </Text>
            )}
            <Text style={[{ fontSize: 30, fontWeight: '700', color: C.ink, marginTop: 6, marginBottom: 16 },
                          S.num]}>
              ₹{fmt0(saved?.voucher?.total || 0)}
            </Text>
            {/* THREE WAYS OUT, AND ALL THREE CARRY THE BILL.
                There used to be a fourth at the top, in green, that sent the
                customer six lines of plain text — his name, the number, the
                amount. A man who wants the bill wants the BILL; a typed-out
                amount with no bill behind it is not something anybody keeps,
                and it was the biggest button on the screen. */}
            <TouchableOpacity style={[S.btn, { backgroundColor: C.wa }]} onPress={onWhatsAppPdf}>
              <Text style={S.btnText}>Send PDF on WhatsApp</Text>
            </TouchableOpacity>
            <View style={[S.row, { marginTop: 10, gap: 10 }]}>
              <TouchableOpacity style={[S.btnGhost, { flex: 1, paddingVertical: 14 }]}
                onPress={onPrint}>
                <Text style={[S.ghostText, { fontSize: 15 }]}>Print</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[S.btnGhost, { flex: 1, paddingVertical: 14 }]}
                onPress={onDownload}>
                <Text style={[S.ghostText, { fontSize: 15 }]}>Download</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[S.btnGhost, { flex: 1, paddingVertical: 14 }]}
                onPress={onShare}>
                <Text style={[S.ghostText, { fontSize: 15 }]}>Send</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => { setSaved(null); goHome(navigation); }}
              style={{ marginTop: 16, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      {/* the days the numbering allows, and the reason in his own words */}
      {/* A PURCHASE HAS NO NUMBERING WINDOW, so the server does not fence its
          date at all -- but the books lock and the calendar do. Nothing in a
          month he has closed, and nothing in the future: goods cannot have been
          received on a day that has not happened. */}
      <Calendar visible={dateCal} value={vdate || today()}
        min={isBuy ? dayAfter(org?.books_locked_upto) : win?.from}
        max={isBuy ? today() : win?.to}
        title={isBuy ? 'The day this goes into your books'
          : docName === 'Estimate' ? 'Date this estimate' : `Date this ${docName.toLowerCase()}`}
        note={isBuy
          ? 'Your books use this day. His own bill date stays where you typed it.'
          : win?.why}
        onPick={(iso) => { setVdate(iso); setDateCal(false); }}
        onClose={() => setDateCal(false)} />

      <Calendar visible={supCal} value={supDate || today()} max={today()}
        title="Date on his bill"
        note="The date they printed on it. Your books use the day you entered it."
        onPick={(iso) => setSupDateText(showDate(iso))}
        onClose={() => setSupCal(false)} />
      <ScanSheet visible={scanOpen} onClose={() => setScanOpen(false)} onCode={scanned}
        title="Point at the barcode"
        note="Scan the same packet twice and the quantity goes up" />

      {/* ===================== ONE ARROW, WHERE HIS THUMB IS ==============
          Tap walks the highlight down the list; hold puts that line on the
          bill; Tab does the same from a keyboard. It floats and is dragged
          where he wants it. The whole of it is in ThumbRail.              */}
      <ThumbRail
        visible={wantRail && !!q.trim() && hits.length > 0}
        count={hits.length}
        onNext={walk} onTake={takeSel} />

    </Screen>
  );
}

const Row = ({ k, v }) => (
  <View style={[S.row, { marginBottom: 6 }]}>
    <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: '#4A4944' }}>{k}</Text>
    <Text style={[{ fontSize: 13, fontWeight: '600', color: '#4A4944' }, S.num]}>{v}</Text>
  </View>
);
