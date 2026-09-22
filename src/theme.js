import { Platform } from 'react-native';

// THE REGISTER.
//
// Skwik is a book of account that happens to run on a phone, and it is meant
// to look like one: a warm paper ground rather than the cold blue-grey every
// app defaults to, ruled lines instead of floating cards, a dark ink bar
// across the top and the bottom, and every figure set in a real monospaced
// face so a column of rupees lines up on the decimal and never jiggles as it
// changes.
//
// Two rules hold the whole thing together:
//
//   FIGURES ARE MONO, WORDS ARE NOT. Anything countable — an amount, a
//   quantity, a rate, a date, a bill number — goes through S.num. Everything
//   a person reads as language stays in the phone's own face, which is the
//   one their eye is fastest in.
//
//   WEIGHT DOES THE WORK OF SIZE. One weight for a name (600), one for a
//   figure that matters (700), nothing heavier. Uppercase is for column
//   heads and section labels only, never for a button and never for a
//   sentence.
//
// The phone's own monospaced face is used rather than one shipped with the
// app: it is already on the device, it costs nothing to load, and — unlike a
// bundled font file — fontWeight keeps working on top of it, which every
// screen in here relies on.
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const C = {
  bg:       '#FBFAF6',   // paper
  surface:  '#FFFFFF',
  card:     '#FFFFFF',
  ink:      '#10201C',   // near-black with a green cast, the colour of the bars
  muted:    '#4F5D59',
  line:     '#E6E1D6',
  soft:     '#F4F2EB',   // the ruled-header strip

  accent:   '#0B6B5E',   // every action
  accentSoft:'#F2F7F6',
  danger:   '#C2410C',   // money going out, and anything wrong
  wa:       '#1DA851',   // whatsapp green

  flag:     '#C99A2E',   // the star
  flagSoft: '#FBF3DC',
  flagLine: '#E8D6A4',
  flagInk:  '#8A6100',

  ok:       '#1F8A4C',   // the tick
  okSoft:   '#E8F3EC',
  okLine:   '#BFE0CB',

  edit:     '#8A6100',
  editSoft: '#FBF3DC',
  faint:    '#96A29E',
  greyB:    '#C9C3B4',

  // the dark bars, top and bottom
  barInk:   '#10201C',
  barLine:  '#33413C',
  barFill:  '#1B2D28',
  barText:  '#E8F3F1',
  barMuted: '#9AA8A3',

  // older names, kept so nothing breaks
  green:    '#0B6B5E',
  greenD:   '#08544A',
  greenL:   '#F2F7F6',
  red:      '#C2410C',
  redL:     '#FBEFE8',
  grey:     '#FBFAF6',
};

export const R = 12;

