// FEWER DOORS, EACH LEADING TO MORE THAN ONE ROOM.
//
// The strip down the side of the day book had grown to eleven keys — Receipt,
// Payment, Udhar, Ledgers, Stock, Parties, Items, Books, Reports, Money out,
// Credit — and he said what anybody would say looking at it: stop showing so
// many things. He is right, and the reason there were eleven is that each of
// them is a separate screen and a screen needed a key.
//
// But they are not eleven different jobs. They are three:
//
//   MONEY     money that came in, money that went out, and what the shop spent
//   KHATA     who owes what, and everything written against them
//   STOCK     what is on the shelf, and the list of what he sells
//
// So the strip carries one key per job, and each screen in a job shows a row
// of its brothers along the top. One tap to the thing he does every day, one
// more to anything beside it, and the strip is short enough to read.
//
// NOTHING IS HIDDEN AND NOTHING NEW IS BUILT. Every screen here already
// existed and is unchanged; this only decides which of them stand together.

import { showExpenses, showRecon, showReports, showStock } from './features';

// A REGULAR DEALER, IN THE SENSE THE RETURNS MEAN IT.
//
// GSTR-1, 3B and 2B are the regular scheme's returns. A composition dealer
// files a CMP-08 and a GSTR-4 and claims no credit at all, and a shop with no
// registration files nothing, so naming those tabs at either of them would be
// pointing them at work that is not theirs.
const regular = (org) => !!org?.is_gst_registered && !org?.is_composition;

// `id` is what a screen calls itself so its own chip can be marked. `route`
// and `params` are handed to the navigator as they are.
export function groupsFor(org, isOwner) {
  const keep = (a) => a.filter(Boolean);

  return keep([
    {
      key: 'money',
      label: 'Money',
      icon: 'in',
      members: keep([
        { id: 'in',  label: 'Received', route: 'Money', params: { ptype: 'receipt' } },
        { id: 'out', label: 'Paid',     route: 'Money', params: { ptype: 'payment' } },
        showExpenses(org) && isOwner
          && { id: 'spent', label: 'Money out', route: 'Expenses' },
      ]),
    },
    {
      // FIVE CHIPS WERE STILL FOUR TOO MANY.
      //
      // Ledgers, Udhar and Parties were three doors into one room. A ledger IS
      // a customer's account: who he is, what he owes, and asking him for it.
      // Splitting that across three screens meant finding a man's balance on
      // one, his phone number on another, and the button that chases him on a
      // third — and it made the app look three times the size it is.
      //
      // So there is one: Ledgers, with the two sides as a filter and the edit,
      // the add and the reminder as buttons on the row itself. Udhar and
      // Parties are still there as screens — the bulk reminder and the full
      // customer form live on them — but they are reached from Ledgers, where
      // he already is, instead of from a chip that makes them look separate.
      key: 'khata',
      label: 'Khata',
      icon: 'book',
      members: keep([
        { id: 'ledgers', label: 'Ledgers',    route: 'Ledgers' },
        { id: 'bills',   label: 'Past bills', route: 'Bills' },
        showReports(org) && isOwner
          && { id: 'books', label: 'Books', route: 'Books' },
      ]),
    },
    {
      // ONE LIST, NOT TWO VIEWS OF THE SAME LIST.
      //
      // He asked the obvious question: "In hand shows stock qty, and Items
      // shows rate, why?" There was no good answer. They were the same
      // hundred names twice over, each hiding the one figure the other one
      // showed, so finding out what a thing costs and how much is left meant
      // two screens and two searches.
      //
      // Now there is one: name, what is in hand, what it sells for, and an
      // edit beside it. The item form still lives on the Items screen — it is
      // a long form and belongs on its own — but it is reached from the row,
      // where he already is, and not from a chip that makes it look like
      // another list.
      //
      // A shop that keeps no stock has no quantity to show, so for them the
      // one list is the Items screen itself, exactly as it was.
      key: 'stock',
      label: 'Stock',
      icon: 'stock',
      members: keep([
        showStock(org)
          ? { id: 'stock', label: 'Items & stock', route: 'Stock',
              alone: { label: 'Stock', icon: 'stock' } }
          : { id: 'items', label: 'Items', route: 'Items',
              alone: { label: 'Items', icon: 'tag' } },
      ]),
    },
    (showReports(org) || showRecon(org)) && isOwner && {
      // THE THREE RETURNS, AND THE SHOP'S OWN FIGURES.
      //
      // Everything a registered shop files sat on one long scroll with the
      // month's sales, so the boxes his accountant asks for were somewhere
      // below the day-by-day list. A return is a thing you do once a month
      // with a deadline; the sales summary is a thing you look at every
      // evening. They are not the same page.
      //
      // So: Summary for the shop, and one tab per return, named the way the
      // portal names them — GSTR-1 for what he sold, GSTR-3B for what he
      // pays, GSTR-2B for the credit his suppliers have declared. Only for a
      // regular registered dealer; a composition shop and an unregistered
      // counter file none of these and see Summary alone.
      key: 'reports',
      label: 'Reports',
      icon: 'reports',
      members: keep([
        showReports(org) && { id: 'reports', label: 'Summary', route: 'Reports' },
        showReports(org) && regular(org)
          && { id: 'gstr1',  label: 'GSTR-1',  route: 'Reports', params: { view: 'gstr1' } },
        showReports(org) && regular(org)
          && { id: 'gstr3b', label: 'GSTR-3B', route: 'Reports', params: { view: 'gstr3b' } },
        showRecon(org) && regular(org)
          && { id: 'recon',  label: 'GSTR-2B', route: 'Recon' },
      ]),
    },
  ].map((g) => {
    if (!g || g.members.length !== 1) return g;
    // A GROUP OF ONE IS NOT A GROUP. When the features leave a single screen
    // standing, the key says what that screen is rather than naming a job it
    // is now the whole of — "Items", not "Stock".
    const solo = g.members[0].alone;
    return solo ? { ...g, label: solo.label, icon: solo.icon } : g;
  }).filter((g) => g && g.members.length));
}

// The group a screen belongs to, and its own place in it.
export function groupOf(org, isOwner, id) {
  for (const g of groupsFor(org, isOwner)) {
    if (g.members.some((m) => m.id === id)) return g;
  }
  return null;
}
