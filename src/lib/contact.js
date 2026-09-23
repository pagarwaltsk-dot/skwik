// WHERE "WRITE TO US" ACTUALLY GOES.
//
// Three places in Skwik told the shopkeeper to get in touch — the forgotten
// password screen, the message shown when something breaks, and the account
// closing notes — and not one of them named an address. There was no email,
// no number and no website anywhere in the app or in app.json. A man locked
// out of his own books was told to write to somebody, with nobody to write
// to.
//
// ─────────────────────────────────────────────────────────────────────────
//  FILL THESE IN BEFORE YOU GIVE THE APP TO ANYONE.
//  A number with the country code and no spaces, e.g. '919864012345'.
// ─────────────────────────────────────────────────────────────────────────
export const SUPPORT_WHATSAPP = '';        // e.g. '919864012345'
export const SUPPORT_EMAIL    = '';        // e.g. 'help@skwik.in'

// What to show him. If neither is filled in, Skwik says nothing rather than
// promising help that has no address behind it.
export const supportLine = () => {
  const bits = [];
  if (SUPPORT_WHATSAPP) bits.push(`WhatsApp ${SUPPORT_WHATSAPP.replace(/^91/, '')}`);
  if (SUPPORT_EMAIL) bits.push(SUPPORT_EMAIL);
  return bits.length ? bits.join('  ·  ') : '';
};

export const hasSupport = () => !!(SUPPORT_WHATSAPP || SUPPORT_EMAIL);

// A link that opens the chat with the shop's own name already typed in, so
// he does not have to explain who he is.
export const supportUrl = (org, what) => {
  if (SUPPORT_WHATSAPP) {
    const text = `Skwik — ${org?.name || 'my shop'}${what ? `\n${what}` : ''}`;
    return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(text)}`;
  }
  if (SUPPORT_EMAIL) {
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Skwik — ' + (org?.name || ''))}`;
  }
  return null;
};
