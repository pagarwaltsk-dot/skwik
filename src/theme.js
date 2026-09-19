// The Hanumansh look, carried over exactly: the same colours, the same
// spacing, the same radii. Change anything here and the whole app follows.

export const C = {
  bg:       '#F4F6F8',
  surface:  '#FFFFFF',
  card:     '#FFFFFF',
  ink:      '#16202B',
  muted:    '#6B7A8B',
  line:     '#E2E7EC',
  soft:     '#FAFBFC',

  accent:   '#0B7A6B',   // teal — every action button
  accentSoft:'#E6F2F0',
  danger:   '#B4413C',
  wa:       '#1DA851',   // whatsapp green

  flag:     '#E0A800',   // the star
  flagSoft: '#FFFBF0',
  flagLine: '#E8C86A',
  flagInk:  '#8A5A00',

  ok:       '#2E9E5B',   // the tick
  okSoft:   '#EDF7F1',
  okLine:   '#BFE3CC',

  edit:     '#8A5A00',
  editSoft: '#FDF3DC',
  faint:    '#9FB0BD',
  greyB:    '#C6CFD6',

  // older names, kept so nothing breaks
  green:    '#0B7A6B',
  greenD:   '#08574C',
  greenL:   '#E6F2F0',
  red:      '#B4413C',
  redL:     '#FBEDEC',
  grey:     '#F4F6F8',
};

export const R = 14;

export const S = {
  screen:  { flex: 1, backgroundColor: C.bg },
  wrap:    { padding: 14, paddingHorizontal: 12 },

  // the dark bar across the top: who it is for, and what it comes to
  bar:     { backgroundColor: C.ink, paddingHorizontal: 12, paddingVertical: 10,
             flexDirection: 'row', alignItems: 'center', gap: 10 },
  barName: { fontSize: 16, fontWeight: '700', color: '#FFFFFF', letterSpacing: -0.2 },
  barSub:  { fontSize: 12, color: '#FFFFFF', opacity: 0.72, letterSpacing: 0.6 },
  barTotL: { fontSize: 9, letterSpacing: 1.2, color: '#FFFFFF', opacity: 0.62 },
  barTot:  { fontSize: 19, fontWeight: '700', color: '#FFFFFF', letterSpacing: -0.3 },

  card:    { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line,
             borderRadius: R, padding: 14, marginBottom: 12 },
  eyebrow: { fontSize: 11, letterSpacing: 1.2, color: C.muted, fontWeight: '600',
             textTransform: 'uppercase', marginBottom: 9 },
  label:   { fontSize: 12, color: C.muted, marginBottom: 4 },

  input:   { fontSize: 16, color: C.ink, paddingHorizontal: 12, paddingVertical: 11,
             borderWidth: 1, borderColor: C.line, borderRadius: 9, backgroundColor: '#FFFFFF' },

  hit:     { paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: 1,
             borderBottomColor: C.line, flexDirection: 'row', alignItems: 'center', gap: 10 },
  hitName: { fontSize: 15, color: C.ink },
  hitSub:  { fontSize: 11, color: C.muted, marginTop: 2 },
  hitPr:   { fontSize: 15, fontWeight: '700', color: C.ink },

  line:    { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line,
             borderRadius: R, padding: 12, marginBottom: 10 },
  lineNm:  { fontSize: 15, fontWeight: '600', color: C.ink, lineHeight: 19 },
  amt:     { fontSize: 16, fontWeight: '700', color: C.ink, textAlign: 'right' },

  tline:   { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  tlineK:  { fontSize: 15, color: C.muted },
  tlineV:  { fontSize: 15, color: C.ink },

  foot:    { backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.line,
             paddingHorizontal: 12, paddingTop: 10, paddingBottom: 22,
             flexDirection: 'row', alignItems: 'center', gap: 10 },
  footL:   { fontSize: 11, color: C.muted, letterSpacing: 0.6 },
  footTot: { fontSize: 24, fontWeight: '700', color: C.ink, letterSpacing: -0.5 },

  btn:     { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 15,
             paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  btnGhost:{ backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, borderRadius: 10,
             paddingVertical: 11, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  ghostText:{ fontSize: 14, fontWeight: '600', color: C.ink },

  chip:    { fontSize: 10, letterSpacing: 0.6, backgroundColor: C.accentSoft, color: C.accent,
             paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20, fontWeight: '700',
             overflow: 'hidden' },
  qbadge:  { fontSize: 11, fontWeight: '700', backgroundColor: C.ink, color: '#FFFFFF',
             paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20, overflow: 'hidden' },
  hint:    { fontSize: 11.5, color: C.muted, marginTop: 6, lineHeight: 16 },

  row:     { flexDirection: 'row', alignItems: 'center', gap: 10 },

  // ---- the small parts, so every screen says the same thing the same way ----
  //
  // One weight for a name (600), one for a number that matters (700), and
  // nothing heavier anywhere. Uppercase is for section labels only. A pill is
  // either a fact about the line (its unit) or something to press (change,
  // note) — and those two never look alike.

  // its unit: a fact, quiet, never pressed
  unitPill: { fontSize: 10.5, letterSpacing: 0.4, fontWeight: '700', overflow: 'hidden',
              backgroundColor: C.accentSoft, color: C.accent,
              paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },

  // something to press, sitting inside a line: outlined, never filled
  tapPill: { borderWidth: 1, borderColor: C.greyB, borderStyle: 'dashed', borderRadius: 20,
             paddingHorizontal: 10, paddingVertical: 3 },
  tapPillText: { fontSize: 11, fontWeight: '600', color: C.muted },

  // a whole row to press: the same shape, full width
  wideBtn: { borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingVertical: 14,
             alignItems: 'center', backgroundColor: C.surface, marginBottom: 12 },
  wideBtnText: { fontSize: 14.5, fontWeight: '600', color: C.muted },

  // the box a number is typed into, with its name above it
  cellLabel: { fontSize: 11.5, color: C.muted, marginBottom: 5 },
  cell:      { fontSize: 16, color: C.ink, paddingHorizontal: 11, paddingVertical: 10,
               borderWidth: 1, borderColor: C.line, borderRadius: 10,
               backgroundColor: '#FFFFFF' },
  num:     { fontVariant: ['tabular-nums'] },

  // kept for screens not yet restyled
  header:  { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12,
             paddingTop: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  h1:      { fontSize: 18, fontWeight: '700', color: C.ink, flex: 1 },
  pad:     { paddingHorizontal: 12 },
};
