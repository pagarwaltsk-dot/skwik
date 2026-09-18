// HSN codes — validation and search.
//
// TWO LEVELS OF CHECKING
//   1. Shape   - 4, 6 or 8 digits, and enough digits for the firm's turnover.
//                Costs nothing, works offline, catches most mistakes.
//   2. Real    - does the code actually exist? Needs the HSN master below.
//
// ABOUT THE LIST BELOW  *** READ THIS BEFORE YOU SELL THE APP ***
// This is a STARTER list of common 4-digit headings, not the full master.
// The official master has roughly 20,000 codes including 6 and 8 digit ones.
// Download it from the GST portal and replace MASTER, or load it at startup
// with setHsnMaster(). Nothing else in the app changes - the search, the
// validation and the item screen all read whatever list is loaded.
//
// GST RATES ARE DELIBERATELY NOT IN THIS LIST. Rates change, and a wrong rate
// is a tax problem, not a typo. The shopkeeper types the rate he charges.
// If your replacement master carries a verified rate, put it in `gst_rate`
// and the item screen will fill it in automatically.

let MASTER = [
  // Iron, steel and metal goods
  { hsn: '7213', desc: 'Bars and rods of iron or non-alloy steel, hot-rolled', w: 'sariya rod tmt bar iron rod' },
  { hsn: '7214', desc: 'Other bars and rods of iron or non-alloy steel', w: 'iron bar rod flat angle' },
  { hsn: '7308', desc: 'Structures and parts of structures, of iron or steel', w: 'grill gate shutter angle channel structure truss' },
  { hsn: '7310', desc: 'Tanks, casks, drums, cans and boxes of iron or steel, up to 300 litres', w: 'steel drum tin can barrel container box' },
  { hsn: '7317', desc: 'Nails, tacks, staples and similar articles of iron or steel', w: 'nail kanti tack screw staple' },
  { hsn: '7321', desc: 'Stoves, ranges, cookers and similar appliances of iron or steel', w: 'stove chulha gas cooker angithi' },
  { hsn: '7323', desc: 'Table, kitchen and household articles of iron or steel', w: 'thali plate batti balty bucket bartan tiffin steel utensil kadai tawa dabba casserole' },
  { hsn: '7326', desc: 'Other articles of iron or steel', w: 'steel article clamp bracket hook chain' },
  { hsn: '7418', desc: 'Table, kitchen and household articles of copper' },
  { hsn: '7612', desc: 'Aluminium casks, drums, cans and boxes, up to 300 litres', w: 'aluminium drum can barrel' },
  { hsn: '7607', desc: 'Aluminium foil' },
  { hsn: '7615', desc: 'Table, kitchen and household articles of aluminium', w: 'aluminium balty bucket patila tope utensil handi foil box' },
  { hsn: '8211', desc: 'Knives with cutting blades', w: 'knife chaku blade' },
  { hsn: '8212', desc: 'Razors and razor blades' },
  { hsn: '8215', desc: 'Spoons, forks, ladles and similar kitchen or tableware', w: 'spoon chamach fork ladle karchi serving' },
  { hsn: '8301', desc: 'Padlocks and locks of base metal', w: 'lock tala padlock latch' },
  { hsn: '8302', desc: 'Mountings, fittings and similar articles of base metal', w: 'hinge handle fitting bracket runner' },
  { hsn: '8481', desc: 'Taps, cocks, valves and similar appliances', w: 'tap nal valve cock bib faucet' },
  { hsn: '9617', desc: 'Vacuum flasks and other vacuum vessels', w: 'flask thermos casserole hot pot' },

  // Plastics and rubber
  { hsn: '3917', desc: 'Tubes, pipes and hoses of plastics', w: 'pvc pipe hose tube gi pipe plumbing conduit' },
  { hsn: '3919', desc: 'Self-adhesive plates, sheets and film of plastics' },
  { hsn: '3920', desc: 'Other plates, sheets and film of plastics, non-cellular' },
  { hsn: '3921', desc: 'Other plates, sheets and film of plastics' },
  { hsn: '3922', desc: 'Baths, sinks, washbasins and sanitary ware of plastics' },
  { hsn: '3923', desc: 'Articles for conveyance or packing of goods, of plastics', w: 'plastic drum jar carboy crate container can bottle packing bag' },
  { hsn: '3924', desc: 'Tableware, kitchenware and household articles of plastics', w: 'plastic bucket mug jug tub bin basket chair stool bowl casserole water bottle dustbin' },
  { hsn: '3925', desc: 'Builders ware of plastics, including water tanks', w: 'water tank sintex tank door window pvc fitting' },
  { hsn: '3926', desc: 'Other articles of plastics', w: 'plastic article sheet hanger clip pipe fitting misc' },
  { hsn: '4011', desc: 'New pneumatic tyres of rubber', w: 'tyre tube' },

  // Glass, ceramic, stone, cement
  { hsn: '2523', desc: 'Cement, including clinker', w: 'cement bag opc ppc' },
  { hsn: '6810', desc: 'Articles of cement, concrete or artificial stone', w: 'cement block tile pole slab' },
  { hsn: '6911', desc: 'Tableware and kitchenware of porcelain or china', w: 'crockery cup plate bone china porcelain' },
  { hsn: '6912', desc: 'Ceramic tableware and kitchenware, other than porcelain', w: 'ceramic cup plate mug pottery' },
  { hsn: '6914', desc: 'Other ceramic articles' },
  { hsn: '7005', desc: 'Float glass and surface ground glass, in sheets' },
  { hsn: '7007', desc: 'Safety glass' },
  { hsn: '7009', desc: 'Glass mirrors' },
  { hsn: '7013', desc: 'Glassware for table, kitchen, toilet or office', w: 'glass tumbler bowl jar glassware' },

  // Wood, paper, printed
  { hsn: '4410', desc: 'Particle board and similar board of wood', w: 'particle board mdf' },
  { hsn: '4411', desc: 'Fibreboard of wood' },
  { hsn: '4412', desc: 'Plywood, veneered panels and similar laminated wood', w: 'plywood ply board commercial' },
  { hsn: '4802', desc: 'Uncoated paper and paperboard for writing or printing' },
  { hsn: '4818', desc: 'Toilet paper, tissues, towels and similar household paper', w: 'tissue toilet paper napkin' },
  { hsn: '4819', desc: 'Cartons, boxes, cases and bags of paper or paperboard', w: 'carton box peti packing paper' },
  { hsn: '4820', desc: 'Registers, note books, letter pads and similar articles', w: 'copy notebook register khata diary' },
  { hsn: '4901', desc: 'Printed books, brochures and similar printed matter' },
  { hsn: '9608', desc: 'Ball point pens, felt tipped pens and pencils', w: 'pen ball pen refill' },
  { hsn: '9609', desc: 'Pencils, crayons, pastels and chalks' },

  // Food and grocery
  { hsn: '0901', desc: 'Coffee' },
  { hsn: '0902', desc: 'Tea', w: 'tea chai patti' },
  { hsn: '1006', desc: 'Rice', w: 'rice chawal' },
  { hsn: '1101', desc: 'Wheat or meslin flour', w: 'atta maida flour wheat' },
  { hsn: '1102', desc: 'Cereal flours other than wheat' },
  { hsn: '1507', desc: 'Soya-bean oil and its fractions' },
  { hsn: '1511', desc: 'Palm oil and its fractions', w: 'palm oil cooking oil' },
  { hsn: '1512', desc: 'Sunflower, safflower or cotton-seed oil', w: 'sunflower oil cooking' },
  { hsn: '1517', desc: 'Margarine, edible mixtures of fats and oils', w: 'vanaspati dalda margarine' },
  { hsn: '1701', desc: 'Cane or beet sugar', w: 'sugar chini' },
  { hsn: '1704', desc: 'Sugar confectionery, not containing cocoa' },
  { hsn: '1806', desc: 'Chocolate and other food preparations containing cocoa' },
  { hsn: '1905', desc: 'Bread, pastry, cakes, biscuits and other bakers wares', w: 'biscuit bread namkeen bakery' },
  { hsn: '2106', desc: 'Food preparations not elsewhere specified' },
  { hsn: '2201', desc: 'Waters, including mineral and aerated, no added sugar', w: 'water bottle mineral packaged' },
  { hsn: '2202', desc: 'Waters with added sugar and other non-alcoholic beverages', w: 'cold drink soft drink juice beverage' },
  { hsn: '0904', desc: 'Pepper, chillies and other spices of the genus Capsicum' },
  { hsn: '0910', desc: 'Ginger, saffron, turmeric and other spices' },

  // Cleaning, personal care, medical
  { hsn: '3004', desc: 'Medicaments, in measured doses or retail packing' },
  { hsn: '3305', desc: 'Preparations for use on the hair', w: 'shampoo hair oil' },
  { hsn: '3306', desc: 'Preparations for oral or dental hygiene', w: 'toothpaste manjan brush' },
  { hsn: '3307', desc: 'Shaving preparations, deodorants and bath preparations' },
  { hsn: '3401', desc: 'Soap and organic surface-active products', w: 'soap sabun bathing' },
  { hsn: '3402', desc: 'Washing and cleaning preparations, detergents', w: 'detergent surf washing powder cleaner phenyl' },
  { hsn: '3506', desc: 'Prepared glues and adhesives', w: 'fevicol adhesive gum glue' },
  { hsn: '9603', desc: 'Brooms, brushes, mops and feather dusters', w: 'broom jhadu brush mop' },
  { hsn: '9619', desc: 'Sanitary towels, napkins and similar articles', w: 'diaper sanitary napkin pad' },

  // Textiles, clothing, footwear
  { hsn: '5208', desc: 'Woven fabrics of cotton, 85% or more cotton', w: 'cotton cloth fabric' },
  { hsn: '6109', desc: 'T-shirts, singlets and other vests, knitted' },
  { hsn: '6203', desc: 'Mens suits, jackets, trousers and shorts' },
  { hsn: '6204', desc: 'Womens suits, jackets, dresses, skirts and trousers' },
  { hsn: '6302', desc: 'Bed linen, table linen, toilet and kitchen linen', w: 'bedsheet chadar towel linen' },
  { hsn: '6303', desc: 'Curtains, blinds and bed valances' },
  { hsn: '6304', desc: 'Other furnishing articles' },
  { hsn: '6305', desc: 'Sacks and bags, for packing of goods', w: 'bora sack bag pp gunny' },
  { hsn: '6402', desc: 'Footwear with outer soles and uppers of rubber or plastics', w: 'chappal slipper shoe footwear plastic' },
  { hsn: '6403', desc: 'Footwear with uppers of leather', w: 'shoe leather footwear' },
  { hsn: '6404', desc: 'Footwear with uppers of textile materials' },
  { hsn: '4202', desc: 'Trunks, suitcases, handbags and similar containers', w: 'bag suitcase trunk purse school bag' },
  { hsn: '6601', desc: 'Umbrellas and sun umbrellas' },

  // Electrical, machines, vehicles
  { hsn: '8413', desc: 'Pumps for liquids', w: 'pump motor submersible' },
  { hsn: '8414', desc: 'Air or vacuum pumps, fans and ventilating hoods', w: 'fan exhaust cooler blower' },
  { hsn: '8415', desc: 'Air conditioning machines' },
  { hsn: '8418', desc: 'Refrigerators, freezers and other cooling equipment' },
  { hsn: '8450', desc: 'Household or laundry-type washing machines' },
  { hsn: '8506', desc: 'Primary cells and primary batteries', w: 'battery cell pencil cell' },
  { hsn: '8507', desc: 'Electric accumulators, including storage batteries', w: 'battery inverter lead acid' },
  { hsn: '8516', desc: 'Electric heaters, irons and other domestic appliances', w: 'iron press heater geyser kettle rod' },
  { hsn: '8517', desc: 'Telephone sets and other apparatus for communication' },
  { hsn: '8528', desc: 'Monitors and projectors, television receivers' },
  { hsn: '8544', desc: 'Insulated wire, cable and other insulated conductors', w: 'wire cable electric copper' },
  { hsn: '9405', desc: 'Lamps and lighting fittings', w: 'bulb light led lamp tube fitting' },
  { hsn: '8708', desc: 'Parts and accessories of motor vehicles', w: 'spare part motor vehicle' },
  { hsn: '8711', desc: 'Motorcycles and cycles with an auxiliary motor' },
  { hsn: '8714', desc: 'Parts and accessories of motorcycles and bicycles', w: 'cycle part bicycle spare' },
  { hsn: '2710', desc: 'Petroleum oils, other than crude' },

  // Furniture, household, other
  { hsn: '9401', desc: 'Seats, whether or not convertible into beds', w: 'chair sofa seat stool' },
  { hsn: '9403', desc: 'Other furniture and parts thereof', w: 'furniture almirah table rack cupboard' },
  { hsn: '9404', desc: 'Mattress supports, mattresses, quilts and pillows', w: 'mattress pillow quilt razai gadda' },
  { hsn: '3208', desc: 'Paints and varnishes in a non-aqueous medium', w: 'paint enamel varnish oil paint' },
  { hsn: '3209', desc: 'Paints and varnishes in an aqueous medium', w: 'paint emulsion distemper water paint' },
  { hsn: '3210', desc: 'Other paints, varnishes and prepared water pigments', w: 'paint primer putty' },
  { hsn: '7117', desc: 'Imitation jewellery', w: 'imitation jewellery bangle chudi artificial' },
  { hsn: '7113', desc: 'Articles of jewellery of precious metal' },
  { hsn: '9101', desc: 'Wrist watches with case of precious metal' },
  { hsn: '9102', desc: 'Other wrist watches and pocket watches' },
  { hsn: '9503', desc: 'Tricycles, dolls and other toys', w: 'toy khilona' },
  { hsn: '9506', desc: 'Articles for general physical exercise and sports' },
];

