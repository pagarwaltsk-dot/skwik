// WHAT THE FILE IS CALLED WHEN IT LEAVES SKWIK.
//
// expo-print writes the PDF to a scratch file with a name like
// 0a1f7c2e-8b44-4d9a-9c10-6f3b2e5a7d81.pdf, and that is the name the customer
// sees sitting in his WhatsApp. It tells him nothing, it sorts next to
// nothing, and it looks like something a machine sent by accident.
//
// A bill should arrive called Pratik_59. So every route out — the sharing
// sheet, WhatsApp, e-mail — copies the file to a proper name first. The copy
// lives in the cache and is overwritten next time; nothing accumulates.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

// Letters, digits and single underscores.
//
// This used to keep A-Z, a-z and 0-9 and throw away everything else. In Assam
// that is most of the customers: শ্ৰী গণেশ came out empty, the name fell back
// to the word "Bill", and every bill the shopkeeper sent was called Bill.pdf —
// each one overwriting the last in the cache. So the rule is now the other way
// round: keep the letters and digits of ANY script, and drop only the handful
// of characters a file system or a messaging app really does argue about.
//
// The length limit counts characters, not code units, so a name is never cut
// through the middle of a letter or an emoji.
const BAD = /[\u0000-\u001f\u007f/\\:*?"'`<>|$&;%#\u2028\u2029]+/g;

const tidy = (s, max = 40) => {
  const cleaned = String(s || '')
    .normalize('NFC')
    .replace(BAD, ' ')
    .replace(/[.]+/g, ' ')        // no dots: they look like a second extension
    .trim()
    .replace(/\s+/g, '_');
  return Array.from(cleaned)
    .slice(0, max)
    .join('')
    .replace(/^_+|_+$/g, '');
};

// Pratik_59, Pratik_INV26-7, Ramesh_ledger, Shop_name_bill.
export function pdfName({ who, no, what, fallback = 'Bill' } = {}) {
  const a = tidy(who);
  const b = tidy(no, 24);
  const c = tidy(what, 20);
  const bits = [a || tidy(fallback), b, c].filter(Boolean);
  return `${bits.join('_') || 'Bill'}.pdf`;
}

// Copy the scratch file to that name, and hand back where it went. If
// anything at all goes wrong the original is returned, because a file with an
// ugly name is still better than no file.
export function renamed(uri, name) {
  try {
    const src = new File(uri);
    const dst = new File(Paths.cache, name);
    try { if (dst.exists) dst.delete(); } catch (e) { /* first time through */ }
    src.copy(dst);
    return dst.uri;
  } catch (e) {
    return uri;
  }
}

// The ordinary sharing sheet, with the file properly named.
export async function sharePdf(uri, name, dialogTitle = 'Send') {
  return Sharing.shareAsync(renamed(uri, name), {
    mimeType: 'application/pdf',
    dialogTitle,
    UTI: 'com.adobe.pdf',
  });
}
