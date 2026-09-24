// Which parts of Skwik this shop has switched on.
//
// Skwik opens as a billing book and nothing else: sale, purchase, money in,
// money out. Everything past that — returns, reports, the Tally and Excel
// files — waits behind a switch in Settings, because most counters never want
// it and a screen full of buttons nobody presses is what makes an app feel
// heavy.
//
// The switches live on the firm row, so they follow the shopkeeper onto any
// phone he logs into. A switch that is missing altogether — an app that has
// got ahead of the database — counts as on, so an update can never hide
// something a shop was already using.
const on = (v) => (v === undefined || v === null ? true : !!v);

export const showPurchase = (org) => on(org?.show_purchase);
export const showReturns  = (org) => on(org?.show_returns);
export const showReports  = (org) => on(org?.show_reports);
export const showTransfer = (org) => on(org?.show_transfer);

export const showExpenses = (org) => on(org?.show_expenses);
export const showRecon    = (org) => on(org?.show_recon);

// Stock is older than these switches and already defaults to off on the firm
// row, so it is read plainly.
export const showStock    = (org) => !!org?.stock_enabled;

// Udhar is not a switch: every shop lends, and the list is built from what is
// already in the books. It is always there.

/* ---------------- the ones that are off until a trade needs them ---------- */

// A chemist cannot sell without a batch and an expiry; a hardware shop never
// wants to see either. Both default to off, and a shop that does not switch
// them on never learns they exist.
export const showBatch    = (org) => !!org?.batch_enabled;
export const showExpiry   = (org) => !!org?.expiry_enabled;

// More than one godown. Off until a shop says it has two.
export const showGodowns  = (org) => !!org?.godowns_enabled;

// One item in several sizes, found as one name.
export const showVariants = (org) => !!org?.variants_enabled;

/* ---------------- reverse charge, which has two quite different sides ----- */

// ON A SALE it means the BUYER pays the tax to the government instead of
// paying it to the shop. Section 9(3) lists the supplies it applies to and
// they are almost all services — transport, advocates, sponsorship. A shop
// selling goods across a counter will never issue one.
//
// It was on every sale bill, immediately above the Total, reading "Tax on
// this bill is payable by the buyer (reverse charge)". "Reverse charge" reads
// like undoing a charge, so a shopkeeper correcting a mis-tap can tick it to
// reverse the last thing and quietly send out a bill with no GST on a sale he
// is required to collect on. Off until a shop says it needs it.
export const showRcmOut = (org) => !!org?.rcm_sales_enabled;

// ON A PURCHASE it is the ordinary case. Freight is the common one: a goods
// transport agency charges no GST and the shop owes it. Most weeks, for most
// shops. On for any registered shop unless he turns it off.
export const showRcmIn = (org) =>
  !!org?.is_gst_registered && on(org?.rcm_purchase_enabled);

// THE THUMB RAIL on the item search: a down arrow and an OK down the right
// hand side, so the third match on the list is two taps in the corner of the
// screen instead of a reach into the middle of it. Off until a shop asks.
export const showThumbRail = (org) => !!org?.thumb_rail;
