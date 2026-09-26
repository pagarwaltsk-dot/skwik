// ===========================================================================
//  ASKING SETTINGS A QUESTION.
//
//  A shopkeeper does not know that the thing he wants is called
//  "godowns_enabled", and he should not have to. He knows what he wants to
//  do: "what if I have more than one godown". So the box at the top of
//  Settings takes the question and finds the switch.
//
//  WHY THERE IS NO MODEL BEHIND THIS.
//
//  It is a dictionary and a scoring function, and that is deliberate. It
//  answers in the same instant on a dead signal in a shop in Fancy Bazar; it
//  costs nothing to run; and it can only ever say something we decided in
//  advance to say. A wrong answer here is a shopkeeper turning on the wrong
//  thing in his own books, so being predictable matters more than being
//  clever.
//
//  HOW A MATCH IS SCORED.
//
//    1. The question is lower-cased and the words that carry no meaning are
//       dropped — what, if, I, have, can, we, how, do, my, one. "what if I
//       have more than one godown" becomes "more than godown".
//    2. Every entry carries the words people actually use for it, weighted:
//       its own name is worth 3, a known synonym 2, a loose association 1.
//    3. A question that lands almost entirely on one entry gets a bonus, so
//       a whole phrase beats a stray word.
//    4. Anything above the floor is shown, best first, four at most.
//
//  Adding to this file is the whole job of improving it: a new phrasing goes
//  in the list, and it is found from then on.
// ===========================================================================

const STOP = ('what if i have having has can we could how do does to my me is are there a an the '
  + 'for in of on it you us want need get be able should would will shall am and or but that this '
  + 'these those with without when our your one my').split(' ');

