// ===========================================================================
//  TALKING TO SUPABASE WITH NOTHING BUT fetch.
//
//  The phone uses the supabase-js library. This page does not, on purpose:
//  a page that pulls a library off somebody else's server is a page that
//  stops working the day that server changes something, and this is the page
//  a shop reaches for when it is moving its whole book. It has no
//  dependencies at all -- it is this file, the app's own libraries, and one
//  HTML page.
//
//  What it has to provide is small, because tallyload.js and booksave.js were
//  written with the database handed in from outside rather than reached for:
//
//      rpc(fn, args)                        call a server function
//      from(t).select(sel).range(a, b)      read, a page at a time
//      from(t).select(sel).eq(k, v)         read, filtered
//      from(t).insert(rows).select()        write and get the rows back
//      from(t).update(patch).eq('id', x)    mend one row
//
//  Underneath, PostgREST is an ordinary web server: a function call is a POST
//  to /rest/v1/rpc/<name>, a read is a GET with the filters in the query
//  string. Nothing clever is happening.
// ===========================================================================

// THE SHAPE OF AN ANSWER IS { data, error }, NEVER A THROWN ERROR.
//
// Every caller in the app reads it that way -- `const { data, error } = await
// ...` -- so a client that threw instead would look like it worked right up
// until something went wrong.
const ok = (data) => ({ data, error: null });
const bad = (e) => ({ data: null, error: (e instanceof Error ? e : new Error(String(e))) });

const problem = async (res) => {
  let body = '';
  try { body = await res.text(); } catch (e) { /* nothing to read */ }
  let msg = body;
  try { const j = JSON.parse(body); msg = j.message || j.error_description || j.error || body; }
  catch (e) { /* not json */ }
  const err = new Error(msg || `The server answered ${res.status}`);
  err.status = res.status;
  // save_voucher and friends raise these, and the app reads the text of them
  err.code = res.status === 404 ? '42883' : undefined;
  return err;
};

// A mobile number becomes the private e-mail Supabase wants. Exactly what the
// phone does, so the same login works in both places.
export const phoneToEmail = (phone) => `${String(phone).replace(/\D/g, '')}@gstbill.app`;

export async function signIn({ url, key, phone, password }) {
  try {
    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: phoneToEmail(phone), password }),
    });
    if (!res.ok) return bad(await problem(res));
    const j = await res.json();
    return ok({ token: j.access_token, user: j.user });
  } catch (e) {
    return bad(new Error('Could not reach Supabase. Check the address and your internet.'));
  }
}