// Swap in the full master downloaded from the GST portal.
// Each entry needs { hsn, desc } and may add { gst_rate } and { w }.
// `w` is the shop words a trader would actually type - bucket, sariya, jhadu.
export function setHsnMaster(list) {
  if (Array.isArray(list) && list.length) MASTER = list;
}
export const hsnMasterSize = () => MASTER.length;

// How many digits this firm must use. The question is asked once, at sign-up.
export const minHsnDigits = (org) => (org?.turnover_above_5cr ? 6 : 4);

// Shape check. Returns null when fine, or a sentence to show the shopkeeper.
export function checkHsn(hsn, org) {
  const s = String(hsn || '').trim();
  // not registered, or a composition dealer who switched HSN off
  if (!org?.is_gst_registered) return null;
  if (org?.is_composition && org?.hsn_enabled === false) return null;
  if (!s) return 'HSN code is needed on a GST bill.';
  if (!/^\d+$/.test(s)) return 'An HSN code is numbers only.';
  if (![4, 6, 8].includes(s.length)) return 'An HSN code is 4, 6 or 8 digits.';
  const need = minHsnDigits(org);
  if (s.length < need) {
    return org.turnover_above_5cr
      ? 'Your turnover is above ₹5 crore, so HSN must be at least 6 digits.'
      : 'HSN must be at least 4 digits.';
  }
  return null;
}

