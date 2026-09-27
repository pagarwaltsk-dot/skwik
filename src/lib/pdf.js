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

import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
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


/* ---------------- STRAIGHT INTO THE DOWNLOAD FOLDER ----------------

   "If we click on download PDF, the bill should automatically be saved in the
   Download folder of our mobile." Quite right — the button says Download and
   what it did was open the sharing sheet, which is a different thing: twenty
   icons, and then he had to find one that means "keep it".

   Android does not let an app write into Downloads on its own any more. What
   it does allow is this: the phone shows its OWN folder picker once, he taps
   Use this folder on Download, and from then on Skwik may write there without
   asking again. So the picker appears once in the life of the app, and every
   bill after it saves silently.

   `where()` remembers the folder he chose. If it is ever taken away — he
   cleared the app's data, or the folder is gone — the write fails, the memory
   is cleared, and he is asked once more rather than being told a file was
   saved when it was not.

   iOS has no Download folder to write into at all, so there the sharing sheet
   IS the answer, and that is what it falls back to.                        */

const DIR_KEY = 'skwik.download.dir';
const SAF = LegacyFS.StorageAccessFramework;

const forget = async () => { try { await AsyncStorage.removeItem(DIR_KEY); } catch (e) { /* nothing to forget */ } };

// The folder he has already given Skwik, or null.
async function remembered() {
  try { return (await AsyncStorage.getItem(DIR_KEY)) || null; } catch (e) { return null; }
}

// Ask him, once. Opening on Download means Use this folder is the only tap.
async function askForFolder() {
  const start = (() => {
    try { return SAF.getUriForDirectoryInRoot('Download'); } catch (e) { return null; }
  })();
  const res = await SAF.requestDirectoryPermissionsAsync(start);
  if (!res?.granted || !res.directoryUri) return null;
  try { await AsyncStorage.setItem(DIR_KEY, res.directoryUri); } catch (e) { /* it still works this once */ }
  return res.directoryUri;
}

// Write the file into that folder under its proper name.
async function writeInto(dir, uri, name) {
  const base = String(name).replace(/\.pdf$/i, '');
  const out = await SAF.createFileAsync(dir, base, 'application/pdf');
  const bytes = await LegacyFS.readAsStringAsync(uri, { encoding: 'base64' });
  await LegacyFS.writeAsStringAsync(out, bytes, { encoding: 'base64' });
  return out;
}

// Returns { saved: true, where } once the file is on the phone, or
// { saved: false, why } — and 'cancelled' means he backed out of the picker,
// which is not a failure and needs no message.
export async function saveToDownloads(uri, name) {
  if (Platform.OS !== 'android' || !SAF?.createFileAsync) {
    return { saved: false, why: 'unsupported' };
  }
  let dir = await remembered();
  try {
    if (!dir) {
      dir = await askForFolder();
      if (!dir) return { saved: false, why: 'cancelled' };
    }
    await writeInto(dir, uri, name);
    return { saved: true, where: dir };
  } catch (e) {
    // The folder Skwik was holding is no good any more. Ask again, once, and
    // only give up if that fails too — so one stale address does not turn the
    // button off for good.
    await forget();
    try {
      const again = await askForFolder();
      if (!again) return { saved: false, why: 'cancelled' };
      await writeInto(again, uri, name);
      return { saved: true, where: again };
    } catch (e2) {
      return { saved: false, why: e2?.message || 'the phone would not write it' };
    }
  }
}

// WHICH FOLDER IT WENT TO, IN WORDS HE CAN LOOK FOR.
// A SAF address looks like content://com.android.externalstorage.documents/
// tree/primary%3ADownload — the only readable part is the end of it.
export function folderName(dir) {
  try {
    const tail = decodeURIComponent(String(dir || '')).split(':').pop();
    const leaf = String(tail || '').split('/').filter(Boolean).pop();
    return leaf || 'the folder you chose';
  } catch (e) {
    return 'the folder you chose';
  }
}