export const S = {
  screen:  { flex: 1, backgroundColor: C.bg },
  wrap:    { padding: 14, paddingHorizontal: 12 },

  // the dark bar across the top: who it is for, and what it comes to
  bar:     { backgroundColor: C.barInk, paddingHorizontal: 14, paddingVertical: 12,
             flexDirection: 'row', alignItems: 'center', gap: 10 },
  barName: { fontSize: 15.5, fontWeight: '700', color: '#FFFFFF', letterSpacing: -0.1 },
  barSub:  { fontSize: 11.5, color: C.barMuted, letterSpacing: 0.2,
             fontFamily: MONO, fontVariant: ['tabular-nums'] },
  barTotL: { fontSize: 9.5, letterSpacing: 1.2, color: C.barMuted, fontWeight: '700' },
  barTot:  { fontSize: 19, fontWeight: '700', color: '#FFFFFF',
             fontFamily: MONO, fontVariant: ['tabular-nums'] },

  card:    { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line,
             borderRadius: R, padding: 14, marginBottom: 12 },
  eyebrow: { fontSize: 10.5, letterSpacing: 1.1, color: C.muted, fontWeight: '700',
             textTransform: 'uppercase', marginBottom: 8 },
  label:   { fontSize: 11.5, color: C.muted, marginBottom: 4, fontWeight: '600' },

  input:   { fontSize: 16, color: C.ink, paddingHorizontal: 12, paddingVertical: 11,
             borderWidth: 1, borderColor: C.line, borderRadius: 10, backgroundColor: '#FFFFFF' },

  hit:     { paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1,
             borderBottomColor: C.line, flexDirection: 'row', alignItems: 'center', gap: 10 },
  hitName: { fontSize: 14.5, color: C.ink, fontWeight: '600' },
  hitSub:  { fontSize: 11, color: C.muted, marginTop: 2 },
  hitPr:   { fontSize: 14.5, fontWeight: '700', color: C.ink,
             fontFamily: MONO, fontVariant: ['tabular-nums'] },

  line:    { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line,
             borderRadius: R, padding: 12, marginBottom: 10 },
  lineNm:  { fontSize: 14.5, fontWeight: '600', color: C.ink, lineHeight: 19 },
  amt:     { fontSize: 15.5, fontWeight: '700', color: C.ink, textAlign: 'right',
             fontFamily: MONO, fontVariant: ['tabular-nums'] },

  tline:   { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  tlineK:  { fontSize: 13, color: C.muted, fontWeight: '600' },
  tlineV:  { fontSize: 13, color: C.ink, fontFamily: MONO, fontVariant: ['tabular-nums'] },

  foot:    { backgroundColor: C.surface, borderTopWidth: 1.5, borderTopColor: C.ink,
             paddingHorizontal: 14, paddingTop: 11, paddingBottom: 22,
             flexDirection: 'row', alignItems: 'center', gap: 10 },
  footL:   { fontSize: 11, color: C.muted, letterSpacing: 0.5, fontWeight: '600' },
  footTot: { fontSize: 23, fontWeight: '700', color: C.ink,
             fontFamily: MONO, fontVariant: ['tabular-nums'] },

  btn:     { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 15,
             paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  btnGhost:{ backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, borderRadius: 10,
             paddingVertical: 11, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  ghostText:{ fontSize: 14, fontWeight: '700', color: C.ink },

  chip:    { fontSize: 10, letterSpacing: 0.5, backgroundColor: C.accentSoft, color: C.accent,
             paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, fontWeight: '700',
             overflow: 'hidden' },
  qbadge:  { fontSize: 11, fontWeight: '700', backgroundColor: C.ink, color: '#FFFFFF',
             paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
             fontFamily: MONO },
  hint:    { fontSize: 11.5, color: C.muted, marginTop: 6, lineHeight: 16 },

  row:     { flexDirection: 'row', alignItems: 'center', gap: 10 },

  /* ---------------- the ruled register ---------------- */

  // the strip that names the columns: uppercase, small, on the paper tint
  colHead: { flexDirection: 'row', gap: 6, alignItems: 'center',
             paddingHorizontal: 14, paddingVertical: 6,
             backgroundColor: C.soft, borderBottomWidth: 1, borderBottomColor: C.line },
  colName: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6, color: C.muted },

  // one ruled line of the register
  rule:    { flexDirection: 'row', gap: 6, alignItems: 'baseline',
             paddingHorizontal: 14, paddingVertical: 10,
             borderBottomWidth: 1, borderBottomColor: '#EDE9E0' },
  ruleNm:  { fontSize: 13.5, fontWeight: '600', color: C.ink },
  ruleSub: { fontSize: 10.5, color: C.muted, marginTop: 1,
             fontFamily: MONO },

  // the line being typed into right now
  ruleLive:{ backgroundColor: '#FFFFFF', borderLeftWidth: 3, borderLeftColor: C.accent },

  // the dark bar of actions along the bottom of a working screen
  barDark: { backgroundColor: C.barInk, flexDirection: 'row', gap: 8,
             paddingHorizontal: 12, paddingTop: 10, paddingBottom: 16 },
  darkBtn: { flex: 1, backgroundColor: C.barFill, borderWidth: 1, borderColor: C.barLine,
             borderRadius: 10, paddingVertical: 13, flexDirection: 'row',
             alignItems: 'center', justifyContent: 'center', gap: 7 },
  darkBtnOn:{ backgroundColor: C.accent, borderColor: C.accent },
  darkBtnText: { fontSize: 14, fontWeight: '700', color: C.barText },
  darkBtnTextOn:{ fontSize: 14.5, fontWeight: '700', color: '#FFFFFF' },

  // the strip of things to do, down the right of the register
  doKey:   { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line,
             borderRadius: 10, paddingVertical: 10, paddingHorizontal: 6,
             alignItems: 'center', gap: 5 },
  doKeyOn: { backgroundColor: C.accent, borderColor: C.accent },
  doKeyText:  { fontSize: 11.5, fontWeight: '700', color: C.ink },
  doKeyTextOn:{ fontSize: 11.5, fontWeight: '700', color: '#FFFFFF' },

  /* ---------------- the small parts ---------------- */

  // its unit: a fact, quiet, never pressed
  unitPill: { fontSize: 10, letterSpacing: 0.3, fontWeight: '700', overflow: 'hidden',
              backgroundColor: C.accentSoft, color: C.accent,
              paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5 },

  // something to press, sitting inside a line: outlined, never filled
  // A PILL IS A BUTTON, AND A THUMB IS 8mm WIDE.
  //
  // These were 11px of text in 3px of padding — about 21 points tall, half
  // the size a finger can reliably hit, and two of them sit six pixels apart
  // on the bill line. One of them changes the tax on the bill and the other
  // swaps the product. They are 40 points now, which is what a phone asks
  // for, and they still read as the quiet secondary things they are.
  // SMALLER TO LOOK AT, NOT SMALLER TO HIT.
  //
  // He asked for the Change and note buttons to be smaller — they crowd the
  // line and the eye goes to them before it goes to the figures. But a 55
  // year old thumb still has to land on them, so the box shrinks and every
  // one of them carries hitSlop to keep the touch area where it was.
  tapPill: { borderWidth: 1, borderColor: C.greyB, borderStyle: 'dashed', borderRadius: 16,
             paddingHorizontal: 9, paddingVertical: 5, minHeight: 28,
             justifyContent: 'center' },
  tapPillText: { fontSize: 11, fontWeight: '600', color: C.muted },
  // the slop that gives those small pills a full-sized touch area
  pillSlop: { top: 10, bottom: 10, left: 8, right: 8 },

  // a whole row to press: the same shape, full width
  wideBtn: { borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingVertical: 14,
             alignItems: 'center', backgroundColor: C.surface, marginBottom: 12 },
  wideBtnText: { fontSize: 14.5, fontWeight: '700', color: C.muted },

  // the box a number is typed into, with its name above it
  cellLabel: { fontSize: 11, color: C.muted, marginBottom: 5, fontWeight: '600' },
  cell:      { fontSize: 16, color: C.ink, paddingHorizontal: 11, paddingVertical: 10,
               borderWidth: 1, borderColor: C.line, borderRadius: 10,
               backgroundColor: '#FFFFFF' },

  // EVERY figure in the app goes through this: amounts, quantities, rates,
  // dates, bill numbers. Monospaced and tabular, so a column adds up by eye.
  num:     { fontFamily: MONO, fontVariant: ['tabular-nums'] },
  mono:    { fontFamily: MONO },

  // kept for screens not yet restyled
  header:  { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14,
             paddingTop: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  h1:      { fontSize: 17.5, fontWeight: '700', color: C.ink, flex: 1 },
  pad:     { paddingHorizontal: 14 },
};