// Does it exist in the loaded master? A 6 or 8 digit code is checked by its
// first 4 digits, because the starter list holds 4-digit headings only.
export const hsnExists = (hsn) => {
  const s = String(hsn || '').trim();
  return MASTER.some((m) => m.hsn === s) || MASTER.some((m) => m.hsn === s.slice(0, 4));
};

export const hsnDesc = (hsn) => {
  const s = String(hsn || '').trim();
  return (MASTER.find((m) => m.hsn === s) || MASTER.find((m) => m.hsn === s.slice(0, 4)))?.desc || '';
};

// Search by number or by words: "bucket" and "3924" both find plastics.
export function searchHsn(q, limit = 12) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return MASTER.slice(0, limit);
  const words = s.split(/\s+/).filter(Boolean);
  const score = (m) => {
    const d = m.desc.toLowerCase();
    const k = (m.w || '').toLowerCase();          // shop words: bucket, sariya, jhadu
    const both = `${d} ${k}`;
    if (m.hsn === s) return 0;
    if (m.hsn.startsWith(s)) return 1;
    if (k.split(/\s+/).includes(s)) return 2;      // exact shop word wins
    if (d.startsWith(s)) return 3;
    if (words.every((w) => both.includes(w))) return 4;
    if (words.some((w) => w.length > 2 && both.includes(w))) return 5;
    return 99;
  };
  return MASTER.map((m) => [score(m), m]).filter(([x]) => x < 99)
    .sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, m]) => m);
}
