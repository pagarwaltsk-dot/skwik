// ===========================================================================
//  TAKING THE WHOLE BOOK OUT, AND PUTTING IT BACK, WITHOUT HOLDING IT.
//
//  A shop pays for Skwik by the year, so it has to be able to leave with
//  everything it has written. 1.10.0 did that in one call: ask the server for
//  the book, get 105 MB of it, turn it into a file. Measured on a shop with
//  two years in it that needs about 340 MB of phone memory at the moment the
//  file is written, and a cheap Android does not have it. It does not slow
//  down when it runs out; it dies.
//
//  So the book goes out a page at a time, and each page is written into the
//  file as it arrives. Measured on that same shop: 0.6 MB held at the worst
//  moment, against 337 MB, for the same 105 MB file. Putting it back the same
//  way holds 1.5 MB.
//
//  THE SHAPE OF THE FILE, and why it is not one big JSON document.
//
//  A document has to be complete before it can be read, so putting it back
//  means holding all of it again -- the same wall, on the day he most needs
//  it to work: a new phone, everything he has riding on one file. So the file
//  is one page per LINE:
//
//      {"skwik_backup":2,"taken_at":"...","org":{...},"how_many":{...}}
//      {"t":"parties","rows":[ ...500 names... ]}
//      {"t":"parties","rows":[ ...500 more... ]}
//      {"t":"items","rows":[ ... ]}
//
//  Each line stands on its own, so it can be read and sent back one at a
//  time. It is still a text file an accountant can open, and every line is
//  ordinary JSON.
//
//  The old one-document file (skwik_backup: 1) still goes back in. Nobody's
//  backup stops working because we found a better shape.
//
//  THE ORDER OF THE PAGES IS NOT DECORATIVE. A bill cannot go back in before
//  the customer it is made out to exists, so the order below is the order the
//  references need, and the server trusts it.
// ===========================================================================

export const BOOK_TABLES = [
  'godowns',        // stores first: items and bills point at them
  'bank_accounts',
  'parties',
  'items',
  'item_parts',     // what an item is made of -- needs the items
  'standing_items',
  'expense_heads',
  'vouchers',       // bills -- need names, goods and stores
  'voucher_lines',  // need the bills
  'payments',
  'expenses',
  'stock_moves',
  // money moved between the till and an account -- needs the accounts, which
  // are second in this list
  'cash_moves',
  'invoice_series',
];

// HOW MANY ROWS IN ONE PAGE, and the number is not arbitrary.
//
// Every page is one round trip. On his own line a two-year book took 473 of
// them at 500 rows a page, and a round trip to Supabase is a fifth of a second
// before the server has done anything -- so the count of pages, not the work
// in them, is most of the wait.
//
// The other end of it: a page becomes one LINE of the file, and that line has
// to be read and parsed whole. Measured on the widest table in a real book,
// bills at 844 bytes a row, a thousand rows is 0.8 MB -- a string a phone
// handles without thinking. The narrower tables are half that.
//
// So a thousand: half the waiting, and still nothing a phone notices.
export const PAGE = 1000;

const nice = (n) => Number(n || 0).toLocaleString('en-IN');

// ---------------------------------------------------------------------------
//  OUT
// ---------------------------------------------------------------------------
//  `put(text)` is awaited and must append. `onStep({ table, done, total })`
//  is for the bar on screen. `year` narrows it to one financial year.
//
//  Nothing here holds more than one page: the page is turned into a line, the
//  line is written, and the page is let go.

