// Unit Quantity Codes (UQC) — the GST portal accepts ONLY these codes.
// The shopkeeper never sees a code: he sees "Pieces", the bill prints "pc",
// the database stores "PCS", and the portal gets "PCS".
//
//   code  = what the portal wants        (stored)
//   name  = what the shopkeeper picks    (shown in the picker)
//   short = what prints on the bill      (shown on screen and on paper)
//   match = words he might type instead  (so typing "kilo" finds KGS)

export const UQC = [
  { code: 'PCS', name: 'Pieces',        short: 'pc',   match: ['pc', 'pcs', 'piece', 'pieces', 'nag', 'adad'] },
  { code: 'NOS', name: 'Numbers',       short: 'nos',  match: ['no', 'nos', 'number', 'numbers'] },
  { code: 'KGS', name: 'Kilograms',     short: 'kg',   match: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram'] },
  { code: 'GMS', name: 'Grams',         short: 'gm',   match: ['g', 'gm', 'gms', 'gram', 'grams'] },
  { code: 'QTL', name: 'Quintal',       short: 'qtl',  match: ['qtl', 'quintal'] },
  { code: 'TON', name: 'Tonnes',        short: 'ton',  match: ['ton', 'tonne', 'tonnes', 'mt'] },
  { code: 'MTS', name: 'Metric Ton',    short: 'mts',  match: ['metric ton'] },
  { code: 'BAG', name: 'Bags',          short: 'bag',  match: ['bag', 'bags', 'bora'] },
  { code: 'BDL', name: 'Bundles',       short: 'bdl',  match: ['bdl', 'bundle', 'bundles', 'gattha'] },
  { code: 'BUN', name: 'Bunches',       short: 'bun',  match: ['bunch', 'bunches'] },
  { code: 'BOX', name: 'Box',           short: 'box',  match: ['box', 'boxes'] },
  { code: 'CTN', name: 'Cartons',       short: 'ctn',  match: ['ctn', 'carton', 'cartons', 'peti'] },
  { code: 'PAC', name: 'Packs',         short: 'pac',  match: ['pack', 'packs', 'packet', 'packets'] },
  { code: 'DOZ', name: 'Dozens',        short: 'doz',  match: ['doz', 'dozen', 'dozens'] },
  { code: 'GRS', name: 'Gross',         short: 'grs',  match: ['gross'] },
  { code: 'SET', name: 'Sets',          short: 'set',  match: ['set', 'sets'] },
  { code: 'PRS', name: 'Pairs',         short: 'prs',  match: ['pair', 'pairs', 'jodi'] },
  { code: 'LTR', name: 'Litres',        short: 'ltr',  match: ['l', 'ltr', 'litre', 'liter', 'litres'] },
  { code: 'MLT', name: 'Millilitres',   short: 'ml',   match: ['ml', 'millilitre', 'mililitre'] },
  { code: 'KLR', name: 'Kilolitre',     short: 'klr',  match: ['kl', 'kilolitre'] },
  { code: 'MTR', name: 'Metres',        short: 'mtr',  match: ['m', 'mtr', 'meter', 'metre', 'meters'] },
  { code: 'CMS', name: 'Centimetres',   short: 'cm',   match: ['cm', 'cms', 'centimetre'] },
  { code: 'KME', name: 'Kilometre',     short: 'km',   match: ['km', 'kilometre'] },
  { code: 'YDS', name: 'Yards',         short: 'yds',  match: ['yd', 'yard', 'yards', 'gaj'] },
  { code: 'SQF', name: 'Square Feet',   short: 'sqft', match: ['sqft', 'sq ft', 'square feet', 'feet'] },
  { code: 'SQM', name: 'Square Metres', short: 'sqm',  match: ['sqm', 'sq m', 'square metre'] },
  { code: 'SQY', name: 'Square Yards',  short: 'sqy',  match: ['sqy', 'square yard'] },
  { code: 'CBM', name: 'Cubic Metres',  short: 'cbm',  match: ['cbm', 'cubic metre'] },
  { code: 'CCM', name: 'Cubic Cm',      short: 'ccm',  match: ['ccm', 'cubic cm'] },
  { code: 'ROL', name: 'Rolls',         short: 'rol',  match: ['roll', 'rolls', 'than'] },
  { code: 'CAN', name: 'Cans',          short: 'can',  match: ['can', 'cans'] },
  { code: 'DRM', name: 'Drums',         short: 'drm',  match: ['drum', 'drums'] },
  { code: 'BTL', name: 'Bottles',       short: 'btl',  match: ['bottle', 'bottles'] },
  { code: 'TUB', name: 'Tubes',         short: 'tub',  match: ['tube', 'tubes'] },
  { code: 'TBS', name: 'Tablets',       short: 'tbs',  match: ['tablet', 'tablets'] },
  { code: 'BAL', name: 'Bale',          short: 'bal',  match: ['bale', 'bales'] },
  { code: 'BKL', name: 'Buckles',       short: 'bkl',  match: ['buckle', 'buckles'] },
  { code: 'THD', name: 'Thousands',     short: 'thd',  match: ['thousand', 'thousands'] },
  { code: 'TGM', name: 'Ten Gross',     short: 'tgm',  match: ['ten gross'] },
  { code: 'GGK', name: 'Great Gross',   short: 'ggk',  match: ['great gross'] },
  { code: 'GYD', name: 'Gross Yards',   short: 'gyd',  match: ['gross yard'] },
  { code: 'UGS', name: 'US Gallons',    short: 'ugs',  match: ['gallon', 'gallons'] },
  { code: 'UNT', name: 'Units',         short: 'unt',  match: ['unit', 'units'] },
  { code: 'BOU', name: 'Billion Units', short: 'bou',  match: ['billion'] },
  { code: 'OTH', name: 'Others',        short: 'oth',  match: ['other', 'others'] },
];

const BY_CODE = Object.fromEntries(UQC.map((u) => [u.code, u]));

// What to print on a bill or show on screen for a stored code.
// Anything unrecognised comes back unchanged, so older items still show.
export const uqcShort = (code) => BY_CODE[String(code || '').toUpperCase()]?.short || code || '';
export const uqcName  = (code) => BY_CODE[String(code || '').toUpperCase()]?.name  || code || '';
export const isUqc    = (code) => !!BY_CODE[String(code || '').toUpperCase()];

// Search as he types. "kilo" -> Kilograms, "gattha" -> Bundles, "pc" -> Pieces.
export function searchUqc(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return UQC;
  const score = (u) => {
    if (u.code.toLowerCase() === s) return 0;
    if (u.match.includes(s)) return 1;
    if (u.short.startsWith(s)) return 2;
    if (u.name.toLowerCase().startsWith(s)) return 3;
    if (u.match.some((m) => m.startsWith(s))) return 4;
    if (u.name.toLowerCase().includes(s)) return 5;
    return 99;
  };
  return UQC.map((u) => [score(u), u]).filter(([x]) => x < 99)
    .sort((a, b) => a[0] - b[0]).map(([, u]) => u);
}

// Best guess for text typed in an older system or an import file.
export const guessUqc = (text) => searchUqc(text)[0]?.code || null;
