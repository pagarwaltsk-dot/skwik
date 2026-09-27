// ===========================================================================
//  READING A FILE TOO BIG FOR THE PHONE TO SWALLOW WHOLE.
//
//  A shopkeeper picked a Tally masters export and Skwik died on it:
//
//      java.lang.OutOfMemoryError: Failed to allocate
//      Call to function 'FileSystemFile.text' has been rejected
//
//  It never reached a single ledger. It fell over on the very first step,
//  which pulled the whole file into memory as one piece of text.
//
//  WHY IT COST SO MUCH MORE THAN THE FILE'S OWN SIZE.
//
//  Tally writes XML as UTF-16 -- two bytes for every character, so a file is
//  already double what the same text would be. And the old reader went at it
//  three times over:
//
//      1. read the WHOLE file as text ................ one full copy
//      2. notice the text is mangled (it always is,
//         because it was UTF-16 read as UTF-8)
//      3. read the WHOLE file again, as raw bytes .... a second full copy
//      4. decode those bytes into a string ........... a third full copy
//
//  All three alive at the same moment. A 30 MB export wants 90 MB or more,
//  and a cheap Android gives one app a few hundred at best.
//
//  WHAT THIS DOES INSTEAD.
//
//  It looks at the first few bytes, which say what the encoding is, and then
//  reads the file as a stream -- a piece at a time -- decoding as it goes and
//  never holding the raw bytes at all. One copy instead of three, and the
//  pieces are released as soon as they are turned into text.
//
//  It cannot make a file smaller than it is: the decoded text still has to
//  exist to be parsed. What it removes is the two copies that were pure
//  waste, which is the difference between working and not on his phone.
// ===========================================================================

import { File, FileMode } from 'expo-file-system';

// Which encoding, from the first bytes alone. This is the whole trick: the
// old reader learnt the answer by reading the entire file and finding it
// unreadable.
export function sniffEncoding(head) {
  if (!head || head.length < 2) return 'utf8';
  if (head[0] === 0xFF && head[1] === 0xFE) return 'utf16le';
  if (head[0] === 0xFE && head[1] === 0xFF) return 'utf16be';
  if (head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) return 'utf8bom';
  // No mark. A zero after every letter means UTF-16 all the same -- Tally
  // writes plenty of files without one.
  let holes = 0, looked = 0;
  for (let i = 1; i < Math.min(head.length, 400); i += 2) { looked++; if (head[i] === 0) holes++; }
  if (looked && holes / looked > 0.8) return 'utf16le';
  return 'utf8';
}

// Bytes to text, a piece at a time, carrying whatever was left dangling at
// the end of the last piece. A character can straddle two pieces, and a
// reader that forgets that quietly corrupts one letter per megabyte.
export function makeDecoder(encoding) {
  let tail = new Uint8Array(0);

  const joinTail = (bytes) => {
    if (!tail.length) return bytes;
    const merged = new Uint8Array(tail.length + bytes.length);
    merged.set(tail, 0); merged.set(bytes, tail.length);
    tail = new Uint8Array(0);
    return merged;
  };

  const utf16 = (b, little, upto) => {
    const parts = [];
    const chunk = 8192;
    const codes = new Array(chunk);
    let n = 0;
    for (let i = 0; i + 1 < upto; i += 2) {
      codes[n++] = little ? (b[i] | (b[i + 1] << 8)) : ((b[i] << 8) | b[i + 1]);
      if (n === chunk) { parts.push(String.fromCharCode.apply(null, codes)); n = 0; }
    }
    if (n) parts.push(String.fromCharCode.apply(null, codes.slice(0, n)));
    return parts.join('');
  };

  return {
    // one piece of the file -> the text that is complete so far
    push(bytes) {
      const b = joinTail(bytes);
      if (!b.length) return '';

      if (encoding === 'utf16le' || encoding === 'utf16be') {
        // an odd byte at the end belongs to the next piece
        const even = b.length - (b.length % 2);
        if (even < b.length) tail = b.subarray(even);
        return utf16(b, encoding === 'utf16le', even);
      }

      // UTF-8: a character is up to four bytes, so hold back anything that
      // looks like the start of one that has not all arrived
      let cut = b.length;
      for (let back = 1; back <= 3 && back <= b.length; back++) {
        const c = b[b.length - back];
        if ((c & 0xC0) === 0x80) continue;                 // a continuation byte
        const need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
        if (need > back) { cut = b.length - back; }
        break;
      }
      if (cut < b.length) tail = b.subarray(cut);

      const parts = [];
      const chunk = 8192;
      for (let i = 0; i < cut; i += chunk) {
        parts.push(String.fromCharCode.apply(null, b.subarray(i, Math.min(i + chunk, cut))));
      }
      let t = parts.join('');
      try { t = decodeURIComponent(escape(t)); } catch (e) { /* already readable */ }
      return t;
    },
    // anything still held back at the very end
    end() {
      if (!tail.length) return '';
      const b = tail; tail = new Uint8Array(0);
      if (encoding === 'utf16le' || encoding === 'utf16be') {
        return utf16(b, encoding === 'utf16le', b.length - (b.length % 2));
      }
      return String.fromCharCode.apply(null, b);
    },
  };
}