// kind: 'switch' — the flag it flips, shown and flippable in the answer
//       'screen' — the route it opens
export const FEATURES = [
  {
    key: 'godowns_enabled', kind: 'switch', name: 'More than one godown',
    where: 'Settings',
    msg: 'Turn this on and every bill asks which store the goods left, Stock shows each store '
       + 'separately, and a Move tab appears under Stock for shifting goods between them. Off, '
       + 'Skwik behaves as though you have one place and never asks.',
    w3: ['godown', 'godowns'],
    w2: ['store', 'stores', 'warehouse', 'gala', 'godam', 'branch', 'another', 'place', 'second'],
    w1: ['more', 'two', 'transfer', 'move', 'shift', 'location', 'chamber', 'napaukhry'],
  },
  {
    key: 'show_transfer', kind: 'switch', name: 'Import & export', route: 'Transfer',
    where: 'More → Import & export',
    msg: 'Export your day book out of Tally as XML and bring it in here: sales, purchases, '
       + 'receipts, payments and godown transfers. It reads the file and tells you what it found '
       + 'before it writes a single bill, pressing it twice writes nothing the second time, and '
       + 'anything that went in wrong can be taken back out in one press.',
    w3: ['tally', 'import', 'export'],
    w2: ['xml', 'daybook', 'day', 'book', 'backup', 'restore', 'excel', 'spreadsheet', 'csv',
         'migrate', 'bring', 'shift'],
    w1: ['automatically', 'data', 'old', 'previous', 'existing', 'copy', 'out', 'file', 'upload',
         'accountant', 'undo', 'phone'],
  },
  {
    key: 'stock_enabled', kind: 'switch', name: 'Stock quantities',
    where: 'Settings',
    msg: 'Shows what is left on the shelf against every item, warns you when a bill would take out '
       + 'more than you have, and gives you a stock count to correct the figure when it drifts. '
       + 'Off, an item carries a name and a rate and nothing else.',
    w3: ['stock', 'quantity', 'quantities'],
    w2: ['shelf', 'left', 'inventory', 'remaining', 'balance'],
    w1: ['count', 'many', 'item', 'items', 'hand', 'short'],
  },
  {
    key: 'variants_enabled', kind: 'switch', name: 'Sizes of one item',
    where: 'Settings',
    msg: '9x2, 9x3, 10x2 clip tiffin held as one product in three sizes, found by the name you '
       + 'sell it as, each size with its own rate and its own stock.',
    w3: ['size', 'sizes', 'variant', 'variants'],
    w2: ['9x2', '10x2', 'inch', 'clip', 'tiffin', 'measurement'],
    w1: ['same', 'different', 'group', 'name'],
  },
  {
    kind: 'screen', name: 'Also sold by the dozen', route: 'Items',
    where: 'Items → open an item',
    msg: 'On any item, set a second unit and how many pieces are in it — a dozen is twelve — '
       + 'with its own rate if you price it differently. Bill in dozens and the shelf still gives '
       + 'up pieces.',
    w3: ['dozen', 'doz', 'unit', 'units'],
    w2: ['piece', 'pieces', 'pcs', 'bundle', 'bdl', 'bag', 'box', 'packet', 'carton', 'kg', 'litre'],
    w1: ['sell', 'sale', 'both', 'convert', 'conversion', 'alternate'],
  },
  {
    key: 'making_enabled', kind: 'switch', name: 'Things made of other things',
    where: 'Settings',
    msg: 'For a shop that makes what it sells. A set is put together as it is sold — bill one '
       + 'bucket and a body, two handles and a lid come off the shelf. A made item is produced '
       + 'first and held in stock, with its cost rolled up from what went into it.',
    w3: ['manufacture', 'manufacturing', 'making', 'make', 'kit', 'set', 'bom'],
    w2: ['bucket', 'drum', 'lid', 'handle', 'body', 'parts', 'assemble', 'produce', 'factory',
         'material', 'recipe'],
    w1: ['made', 'own', 'components', 'build', 'together', 'cost'],
  },
  {
    key: 'batch_enabled', kind: 'switch', name: 'Batches and expiry',
    where: 'Settings',
    msg: 'For a chemist, or anyone selling goods with a date on them. Every line takes a batch and '
       + 'an expiry, stock is held batch by batch, and a batch past its date is marked on the '
       + 'stock list.',
    w3: ['batch', 'batches', 'expiry', 'expire', 'expired'],
    w2: ['medicine', 'chemist', 'pharmacy', 'food', 'lot', 'date'],
    w1: ['life', 'number', 'old'],
  },
  {
    key: 'show_reports', kind: 'switch', name: 'Reports and GST returns', route: 'Reports',
    where: 'Settings',
    msg: 'Adds a Reports tab: the month’s summary, GSTR-1 as a file for the portal, and the '
       + 'GSTR-3B boxes worked out for whoever files for you. Only the returns a regular '
       + 'registered dealer files are shown.',
    w3: ['report', 'reports', 'gstr', 'gstr1', 'gstr3b', 'return', 'returns'],
    w2: ['gst', 'portal', 'filing', 'summary', '3b', 'monthly', 'turnover', 'tax'],
    w1: ['file', 'accountant', 'ca', 'department', 'sales'],
  },
  {
    key: 'show_recon', kind: 'switch', name: 'GSTR-2B matching', route: 'Recon',
    where: 'Settings',
    msg: 'Download 2B from the portal and Skwik matches it against your purchase entries, bill by '
       + 'bill, so you can see which supplier has not declared yours and what credit you are '
       + 'about to lose.',
    w3: ['2b', 'gstr2b', 'itc', 'reconcile', 'reconciliation'],
    w2: ['credit', 'input', 'supplier', 'declared', 'match', 'matching', 'portal'],
    w1: ['missing', 'claim', 'lost', 'purchase'],
  },
  {
    key: 'show_purchase', kind: 'switch', name: 'Purchase entries',
    where: 'Settings',
    msg: 'Bills your suppliers give you, with their own bill number and date. They put goods on '
       + 'your shelf, they carry the input credit you claim, and without them Skwik cannot tell '
       + 'you what you earned.',
    w3: ['purchase', 'purchases', 'buy', 'buying', 'bought'],
    w2: ['supplier', 'vendor', 'inward', 'stock', 'received'],
    w1: ['goods', 'bill', 'party', 'credit'],
  },
  {
    key: 'show_returns', kind: 'switch', name: 'Goods coming back',
    where: 'Settings',
    msg: 'Adds credit notes and debit notes. Open the bill the goods went out on, say what came '
       + 'back, and the stock, the customer’s balance and the GST all follow — without '
       + 'touching the original bill.',
    w3: ['return', 'returns', 'credit', 'note'],
    w2: ['back', 'refund', 'rejected', 'damaged', 'debit', 'replace'],
    w1: ['goods', 'customer', 'sent', 'came', 'wrong'],
  },
  {
    key: 'show_expenses', kind: 'switch', name: 'Rent, salary and other spending',
    route: 'Expenses', where: 'Settings',
    msg: 'Money that leaves the shop and is not a purchase — rent, salary, electricity, tea. '
       + 'It shows in your cash book and comes off your profit, and where GST applies on freight '
       + 'it is worked out for you.',
    w3: ['expense', 'expenses', 'rent', 'salary'],
    w2: ['spending', 'spent', 'electricity', 'tea', 'wages', 'freight', 'transport', 'petrol'],
    w1: ['money', 'out', 'overhead', 'paid', 'shop'],
  },
  {
    kind: 'screen', name: 'Who owes you — Udhar', route: 'Ledgers',
    where: 'Khata → Ledgers',
    msg: 'Always on, and built out of bills you have already written — there is nothing to '
       + 'switch. It lists everyone who owes you, oldest first, with a WhatsApp reminder on each '
       + 'row and a bulk reminder for the whole list.',
    w3: ['udhar', 'owes', 'owe', 'due', 'dues'],
    w2: ['baki', 'khata', 'outstanding', 'pending', 'collect', 'reminder', 'ledger', 'receivable'],
    w1: ['customer', 'paying', 'list', 'whatsapp', 'remind', 'recover', 'money'],
  },
  {
    kind: 'screen', name: 'Someone else writes the bills', route: 'Staff',
    where: 'Settings → Staff',
    msg: 'Add a phone number and that person can write bills on his own phone. He cannot cancel a '
       + 'bill, write off a debt, close your books, or see your balance sheet or your profit. '
       + 'Your accountant can be added as look-only.',
    w3: ['staff', 'employee', 'worker'],
    w2: ['boy', 'counter', 'manager', 'accountant', 'ca', 'login', 'permission', 'role', 'team'],
    w1: ['someone', 'else', 'bills', 'write', 'share', 'phone', 'allowed', 'person'],
  },
  {
    kind: 'screen', name: 'Bill numbering', route: 'Settings',
    where: 'Settings → Numbering',
    msg: 'Set the number your next bill takes, a prefix in front of it, and whether numbering '
       + 'starts again each April. A cancelled bill keeps its number, so there is never a gap in '
       + 'the series for anybody to ask about.',
    w3: ['number', 'numbering', 'prefix', 'series'],
    w2: ['invoice', 'bill', 'start', 'continue', 'april', 'year', 'sequence', 'sgs'],
    w1: ['change', 'next', 'reset', 'again', '100'],
  },
  {
    kind: 'screen', name: 'What you own and owe outside the books', route: 'Standing',
    where: 'Khata → Books',
    msg: 'A bank loan, the shop, a vehicle, a deposit paid or taken — things no bill or '
       + 'receipt will ever mention. Enter each one once and your balance sheet becomes your '
       + 'whole net worth instead of a piece of it.',
    w3: ['loan', 'balance', 'sheet', 'capital'],
    w2: ['bank', 'vehicle', 'building', 'machinery', 'deposit', 'asset', 'liability', 'networth',
         'worth', 'owned'],
    w1: ['owe', 'borrowed', 'emi', 'property', 'books'],
  },
  {
    key: 'rcm_purchase_enabled', kind: 'switch', name: 'Reverse charge on a purchase',
    where: 'Settings',
    msg: 'The ordinary case is freight: a transport agency charges you no GST and you owe it to '
       + 'the government yourself. Tick it on a purchase and Skwik works out the tax, keeps it '
       + 'out of what you pay the supplier, and claims it back as credit.',
    w3: ['reverse', 'charge', 'rcm'],
    w2: ['freight', 'transport', 'gta', 'agency', 'self'],
    w1: ['tax', 'government', 'lorry', 'truck', 'pay'],
  },
  {
    key: 'thumb_rail', kind: 'switch', name: 'One-handed picking',
    where: 'Settings',
    msg: 'Puts a down arrow and an OK down the right-hand edge while you search for an item, so '
       + 'the third match is two taps in the corner instead of a reach into the middle of the '
       + 'screen.',
    w3: ['thumb', 'handed', 'arrow'],
    w2: ['hand', 'reach', 'corner', 'fast', 'quick', 'keyboard'],
    w1: ['search', 'pick', 'tap', 'screen'],
  },
  {
    kind: 'screen', name: 'Close a month you have filed', route: 'Settings',
    where: 'Settings → Closing the books',
    msg: 'Once a return is filed, close the books up to that date. Nothing dated on or before it '
       + 'can then be written, changed or cancelled — by you or by anyone on your counter — '
       + 'so the figures behind a return you have already sent cannot move.',
    w3: ['close', 'closed', 'lock', 'closing'],
    w2: ['filed', 'month', 'freeze', 'final', 'audit', 'period'],
    w1: ['books', 'change', 'stop', 'after'],
  },
  {
    kind: 'screen', name: 'A month of practice bills', route: 'Sample',
    where: 'More → Try it with a month of bills',
    msg: 'Writes a month of ordinary bills into your books out of your own items and your own '
       + 'customers, so you can see what Skwik looks like with something in it. Every one can be '
       + 'opened and changed, and the whole run comes out again in one press.',
    w3: ['practice', 'sample', 'demo', 'try'],
    w2: ['test', 'example', 'dummy', 'fill', 'month', 'empty', 'learn'],
    w1: ['see', 'look', 'first', 'new', 'bills'],
  },
];