export function restClient({ url, key, token }) {
  const head = (extra = {}) => ({
    apikey: key,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  });

  const call = async (path, init) => {
    const res = await fetch(`${url}/rest/v1/${path}`, init);
    if (!res.ok) throw await problem(res);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const client = {
    async rpc(fn, args) {
      try {
        return ok(await call(`rpc/${fn}`, {
          method: 'POST', headers: head(), body: JSON.stringify(args || {}),
        }));
      } catch (e) { return bad(e); }
    },

    from(table) {
      const q = { sel: '*', filters: [], op: null, rows: null, patch: null,
                  from: null, to: null, one: false, back: false };
      const api = {
        select(sel) {
          // On an insert, .select() means "hand the rows back"; on a read it
          // is the list of columns. One method, two jobs -- because that is
          // how the library the app was written against behaves.
          if (q.op === 'insert') { q.back = true; return api; }
          q.sel = sel || '*'; return api;
        },
        // A FILTER CARRIES ITS OPERATOR.
        //
        // This used to keep only `[key, value]` and write `eq.` into every
        // filter by hand. Then a lib reached for `.is('account_id', null)`
        // -- which the phone's library has -- and the browser page died on
        // "is is not a function". So each filter now carries the word
        // PostgREST wants, and the ones the app actually uses all exist.
        eq(k, v) { q.filters.push([k, 'eq', v]); return api; },
        neq(k, v) { q.filters.push([k, 'neq', v]); return api; },
        gt(k, v) { q.filters.push([k, 'gt', v]); return api; },
        gte(k, v) { q.filters.push([k, 'gte', v]); return api; },
        lt(k, v) { q.filters.push([k, 'lt', v]); return api; },
        lte(k, v) { q.filters.push([k, 'lte', v]); return api; },
        like(k, v) { q.filters.push([k, 'like', v]); return api; },
        ilike(k, v) { q.filters.push([k, 'ilike', v]); return api; },
        // `.is(col, null)` asks for "still empty", which is not the same
        // question as `= null` -- that matches nothing at all.
        is(k, v) { q.filters.push([k, 'is', v]); return api; },
        in(k, list) { q.filters.push([k, 'in', list]); return api; },
        order() { return api; },
        limit(n) { q.from = 0; q.to = n - 1; return api; },
        range(a, b) { q.from = a; q.to = b; return api; },
        insert(rows) { q.op = 'insert'; q.rows = Array.isArray(rows) ? rows : [rows]; return api; },
        // UPSERT IS WHAT MAKES A SECOND IMPORT A NO-OP.
        //
        // The receipts and the transfers go in with `ignoreDuplicates`, so
        // bringing the same month in twice writes them once. PostgREST asks
        // for that in a header rather than in the body: `resolution=ignore-
        // duplicates` for "leave the one already there alone", `merge-
        // duplicates` for "write over it". Leaving this out was not a small
        // gap -- it cost 92 receipts and 6 transfers out of one import, and
        // said nothing while it did.
        upsert(rows, opts) {
          q.op = 'insert';
          q.rows = Array.isArray(rows) ? rows : [rows];
          q.resolve = opts?.ignoreDuplicates ? 'ignore-duplicates' : 'merge-duplicates';
          q.onConflict = opts?.onConflict || null;
          return api;
        },
        delete() { q.op = 'delete'; return api; },
        update(patch) { q.op = 'update'; q.patch = patch; return api; },
        single() { q.one = true; return api.run(); },
        maybeSingle() { q.one = true; return api.run(); },

        async run() {
          try {
            const where = q.filters.map(([k, opName, v]) => {
              const col = encodeURIComponent(k);
              if (opName === 'is') {
                const word = v === null ? 'null' : (v === true ? 'true'
                  : v === false ? 'false' : String(v));
                return `${col}=is.${word}`;
              }
              if (opName === 'in') {
                const list = (Array.isArray(v) ? v : [v])
                  .map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(',');
                return `${col}=in.(${encodeURIComponent(list)})`;
              }
              return `${col}=${opName}.${encodeURIComponent(v)}`;
            }).join('&');

            if (q.op === 'insert') {
              const prefer = [
                q.resolve ? `resolution=${q.resolve}` : null,
                (q.back || q.one) ? 'return=representation' : 'return=minimal',
              ].filter(Boolean).join(',');
              const bits = [];
              if (where) bits.push(where);
              if (q.onConflict) bits.push(`on_conflict=${encodeURIComponent(q.onConflict)}`);
              const r = await call(`${table}${bits.length ? `?${bits.join('&')}` : ''}`, {
                method: 'POST', headers: head({ Prefer: prefer }),
                body: JSON.stringify(q.rows),
              });
              const rows = r || [];
              return ok(q.one ? (rows[0] ?? null) : rows);
            }

            if (q.op === 'delete') {
              const r = await call(`${table}?${where}`, {
                method: 'DELETE', headers: head({ Prefer: 'return=representation' }),
              });
              return ok(r || []);
            }

            if (q.op === 'update') {
              const r = await call(`${table}?${where}`, {
                method: 'PATCH',
                headers: head({ Prefer: 'return=representation' }),
                body: JSON.stringify(q.patch),
              });
              const rows = r || [];
              return ok(q.one ? (rows[0] ?? null) : rows);
            }

            const parts = [`select=${encodeURIComponent(q.sel)}`];
            if (where) parts.push(where);
            const headers = head(q.from != null
              ? { Range: `${q.from}-${q.to}`, 'Range-Unit': 'items' } : {});
            const r = await call(`${table}?${parts.join('&')}`, { method: 'GET', headers });
            const rows = r || [];
            return ok(q.one ? (rows[0] ?? null) : rows);
          } catch (e) { return bad(e); }
        },

        // so `await supabase.from(t).select(...)` works with no .run()
        then(res, rej) { return api.run().then(res, rej); },
      };
      return api;
    },
  };
  return client;
}