// Strip the byte-order mark, which is a character as far as a parser is
// concerned and makes "<ENVELOPE" fail to match at position zero.
const dropBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

// ---------------------------------------------------------------------------
//  READING A FILE IN PIECES, WITHOUT PAYING FOR EVERY PIECE
// ---------------------------------------------------------------------------
//
//  The obvious way to read a file a piece at a time is the stream the file
//  system hands out. We used it, and then read how it is built:
//
//      class FileSystemReadableStreamSource {
//        size = 1024;                         <-- a KILOBYTE
//        pull(controller) { ...readBytes(this.size)... }
//      }
//
//  A kilobyte per pull, and every pull crosses from JavaScript into Java and
//  back. Measured: his nine-megabyte day book is 9,173 crossings, and the same
//  file as UTF-16 is 18,344. Each one is cheap and none of them is free, and
//  that cost is not something we can see from a desk -- only on his phone,
//  where it would look like the app having hung.
//
//  So the file is opened directly and read a megabyte at a time: 10 reads
//  instead of 9,173, for a result proved identical to the byte. The piece is
//  decoded and let go before the next one is asked for. The stream is still
//  there behind it for any phone whose file system will not open a handle.
//
//  AND IT LETS GO OF THE THREAD BETWEEN PIECES. Reading a handle is not
//  something we wait on -- it returns straight away -- so a loop over a
//  hundred pieces would hold the one thread the screen draws on for the whole
//  read, and the phone would show a frozen app and offer to close it. A pause
//  of no length at all between pieces is enough to let it draw.

const PIECE = 1 << 20;        // a megabyte: big enough to be cheap, small
                              // enough that a phone never notices it

const breathe = () => new Promise((r) => setTimeout(r, 0));