export function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w && STOP.indexOf(w) < 0);
}

function score(query, item) {
  const ws = words(query);
  if (!ws.length) return 0;
  const nameWords = words(item.name);
  const bands = [[item.w3 || [], 3], [item.w2 || [], 2], [item.w1 || [], 1]];
  let s = 0;
  const hit = {};
  ws.forEach((w) => {
    if (hit[w]) return;
    let best = 0;
    if (nameWords.indexOf(w) >= 0) best = 3;
    bands.forEach((b) => {
      if (best >= b[1]) return;
      for (let i = 0; i < b[0].length; i++) {
        const k = b[0][i];
        // a prefix counts, so "godowns" finds "godown" and "expiring" finds "expiry"
        if (k === w || (w.length > 4 && k.indexOf(w) === 0) || (k.length > 4 && w.indexOf(k) === 0)) {
          best = b[1]; break;
        }
      }
    });
    if (best) { s += best; hit[w] = 1; }
  });
  const covered = Object.keys(hit).length;
  if (covered >= 2) s += covered;
  if (covered === ws.length && ws.length >= 2) s += 3;
  return s;
}

// The floor is 3: one word of a name, or one word people really use for it.
// Below that the answer would be a guess, and a guess here is a shopkeeper
// turning on the wrong thing.
//
// One word on its own is the exception. A man who types just "godam" has
// given his whole question, and it is worth 2 because it is a synonym rather
// than the name — holding him to 3 would answer nothing at all. With a single
// word there is nothing else it could be about, so 2 is enough.
export function ask(query, { limit = 4 } = {}) {
  const ws = words(query);
  if (!ws.length) return [];
  const floor = ws.length === 1 ? 2 : 3;
  return FEATURES
    .map((it) => ({ it, s: score(query, it) }))
    .filter((r) => r.s >= floor)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.it);
}

// What to show him when nothing matched. Not a shrug: the things shops ask
// for most, so there is somewhere to go from a dead end.
export const COMMONEST = ['show_transfer', 'stock_enabled', 'show_reports', 'godowns_enabled'];

export const commonest = () =>
  COMMONEST.map((k) => FEATURES.find((f) => f.key === k)).filter(Boolean);
