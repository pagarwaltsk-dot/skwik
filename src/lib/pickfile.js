// READING A FILE THE SHOPKEEPER PICKED.
//
// Used by both the import screen and the GSTR-2B screen, so the awkward part
// is written once.

import { File } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import { looksMangled, base64ToBytes, decodeBytes } from './transfer';

// Android hands a picked file over as a content:// address rather than a real
// path, and the two ways of reading one do not work in the same places. Inside
// Expo Go the newer reader is fenced off from anything outside the app's own
// folder, which is exactly where a picked file lands. So: try the modern way,
// and if it will not have it, go through Android's own content reader, which
// always can. One of the two always works.
export async function readPickedFile(uri) {
  let asText, firstProblem;

  try {
    asText = await new File(uri).text();
  } catch (e) {
    firstProblem = e;
    try {
      asText = await LegacyFS.readAsStringAsync(uri, { encoding: 'utf8' });
    } catch (e2) {
      throw firstProblem || e2;
    }
  }

  // Readable? Then we are done, and nothing expensive happened.
  if (!looksMangled(asText)) return asText;

  // Not readable. Tally writes UTF-16 and the phone read it as UTF-8, so the
  // text is full of holes. Take the raw bytes instead and decode them here,
  // where we can see what encoding they really are.
  //
  // ASK FOR THE BYTES, NOT FOR A PICTURE OF THE BYTES.
  //
  // This only ever asked for base64 — which makes the file a third bigger on
  // the way across, hands JavaScript a five-million-character string, and
  // then has to be unpicked character by character before the decoding can
  // even start. Every Tally import goes down this path, because Tally always
  // writes UTF-16, and that is most of the minutes he spent watching a
  // spinner on a big export.
  //
  // The file system will hand over the bytes themselves. Base64 stays behind
  // it for anything that will not.
  try {
    let bytes = null;
    try {
      const b = await new File(uri).bytes();
      if (b && b.length) bytes = b;
    } catch (e) { /* older file system, or a content:// it will not take */ }

    if (!bytes) {
      let b64;
      try { b64 = await new File(uri).base64(); }
      catch (e) { b64 = await LegacyFS.readAsStringAsync(uri, { encoding: 'base64' }); }
      bytes = base64ToBytes(b64);
    }

    const decoded = decodeBytes(bytes);
    if (decoded && !looksMangled(decoded)) return decoded;
    return decoded || asText;
  } catch (e) {
    return asText;      // fall back to whatever we had
  }
}