export async function saveBook({ supabase, put, onStep = () => {}, year = null }) {
  const head = await call(supabase, 'book_head');
  const many = head?.how_many || {};
  const total = BOOK_TABLES.reduce((a, t) => a + Number(many[t] || 0), 0);

  await put(JSON.stringify(head) + '\n');

  const wrote = {};
  let done = 0;
  for (const table of BOOK_TABLES) {
    wrote[table] = 0;
    // A table the head says is empty is not asked for at all. On a shop that
    // keeps no stock that is five round trips saved, and on a slow line five
    // round trips is a visible wait. A year of an empty table is empty too, so
    // this holds whether or not one was asked for.
    if (Number(many[table] || 0) === 0) { onStep({ table, done, total }); continue; }
    for (let from = 0; ; from += PAGE) {
      const page = await call(supabase, 'book_slice',
        { p_table: table, p_from: from, p_size: PAGE, p_year: year });
      const rows = page?.rows || [];
      if (!rows.length) break;
      await put(JSON.stringify({ t: table, rows }) + '\n');
      wrote[table] += rows.length;
      done += rows.length;
      onStep({ table, done, total });
      if (rows.length < PAGE) break;
    }
  }

  return { head, wrote, total: done };
}

// What to say when it is finished, in his words rather than in table names.
export function sayWhatWentOut(wrote) {
  return `${nice(wrote.vouchers)} bills, ${nice(wrote.payments)} money entries, `
       + `${nice(wrote.items)} items and ${nice(wrote.parties)} names.`;
}

// ---------------------------------------------------------------------------
//  AND BACK IN
// ---------------------------------------------------------------------------
//  Made once, then fed one line of the file at a time. It holds the run it is
//  filling and nothing else -- the lines it has already sent are gone.
//
//  `line(text)` returns:
//     'head'    the first line, the firm and its counts: the restore is open
//     'page'    a page of rows went back in
//     'not-ours' the first line is not a Skwik page-by-page backup; stop and
//                read the file the old way instead
//
//  A line that will not parse is not skipped quietly. Half a book back is
//  worse than none, so it stops and says which line.

export function bookLoader({ supabase, onStep = () => {} }) {
  let run = null;
  let head = null;
  let done = 0;

  return {
    get run() { return run; },
    get head() { return head; },

    async line(text, n) {
      let obj;
      try { obj = JSON.parse(text); } catch (e) {
        if (n === 1) return 'not-ours';
        throw new Error(`Line ${n} of that file could not be read. `
          + 'The file may have been cut short or changed after Skwik wrote it, '
          + 'and a book half put back is worse than none, so nothing more was tried.');
      }

      if (n === 1) {
        if (Number(obj?.skwik_backup) !== 2) return 'not-ours';
        head = obj;
        const r = await call(supabase, 'book_restore_begin', { p_head: head });
        run = r?.run;
        if (!run) throw new Error('The server did not open a restore.');
        return 'head';
      }

      if (!run) throw new Error('That file does not begin with a Skwik backup line.');
      if (!obj?.t || !Array.isArray(obj.rows)) {
        throw new Error(`Line ${n} of that file is not a page of a book.`);
      }
      await call(supabase, 'book_restore_slice',
        { p_run: run, p_table: obj.t, p_rows: obj.rows });
      done += obj.rows.length;
      onStep({ table: obj.t, done, total: totalOf(head) });
      return 'page';
    },

    async finish() {
      if (!run) throw new Error('There was nothing to finish.');
      const r = await call(supabase, 'book_restore_end', { p_run: run, p_head: head });
      return r?.put_back || {};
    },
  };
}

export function totalOf(head) {
  const many = head?.how_many || {};
  return BOOK_TABLES.reduce((a, t) => a + Number(many[t] || 0), 0);
}

export function sayWhatCameBack(counts) {
  return `${nice(counts.vouchers)} bills, ${nice(counts.payments)} money entries, `
       + `${nice(counts.items)} items and ${nice(counts.parties)} names.`;
}

// ---------------------------------------------------------------------------
//  One place where an error from the server becomes an error, rather than
//  something quietly falsy that shows up three steps later as a wrong count.
async function call(supabase, fn, args) {
  const { data, error } = args ? await supabase.rpc(fn, args) : await supabase.rpc(fn);
  if (error) {
    if (/could not find the function|does not exist/i.test(error.message || '')) {
      throw new Error('This copy of Skwik is newer than your database. '
        + 'Run the newest file in supabase/migrations and try again.');
    }
    throw error;
  }
  return data;
}
