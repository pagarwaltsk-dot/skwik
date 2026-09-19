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

// Stock is older than these switches and already defaults to off on the firm
// row, so it is read plainly.
export const showStock    = (org) => !!org?.stock_enabled;