// `onPiece(bytes)` is awaited for every piece of the file, in order.
// Returns false if this phone can do neither, so the caller can fall back.
async function eachPiece(uri, onPiece, onProgress = () => {}) {
  let f;
  try { f = new File(uri); } catch (e) { return false; }

  let total = 0;
  try { total = Number(f.size) || 0; } catch (e) { /* not every file says */ }

  // THE CHEAP WAY: a handle, a megabyte at a time.
  if (typeof f.open === 'function') {
    let h = null;
    try { h = f.open(FileMode ? FileMode.ReadOnly : 'r'); } catch (e) { h = null; }
    if (h) {
      let seen = 0;
      try {
        for (;;) {
          const bytes = h.readBytes(PIECE);
          if (!bytes || !bytes.length) break;
          seen += bytes.length;
          if ((await onPiece(bytes)) === 'stop') break;
          onProgress({ bytes: seen, total });
          await breathe();
        }
      } finally {
        try { h.close?.(); } catch (e) { /* already closed */ }
      }
      return true;
    }
  }

  // THE OTHER WAY: the stream, a kilobyte at a time. Slow, and it works.
  if (typeof f.readableStream !== 'function') return false;
  let reader;
  try { reader = f.readableStream().getReader(); } catch (e) { return false; }
  let seen = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      seen += value.length;
      if ((await onPiece(value)) === 'stop') break;
      onProgress({ bytes: seen, total });
    }
  } finally {
    try { reader.cancel?.(); } catch (e) { /* already finished */ }
    try { reader.releaseLock?.(); } catch (e) { /* nothing to release */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
//  THE WHOLE FILE, READ THE CHEAP WAY
// ---------------------------------------------------------------------------
//  Returns null when the phone can do neither, so the caller can fall back to
//  the old way rather than fail.

export async function readWholeFileStreaming(uri, onProgress = () => {}) {
  const parts = [];
  let decoder = null;
  const went = await eachPiece(uri, (bytes) => {
    if (!decoder) decoder = makeDecoder(sniffEncoding(bytes));
    const text = decoder.push(bytes);
    if (text) parts.push(text);
  }, onProgress);
  if (!went) return null;
  if (decoder) {
    const last = decoder.end();
    if (last) parts.push(last);
  }
  return dropBom(parts.join(''));
}

// What to tell him when even this is not enough. A phone that cannot hold the
// file has to be told what to do about it, not shown the word "OutOfMemory".
export function tooBigMessage(bytes) {
  const mb = bytes ? Math.round(bytes / 1024 / 1024) : 0;
  return `That file${mb ? ` is about ${mb} MB and` : ''} is more than this phone can hold at once.\n\n`
    + 'Export it in smaller pieces from Tally and bring them in one after another '
    + '— Skwik joins them up and never duplicates anything it has already seen:\n\n'
    + '• Ledgers on their own, rather than all masters together\n'
    + '• The day book one month at a time, by setting the period before you export';
}

// A rough test of whether the text we ended up with is really the file.
export const looksLikeXml = (t) =>
  /<\s*(ENVELOPE|TALLYMESSAGE|LEDGER|STOCKITEM|VOUCHER)\b/i.test(String(t || '').slice(0, 4000));

// ---------------------------------------------------------------------------
//  THE SAME FILE, A LINE AT A TIME
// ---------------------------------------------------------------------------
//  Reading the whole file cheaply still ends with the whole file in memory,
//  which is enough for a Tally export and not enough for a two-year book.
//
//  A Skwik backup is written one line per page of rows, so it can be read the
//  same way: each line is handed over complete, and nothing is kept but the
//  line in hand and whatever the caller does with it. Because the next piece
//  is not asked for until the caller has finished with this one, a slow thing
//  done per line -- sending it to the server, say -- cannot make the rest of
//  the file pile up behind it.
//
//  `onLine(line, n)` is awaited. Return the string 'stop' from it and the read
//  ends there -- which is how the first line alone can be looked at to decide
//  what kind of file this is.
//
//  Returns false when the phone can read it no way at all, so the caller can
//  fall back to reading the lot.

export async function readFileLines(uri, onLine, onProgress = () => {}) {
  let decoder = null;
  let held = '';        // the part of a line that has not ended yet
  let n = 0;
  let stopped = false;

  const give = async (raw) => {
    const line = dropBom(raw).trim();
    if (!line) return false;
    n += 1;
    return (await onLine(line, n)) === 'stop';
  };

  const went = await eachPiece(uri, async (bytes) => {
    if (!decoder) decoder = makeDecoder(sniffEncoding(bytes));
    held += decoder.push(bytes);
    let at;
    while ((at = held.indexOf('\n')) >= 0) {
      const raw = held.slice(0, at);
      held = held.slice(at + 1);
      if (await give(raw)) { stopped = true; return 'stop'; }
    }
    return undefined;
  }, (p) => onProgress({ ...p, lines: n }));

  if (!went) return false;
  if (!stopped) {
    if (decoder) held += decoder.end();
    if (held.trim()) await give(held);
  }
  return true;
}
