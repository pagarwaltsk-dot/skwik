import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { C, S } from '../theme';

// THE PARTS THE REGISTER IS MADE OF.
//
// A ruled book has three things on a page: a strip naming the columns, the
// lines themselves, and a block of totals at the foot. They are here once so
// every screen rules its page the same way, and so changing how a line looks
// changes it everywhere at once.

/* ---------------- the icons, drawn as line art ---------------- */
//
// Stroke drawings rather than a font or emoji: they take the colour of the
// text beside them, they stay sharp at any size, and they add nothing to the
// download.

/* ---------------- one ruled line ---------------- */

// left      the words: a name, and a quieter line under it
// right     the figure, or anything else that belongs at the end
// live      the line being typed into right now: white, with a mark down its left
export function Rule({ children, onPress, live, last, style }) {
  const body = (
    <View style={[S.rule,
                  live && S.ruleLive,
                  last && { borderBottomWidth: 0 },
                  style]}>
      {children}
    </View>
  );
  if (!onPress) return body;
  return <TouchableOpacity onPress={onPress} activeOpacity={0.6}>{body}</TouchableOpacity>;
}

// the words on a ruled line
export function Words({ name, sub, flex = 1, numberOfLines = 1 }) {
  return (
    <View style={{ flex, minWidth: 0 }}>
      <Text numberOfLines={numberOfLines} style={S.ruleNm}>{name}</Text>
      {!!sub && <Text numberOfLines={1} style={S.ruleSub}>{sub}</Text>}
    </View>
  );
}

// a figure at the end of a line
export function Figure({ children, width, tone, size = 13.5, weight = '600' }) {
  return (
    <Text style={[S.num, { fontSize: size, fontWeight: weight,
                           color: tone || C.ink,
                           textAlign: width ? 'right' : undefined },
                  width ? { width } : null]}>
      {children}
    </Text>
  );
}

/* ---------------- the strip that names the columns ---------------- */

// cols   [{ label, width }] — a column with no width takes what is left
export function ColHead({ cols }) {
  return (
    <View style={S.colHead}>
      {cols.map((c, i) => (
        <Text key={i}
          style={[S.colName,
                  c.width ? { width: c.width, textAlign: 'right' } : { flex: 1 }]}>
          {c.label}
        </Text>
      ))}
    </View>
  );
}

/* ---------------- the block of totals at the foot ---------------- */

// rows   [{ label, amount, strong }] — the last strong row is the one that
//        matters, and it is the only figure on the page set large
export function Totals({ rows, style }) {
  return (
    <View style={[{ backgroundColor: C.surface, borderTopWidth: 1.5,
                    borderTopColor: C.ink, paddingHorizontal: 14, paddingVertical: 11 },
                  style]}>
      {rows.map((r, i) => (
        <View key={i} style={[S.tline, r.strong && { paddingTop: 5 }]}>
          <Text style={[S.tlineK, r.strong && { fontSize: 13.5, fontWeight: '700', color: C.ink }]}>
            {r.label}
          </Text>
          <Text style={[S.tlineV, r.strong && { fontSize: 19, fontWeight: '700', color: C.ink }]}>
            {r.amount}
          </Text>
        </View>
      ))}
    </View>
  );
}

/* ---------------- the strip of things to do ---------------- */

// A phone has no F-keys, so nothing here pretends it does: each is a picture
// and a word, and the first one — the thing this shop does forty times a day —
// is the only one filled in.
export function DoKey({ label, icon, on, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}
      style={[S.doKey, on && S.doKeyOn]}>
      <Glyph name={icon} color={on ? '#FFFFFF' : C.ink} />
      <Text style={on ? S.doKeyTextOn : S.doKeyText}>{label}</Text>
    </TouchableOpacity>
  );
}

/* ---------------- the glyphs ---------------- */
//
// Drawn from plain views rather than an SVG library, so the app carries no
// extra package for seven small pictures. Each is a shape a shopkeeper can
// name: a bill, a carton, an arrow in, an arrow out, a circle going back, a
// stack, a rising line.

