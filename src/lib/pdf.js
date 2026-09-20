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

// Letters, digits and single underscores. Anything else a file system or a
// messaging app might argue about is dropped.
const tidy = (s, max = 40) => String(s || '')
  .replace(/[^A-Za-z0-9 ]+/g, ' ')
  .trim()
  .replace(/\s+/g, '_')
  .slice(0, max)
  .replace(/^_+|_+$/g, '');

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
