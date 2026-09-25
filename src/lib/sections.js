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
      key: 'khata',
      label: 'Khata',
      icon: 'book',
      members: keep([
        { id: 'ledgers', label: 'Ledgers',    route: 'Ledgers' },
        { id: 'udhar',   label: 'Udhar',      route: 'Udhar' },
        { id: 'parties', label: 'Parties',    route: 'Parties' },
        { id: 'bills',   label: 'Past bills', route: 'Bills' },
        showReports(org) && isOwner
          && { id: 'books', label: 'Books', route: 'Books' },
      ]),
    },
    {
      key: 'stock',
      label: 'Stock',
      icon: 'stock',
      members: keep([
        // A shop that does not keep stock has no stock screen, and never had
        // a key for one. Losing that gate in the clubbing would have put a
        // Stock key in front of every kirana that had switched it off.
        showStock(org) && { id: 'stock', label: 'In hand', route: 'Stock',
                            alone: { label: 'Stock', icon: 'stock' } },
        { id: 'items', label: 'Items', route: 'Items',
          alone: { label: 'Items', icon: 'tag' } },
      ]),
    },
    (showReports(org) || showRecon(org)) && isOwner && {
      key: 'reports',
      label: 'Reports',
      icon: 'reports',
      members: keep([
        showReports(org) && { id: 'reports', label: 'Reports', route: 'Reports' },
        showRecon(org)   && { id: 'recon',   label: 'Credit',  route: 'Recon' },
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