export function Glyph({ name, color = C.ink, size = 18 }) {
  const s = size;
  const line = (extra) => ({ position: 'absolute', backgroundColor: color, ...extra });

  if (name === 'sale') {
    return (
      <View style={{ width: s, height: s }}>
        <View style={{ position: 'absolute', left: s * 0.18, top: 0, right: s * 0.18,
                       bottom: s * 0.12, borderWidth: 1.6, borderColor: color, borderRadius: 2 }} />
        <View style={line({ left: s * 0.34, top: s * 0.3, width: s * 0.32, height: 1.6 })} />
        <View style={line({ left: s * 0.34, top: s * 0.52, width: s * 0.32, height: 1.6 })} />
      </View>
    );
  }
  if (name === 'purchase') {
    return (
      <View style={{ width: s, height: s }}>
        <View style={{ position: 'absolute', left: s * 0.08, top: s * 0.24, right: s * 0.08,
                       bottom: s * 0.1, borderWidth: 1.6, borderColor: color, borderRadius: 2 }} />
        <View style={line({ left: s * 0.08, top: s * 0.44, right: s * 0.08, height: 1.6 })} />
        <View style={line({ left: s * 0.46, top: s * 0.44, width: 1.6, bottom: s * 0.1 })} />
      </View>
    );
  }
  if (name === 'in' || name === 'out') {
    const up = name === 'in';
    return (
      <View style={{ width: s, height: s }}>
        <View style={line({ left: s * 0.47, top: s * 0.12, width: 1.8, height: s * 0.68 })} />
        <View style={{ position: 'absolute', left: s * 0.27,
                       top: up ? s * 0.2 : s * 0.46,
                       width: s * 0.44, height: s * 0.34,
                       borderLeftWidth: 1.8, borderColor: color,
                       ...(up ? { borderTopWidth: 1.8 } : { borderBottomWidth: 1.8 }),
                       transform: [{ rotate: '45deg' }] }} />
      </View>
    );
  }
  if (name === 'return') {
    return (
      <View style={{ width: s, height: s }}>
        <View style={{ position: 'absolute', left: s * 0.1, top: s * 0.14,
                       width: s * 0.8, height: s * 0.72, borderRadius: s * 0.4,
                       borderWidth: 1.7, borderColor: color, borderTopColor: 'transparent' }} />
        <View style={line({ left: s * 0.08, top: s * 0.08, width: s * 0.3, height: 1.7 })} />
        <View style={line({ left: s * 0.08, top: s * 0.08, width: 1.7, height: s * 0.28 })} />
      </View>
    );
  }
  if (name === 'stock') {
    return (
      <View style={{ width: s, height: s }}>
        <View style={{ position: 'absolute', left: s * 0.18, top: s * 0.1, width: s * 0.5,
                       height: s * 0.5, borderWidth: 1.6, borderColor: color,
                       transform: [{ rotate: '45deg' }], borderRadius: 2 }} />
        <View style={line({ left: s * 0.06, top: s * 0.66, width: s * 0.4, height: 1.6,
                            transform: [{ rotate: '28deg' }] })} />
        <View style={line({ left: s * 0.54, top: s * 0.66, width: s * 0.4, height: 1.6,
                            transform: [{ rotate: '-28deg' }] })} />
      </View>
    );
  }
  if (name === 'reports') {
    return (
      <View style={{ width: s, height: s }}>
        <View style={line({ left: s * 0.1, top: s * 0.1, width: 1.7, height: s * 0.8 })} />
        <View style={line({ left: s * 0.1, top: s * 0.82, width: s * 0.8, height: 1.7 })} />
        <View style={line({ left: s * 0.26, top: s * 0.54, width: s * 0.2, height: 1.7,
                            transform: [{ rotate: '-40deg' }] })} />
        <View style={line({ left: s * 0.46, top: s * 0.44, width: s * 0.18, height: 1.7,
                            transform: [{ rotate: '25deg' }] })} />
        <View style={line({ left: s * 0.6, top: s * 0.36, width: s * 0.26, height: 1.7,
                            transform: [{ rotate: '-38deg' }] })} />
      </View>
    );
  }
  if (name === 'people') {
    return (
      <View style={{ width: s, height: s }}>
        <View style={{ position: 'absolute', left: s * 0.3, top: s * 0.08, width: s * 0.4,
                       height: s * 0.4, borderRadius: s * 0.2, borderWidth: 1.6,
                       borderColor: color }} />
        <View style={{ position: 'absolute', left: s * 0.12, top: s * 0.56, right: s * 0.12,
                       height: s * 0.42, borderTopLeftRadius: s * 0.3,
                       borderTopRightRadius: s * 0.3, borderWidth: 1.6,
                       borderBottomWidth: 0, borderColor: color }} />
      </View>
    );
  }
  if (name === 'tag') {
    return (
      <View style={{ width: s, height: s }}>
        <View style={{ position: 'absolute', left: s * 0.08, top: s * 0.08, width: s * 0.62,
                       height: s * 0.62, borderWidth: 1.6, borderColor: color, borderRadius: 3,
                       transform: [{ rotate: '45deg' }] }} />
        <View style={{ position: 'absolute', left: s * 0.3, top: s * 0.3, width: s * 0.16,
                       height: s * 0.16, borderRadius: s * 0.08, borderWidth: 1.6,
                       borderColor: color }} />
      </View>
    );
  }
  if (name === 'search') {
    return (
      <View style={{ width: s, height: s }}>
        <View style={{ position: 'absolute', left: s * 0.06, top: s * 0.06, width: s * 0.62,
                       height: s * 0.62, borderRadius: s * 0.31, borderWidth: 1.7,
                       borderColor: color }} />
        <View style={line({ left: s * 0.62, top: s * 0.68, width: s * 0.3, height: 1.8,
                            transform: [{ rotate: '45deg' }] })} />
      </View>
    );
  }
  if (name === 'book') {
    return (
      <View style={{ width: s, height: s }}>
        <View style={{ position: 'absolute', left: s * 0.12, top: s * 0.08, right: s * 0.08,
                       bottom: s * 0.08, borderWidth: 1.6, borderColor: color, borderRadius: 2 }} />
        <View style={line({ left: s * 0.3, top: s * 0.08, width: 1.6, bottom: s * 0.08 })} />
      </View>
    );
  }
  // a dot, when something has no picture of its own yet
  return <View style={{ width: s * 0.5, height: s * 0.5, borderRadius: 2,
                        backgroundColor: color, marginVertical: s * 0.25 }} />;
}
