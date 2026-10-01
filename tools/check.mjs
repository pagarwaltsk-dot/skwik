// ===========================================================================
//  WHAT THIS IS
//
//  Every rule in here was a real fault once. Each one was found by hand, and
//  each one could come back the next time something is written in a hurry --
//  so it is written down as a check instead of as a memory.
//
//  It needs nothing but Node and the files in this folder. No database, no
//  network, no build. Run it before you upload anything:
//
//      node tools/check.mjs
//
//  It prints a line per rule and ends with a count. A FAIL is something to
//  fix, not a warning to live with.
// ===========================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const list = (dir, ext) => {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) out.push(path.relative(ROOT, p));
    }
  })(path.join(ROOT, dir));
  return out.sort();
};

let pass = 0; const fails = [];
const rule = (name, problems) => {
  const bad = (problems || []).filter(Boolean);
  if (!bad.length) { console.log(`  ok    ${name}`); pass++; return; }
  console.log(`  FAIL  ${name}`);
  bad.slice(0, 8).forEach((b) => console.log(`          ${b}`));
  if (bad.length > 8) console.log(`          … and ${bad.length - 8} more`);
  fails.push(name);
};

const APP = list('src', '.js');
// IN THE ORDER THEY ARE RUN, not alphabetical. Several of the checks below ask
// "what does the LAST definition of this function look like", and 1.9.5 sorts
// before 1.9.43 as text while running after it.
const vkey = (p) => (p.match(/(\d+(?:\.\d+)*)/) || [, '0'])[1]
  .split('.').map((n) => String(n).padStart(4, '0')).join('.');
const SQL = list('supabase', '.sql').sort((a, b) => vkey(a).localeCompare(vkey(b)));
const src = {}; APP.forEach((f) => { src[f] = rd(f); });
const sql = {}; SQL.forEach((f) => { sql[f] = rd(f); });
const lineOf = (s, i) => s.slice(0, i).split('\n').length;

console.log('\nSkwik — the checks that came out of the audit\n');

// -------------------------------------------------------------------------
// 1. A BACKSLASH-U IN SCREEN TEXT IS PRINTED, NOT UNDERSTOOD.
//    An escape only works inside quotes. In plain JSX text, and in a JSX
//    attribute written as a plain string, the shopkeeper sees — itself.
rule('no \\uXXXX printed to the screen as text', (() => {
  const bad = [];
  for (const f of APP) {
    const s = src[f];
    // JSX text: between > and < with no braces, and inside a plain attribute
    for (const m of s.matchAll(/>[^<>{}'"`$?=]*?\\u[0-9a-fA-F]{4}[^<>{}'"`$?=]*?</g)) {
      bad.push(`${f}:${lineOf(s, m.index)}  ${m[0].replace(/\s+/g, ' ').slice(0, 70)}`);
    }
    for (const m of s.matchAll(/\s[a-zA-Z]+="[^"]*\\u[0-9a-fA-F]{4}[^"]*"/g)) {
      bad.push(`${f}:${lineOf(s, m.index)}  ${m[0].replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
  return bad;
})());

// -------------------------------------------------------------------------
// 2. GOING HOME MEANS RESETTING THE STACK, NOT PUSHING ANOTHER HOME.
//    React Navigation 7 stopped walking back for navigate(). After saving a
//    bill, navigate('Home') left the bill BEHIND home, so the back button
//    reopened it and asked whether to throw the changes away.
rule("nobody navigates to 'Home' -- they use goHome()", APP.flatMap((f) => {
  const s = src[f];
  if (f.endsWith('components/Chrome.js')) return [];
  return [...s.matchAll(/navigation\.navigate\(\s*['"]Home['"]/g)]
    .map((m) => `${f}:${lineOf(s, m.index)}  use goHome(navigation)`);
}));

// -------------------------------------------------------------------------
// 3. A DATE IS TODAY WHERE HE IS STANDING.
//    toISOString() answers in UTC, which until half past five in the morning
//    is still yesterday in India -- and on 1 April, the wrong financial year.
rule('no date is taken from UTC', APP.flatMap((f) => {
  const s = src[f];
  if (f.endsWith('lib/money.js')) return [];
  return [...s.matchAll(/toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/g)]
    .map((m) => `${f}:${lineOf(s, m.index)}  use today() from lib/money`);
}));

// 3b. and the same on the server side
rule('no SQL written since 1.9.43 reaches for the server clock',
  SQL.filter((f) => /1\.9\.(4[3-9]|5[0-9])/.test(f)).flatMap((f) => {
    const s = sql[f];
    return [...s.matchAll(/\bcurrent_date\b/gi)].filter((m) => {
      const line = s.slice(s.lastIndexOf('\n', m.index) + 1,
                           (s.indexOf('\n', m.index) + 1 || s.length + 1) - 1);
      if (/^\s*--/.test(line)) return false;               // a comment about it
      if (/'[^']*current_date[^']*'/i.test(line)) return false;  // looking for it in a string
      return true;
    }).map((m) => `${f}:${lineOf(s, m.index)}  use today_ist()`);
  }));

// -------------------------------------------------------------------------
// 4. A MIGRATION HAS TO SURVIVE THE SUPABASE SQL EDITOR.
//    It splits a script by counting begin and end, so an unnamed $$ block or
//    a transaction statement makes it cut a function in half.
rule('every migration is safe to paste into the Supabase editor',
  SQL.flatMap((f) => {
    if (!f.includes('migrations/')) return [];
    const s = sql[f];
    const out = [];
    // OLDER FILES ALREADY INSTALLED ARE LEFT AS THEY ARE -- but everything
    // from 1.9.43 on has to pass, and that means COMPARING THE VERSION, not
    // matching its digits. This was written as /1\\.9\\.(4[3-9]|5[0-9])/ on the
    // day 1.9.43 was the newest file there was, and it quietly stopped
    // covering anything the moment the numbers went to 1.10 -- so every
    // migration written since has gone unchecked, and one of them had a bare
    // begin; in it that the editor would have cut a function in half on.
    const v = (f.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    if (v.length < 3) return [];
    const after = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    if (after(v, [1, 9, 43]) < 0) return [];
    if (s.includes('$$')) out.push(`${f}  has an unnamed $$ block -- name it, e.g. $fn$`);
    const tx = [...s.matchAll(/^[ \t]*(begin|commit|rollback)[ \t]*;/gim)];
    if (tx.length) out.push(`${f}:${lineOf(s, tx[0].index)}  a bare ${tx[0][1]}; -- migrations must not wrap themselves`);
    for (const tag of new Set([...s.matchAll(/\$[A-Za-z_]{1,12}\$/g)].map((m) => m[0]))) {
      const n = s.split(tag).length - 1;
      if (n % 2) out.push(`${f}  ${tag} appears ${n} times -- dollar quotes come in pairs`);
    }
    return out;
  }));

// -------------------------------------------------------------------------
// 5. EVERY FIELD, TABLE AND FUNCTION THE APP ASKS FOR HAS TO EXIST.
//    making_enabled did not: the switch in Settings had no column behind it,
//    so the whole of sets and manufacturing was unreachable.
const allSql = Object.values(sql).join('\n');
rule('every firm field the app reads exists in the database', (() => {
  const wanted = new Set([...Object.values(src).join('\n')
    .matchAll(/\borg\??\.([a-z_][a-z0-9_]{2,})\b/g)].map((m) => m[1]));
  const known = new Set();
  const orgTable = allSql.match(/CREATE TABLE public\.orgs \(([\s\S]*?)\n\);/i);
  // [ \t] and not \s: \s+ is greedy across newlines, so one match ate the
  // following line and every other column went missing.
  // and [a-z0-9_], because price1_name and turnover_above_5cr have digits in
  // them and a class without digits silently dropped exactly those columns.
  if (orgTable) for (const m of orgTable[1].matchAll(/^[ \t]+([a-z0-9_]+)[ \t]/gm)) known.add(m[1]);
  for (const m of allSql.matchAll(/alter table (?:public\.)?orgs[\s\S]{0,200}?add column if not exists ([a-z_]+)/gi)) known.add(m[1]);
  // things that are not columns at all
  const notColumns = new Set(['id', 'map', 'filter', 'length', 'name', 'then', 'slice',
    'toUpperCase', 'toLowerCase', 'trim', 'replace', 'split', 'join', 'includes']);
  return [...wanted].filter((w) => !known.has(w) && !notColumns.has(w))
    .map((w) => `orgs.${w} is read by the app and created by no SQL file`);
})());

rule('every table, view and function the app calls exists in the database', (() => {
  const app = Object.values(src).join('\n');
  const bad = [];
  for (const t of new Set([...app.matchAll(/\.from\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]))) {
    const re = new RegExp(`create\\s+(table|view|or replace view|materialized view)(\\s+if not exists)?\\s+(public\\.)?${t}\\b`, 'i');
    if (!re.test(allSql)) bad.push(`the table or view "${t}" is read by the app and is in no SQL file`);
  }
  for (const r of new Set([...app.matchAll(/\.rpc\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]))) {
    const re = new RegExp(`create\\s+(or replace\\s+)?function\\s+(public\\.)?${r}\\s*\\(`, 'i');
    if (!re.test(allSql)) bad.push(`the function "${r}" is called by the app and is in no SQL file`);
  }
  return bad;
})());

// -------------------------------------------------------------------------
// 6. NOTHING THAT CHANGES THE BOOKS MAY SKIP THE GUARD.
//    A lapsed subscription and a look-only login are both decided in one
//    place. The stock count, the godown transfer and the manufacturing entry
//    were all written later and all three walked past it.
// The NEWEST definition of a function is the one the database ends up with, so
// an older file without the guard is history, not a hole.
const newestDef = (fn) => {
  let found = null;
  for (const f of SQL) {                        // already in run order
    const s = sql[f];
    const hits = [...s.matchAll(new RegExp(`create or replace function public\\.${fn}\\s*\\(`, 'gi'))];
    if (hits.length) {
      const at = hits[hits.length - 1].index;
      found = { file: f, line: lineOf(s, at), text: s.slice(at, at + 9000) };
    }
  }
  return found;
};

rule('every function that writes stands behind assert_can_write',
  ['adjust_stock', 'transfer_stock', 'make_goods', 'write_off',
   'save_voucher', 'update_voucher', 'delete_voucher'].map((fn) => {
    const d = newestDef(fn);
    if (!d) return `${fn} is defined in no SQL file`;
    return /assert_can_write/.test(d.text) ? null
      : `${d.file}:${d.line}  ${fn} has no guard`;
  }));

// -------------------------------------------------------------------------
// 7. THE OWNER'S OWN FIGURES ARE NOT THE COUNTER'S.
//    balance_sheet and profit_and_loss are SECURITY DEFINER, so locking the
//    tables behind them made no difference at all: a counter login could read
//    the shop's capital, its bank loan and its profit straight out of them.
rule("the balance sheet and the profit are owner-only",
  ['balance_sheet', 'profit_and_loss'].map((fn) => {
    const d = newestDef(fn);
    if (!d) return `${fn} is defined in no SQL file`;
    return /my_role\(\)\s*<>\s*'owner'/.test(d.text) ? null
      : `${d.file}  ${fn} does not check my_role() -- a counter login can read it`;
  }));

// -------------------------------------------------------------------------
// 8. A CANCELLED BILL IS NOT A BILL.
//    Saving one again rewrote its lines and took its goods off the shelf a
//    second time, for a bill no report will ever show.
rule('a cancelled bill cannot be written again', (() => {
  const d = newestDef('update_voucher');
  if (!d) return ['update_voucher is defined in no SQL file'];
  return /v_cancelled is not null|cancelled_at is not null/.test(d.text) ? []
    : [`${d.file}  update_voucher does not refuse a cancelled bill`];
})());

// -------------------------------------------------------------------------
// 9. THE PARTS LIST IS CLEARED BEFORE IT IS WRITTEN AGAIN.
//    If the clear-out fails and the write succeeds, the recipe doubles and
//    every bill of that set takes twice the parts off the shelf.
rule('the parts list is not written on top of itself', (() => {
  const s = src['src/screens/ItemsScreen.js'] || '';
  const i = s.indexOf(".delete().eq('parent_id'");
  if (i < 0) return [];
  // the delete and the check that it worked, within a few lines of each other
  const near = s.slice(Math.max(0, i - 300), i + 400);
  return /\berror\b/.test(near) ? []
    : ['ItemsScreen deletes the old parts without checking that the delete worked'];
})());

// -------------------------------------------------------------------------
// 10. NOTHING INSIDE A SECURITY DEFINER FUNCTION MAY REACH ANOTHER SHOP.
//     Row security does not apply inside one, so a tidy-up of the shape
//     "set org_id = mine where org_id is not mine" reaches across every other
//     shop in the database. The restore was written that way once.
rule('no function reaches across shops', (() => {
  const bad = [];
  for (const f of SQL) {
    const s = sql[f];
    for (const m of s.matchAll(/org_id\s+is\s+distinct\s+from\s+v_org|org_id\s*<>\s*v_org|org_id\s*!=\s*v_org/gi)) {
      const line = s.slice(s.lastIndexOf('\n', m.index) + 1, s.indexOf('\n', m.index));
      if (/^\s*--/.test(line)) continue;             // a comment warning about it
      // READING is fine -- join_org asks whether this login already belongs
      // to another shop in order to refuse. It is WRITING across shops that
      // can never be right, so only an update or a delete counts.
      const before = s.slice(Math.max(0, m.index - 600), m.index).toLowerCase();
      const verb = ['update ', 'delete from '].map((v) => before.lastIndexOf(v));
      const stmt = Math.max(...verb);
      const guard = Math.max(before.lastIndexOf('exists'), before.lastIndexOf('select'),
                             before.lastIndexOf('if '));
      if (stmt < 0 || guard > stmt) continue;
      bad.push(`${f}:${lineOf(s, m.index)}  ${line.trim().slice(0, 70)}`);
    }
  }
  return bad;
})());

// -------------------------------------------------------------------------
// 11. AN IMPORT CAN ALWAYS BE TAKEN BACK OUT.
rule('every import can be undone', (() => {
  const bad = [];
  if (!/create table if not exists public\.import_runs/i.test(allSql)) {
    bad.push('there is no import_runs table');
  }
  for (const t of ['vouchers', 'payments', 'stock_moves', 'items', 'parties']) {
    const re = new RegExp(`alter table public\\.${t}\\s+add column if not exists import_run`, 'i');
    if (!re.test(allSql)) bad.push(`${t} does not carry the mark of the import that wrote it`);
  }
  const app = Object.values(src).join('\n');
  if (!/rpc\(\s*'import_begin'/.test(app)) bad.push('the loader never opens an import run');
  if (!/rpc\(\s*'import_undo'/.test(app)) bad.push('nothing in the app can undo an import');
  return bad;
})());

// -------------------------------------------------------------------------
// 12. EVERY SEARCH BOX IS AT THE TOP OF THE SCREEN.
//     Asked for plainly, twice. A picker that grows downward pushes its own
//     box off the bottom of the phone.
rule('no picker sheet grows up from the bottom of the screen', (() => {
  const s = src['src/components/Pickers.js'] || '';
  return /justifyContent:\s*'flex-end'/.test(s)
    ? ["Pickers.js has a sheet pinned to the bottom -- search boxes belong at the top"] : [];
})());

// -------------------------------------------------------------------------
// 13. A WHOLE BOOK THAT GOES OUT MUST BE ABLE TO COME BACK.
//     The backup writes one table per kind of row and the server puts them
//     back one kind at a time. Add a table to one side and forget the other,
//     and a restore drops it in silence -- which is the one kind of bug a
//     backup must never have. So the two lists are compared.
rule('every table a backup writes can be put back', (() => {
  const bad = [];
  const save = src['src/lib/booksave.js'] || '';
  if (!save) return ['there is no src/lib/booksave.js'];
  const block = save.match(/export const BOOK_TABLES = \[([\s\S]*?)\];/);
  if (!block) return ['BOOK_TABLES is not a plain list any more -- this check cannot read it'];
  const tables = [...block[1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
  if (tables.length < 10) bad.push(`only ${tables.length} tables in a whole book -- something is missing`);

  // THE LAST DEFINITION, NOT THE FIRST.
  //
  // A function gets replaced by a later migration, and matching the first
  // definition asks what it looked like before the change -- so a table added
  // to both the backup AND the restore still read as missing. The rest of this
  // file already knows to look at the last one; this check did not.
  const lastOf = (re) => { const all = [...allSql.matchAll(re)]; return all.length ? all[all.length - 1] : null; };
  const slice = lastOf(/create or replace function public\.book_restore_slice[\s\S]*?\n\$rp\$;/g);
  if (!slice) return ['there is no book_restore_slice in the migrations'];
  for (const t of tables) {
    if (!new RegExp(`p_table = '${t}'`).test(slice[0])) {
      bad.push(`${t} goes out in a backup and the server has no way to put it back`);
    }
  }

  // and the reader it is asked for with must allow it too
  const cut = lastOf(/create or replace function public\.book_slice[\s\S]*?\n\$sl\$;/g);
  if (!cut) bad.push('there is no book_slice in the migrations');
  else for (const t of tables) {
    if (!new RegExp(`'${t}'`).test(cut[0])) bad.push(`${t} cannot be asked for a page at a time`);
  }
  return bad;
})());

// -------------------------------------------------------------------------
// 14. THE FILE READER IS HANDED A FILE, NOT A LIST OF FILE TYPES.
//     "Put a book back" was written as readPickedFile(['application/json',
//     'text/plain', '*/*']) -- the list of types where the reader wants the
//     file itself. It had never once worked, and it is the button a shop
//     presses on the day it has lost everything.
rule('nothing reads a file by handing over a list of file types', (() => {
  const bad = [];
  for (const f of APP) {
    const re = /readPickedFile\(\s*\[/g;
    let m;
    while ((m = re.exec(src[f]))) bad.push(`${f}:${lineOf(src[f], m.index)} readPickedFile wants a file, not a list of types`);
    const re2 = /readPickedFile\(\s*['"`]/g;
    while ((m = re2.exec(src[f]))) {
      const after = src[f].slice(m.index, m.index + 60);
      if (/\*\/\*|application\/|text\//.test(after)) {
        bad.push(`${f}:${lineOf(src[f], m.index)} readPickedFile is being given a file type`);
      }
    }
  }
  return bad;
})());

// -------------------------------------------------------------------------
// 15. NO WHOLE FILE IS PULLED INTO MEMORY IN ONE PIECE.
//     The Tally import died on his phone with OutOfMemoryError before it had
//     read a single ledger, because the reader asked for the file as one
//     string. Every reader now goes through pickfile.js or bigfile.js.
rule('no screen reads a whole file into memory by itself', (() => {
  const bad = [];
  for (const f of APP) {
    if (f === 'src/lib/pickfile.js' || f === 'src/lib/bigfile.js') continue;
    const re = /new File\(([^)]*)\)\s*\.\s*(text|base64|bytes)\s*\(/g;
    let m;
    while ((m = re.exec(src[f]))) {
      bad.push(`${f}:${lineOf(src[f], m.index)} reads a whole file at once -- use readPickedFile`);
    }
  }
  return bad;
})());

// -------------------------------------------------------------------------
// 16. THE BROWSER PAGE RUNS THE APP'S OWN FILES, SO THEY MUST STAY LOADABLE.
//     web/skwik-io.html imports straight out of src/lib with no build step.
//     A browser will not resolve `from './uqc'` -- it wants the extension --
//     so one import written the old way silently breaks the whole page, and
//     nothing on the phone would ever notice.
rule('every library import carries the extension a browser needs', (() => {
  const bad = [];
  for (const f of APP) {
    if (!f.startsWith('src/lib/')) continue;
    for (const m of src[f].matchAll(/from '(\.\/[a-zA-Z0-9_]+)'/g)) {
      bad.push(`${f}:${lineOf(src[f], m.index)}  ${m[1]} needs to be ${m[1]}.js`);
    }
  }
  return bad;
})());

// 17. AND EVERYTHING THE PAGE IMPORTS HAS TO BE THERE.
rule('the browser page imports nothing that does not exist', (() => {
  const bad = [];
  const dir = path.join(ROOT, 'web');
  if (!fs.existsSync(dir)) return [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(html|js)$/.test(f)) continue;
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of s.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
      const t = path.resolve(dir, m[1]);
      if (!fs.existsSync(t)) bad.push(`web/${f}: ${m[1]} is not there`);
    }
    // and nothing fetched off somebody else's server, which is the whole
    // point of a page with no build step
    for (const m of s.matchAll(/(?:from|import\()\s*['"](https?:\/\/[^'"]+)['"]/g)) {
      bad.push(`web/${f}: loads ${m[1]} from outside`);
    }
  }
  return bad;
})());

rule('the browser page points at the same project as the app', (() => {
  const a = path.join(ROOT, 'src', 'lib', 'supabase.js');
  const b = path.join(ROOT, 'web', 'project.js');
  if (!fs.existsSync(a) || !fs.existsSync(b)) return [];
  const grab = (f) => {
    const s = fs.readFileSync(f, 'utf8');
    const u = s.match(/SUPABASE_URL\s*=\s*'([^']*)'/);
    const k = s.match(/SUPABASE_ANON_KEY\s*=\s*'([^']*)'/);
    return { url: u && u[1], key: k && k[1] };
  };
  const app = grab(a), web = grab(b);
  const bad = [];
  if (!web.url || !web.key) bad.push('web/project.js is missing one of the two values');
  else {
    if (app.url !== web.url) bad.push('web/project.js has a different address from src/lib/supabase.js');
    if (app.key !== web.key) bad.push('web/project.js has a different anon key from src/lib/supabase.js');
  }
  return bad;
})());

rule('the browser page never asks a shopkeeper for the project details', (() => {
  const f = path.join(ROOT, 'web', 'skwik-io.html');
  if (!fs.existsSync(f)) return [];
  const s = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (/id="url"/.test(s)) bad.push('there is still a box asking for the Supabase address');
  if (/id="key"/.test(s)) bad.push('there is still a box asking for the anon key');
  return bad;
})());

rule("a link cannot send the page at somebody else's server", (() => {
  const f = path.join(ROOT, 'web', 'project.js');
  if (!fs.existsSync(f)) return [];
  const s = fs.readFileSync(f, 'utf8');
  const bad = [];
  // the ?project= door has to be shut to everything but this machine, or the
  // link becomes a way to collect a shopkeeper's password
  if (/URLSearchParams/.test(s) && !/127\.0\.0\.1/.test(s)) {
    bad.push('web/project.js reads the address off the link without checking it is local');
  }
  return bad;
})());

rule('nothing imports a file by a route that was built for another shape', (() => {
  const f = path.join(ROOT, 'web', 'skwik-io.html');
  if (!fs.existsSync(f)) return [];
  const raw0 = fs.readFileSync(f, 'utf8');
  // The note explaining the fault mentions the name, so the CODE is what is
  // read here, not the comments around it.
  const s = raw0.split('\n').filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join('\n');
  const bad = [];
  // mergeFiles wants {name, text} objects and gives back rows of masters, not
  // XML. Handed plain text and its answer handed to the voucher reader, it
  // silently lost ninety bills. Nothing here may use it again.
  if (/mergeFiles\s*\(/.test(s) || /\bmergeFiles\b[^(]*\}\s*from/.test(s)) {
    bad.push('web/skwik-io.html uses mergeFiles, which returns rows and not XML');
  }
  // and an import nobody calls is how that fault hid for a whole build
  for (const m of s.matchAll(/import \{([^}]+)\} from ['"]([^'"]+)['"]/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      // count mentions outside the import line itself
      const uses = (s.match(new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g')) || []).length;
      if (uses < 2) bad.push(`web/skwik-io.html imports ${name} and never uses it`);
    }
  }
  return bad;
})());

rule('every part a screen draws is one it has actually got', (() => {
  // WHY THIS IS NOT THE LINTER'S JOB.
  //
  // A screen that draws <CalButton> without importing it renders as far as the
  // line that needs it and then throws, and the modal it was in simply never
  // opens. eslint cannot see it: without the React plugin a name used only as a
  // JSX tag is not counted as a reference at all -- it reports the import as
  // UNUSED and no-undef stays silent either way. So the tags are read here.
  const bad = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const q = path.join(d, f);
      if (fs.statSync(q).isDirectory()) { walk(q); continue; }
      if (!f.endsWith('.js')) continue;
      const raw = fs.readFileSync(q, 'utf8');
      const noComments = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // WHAT THE FILE HAS. Read with the strings still in place, because an
      // import is nothing but a name and a quoted path.
      const known = new Set(['React', 'Fragment']);
      for (const m of noComments.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]*['"]/g)) {
        for (const part of m[1].replace(/[{}]/g, ',').split(',')) {
          const nm = part.trim().split(/\s+as\s+/).pop().trim().replace(/^\*\s*/, '');
          if (/^[A-Za-z_$][\w$]*$/.test(nm)) known.add(nm);
        }
      }
      for (const m of noComments.matchAll(/(?:const|let|var|function|class)\s+([A-Z][\w$]*)/g)) known.add(m[1]);
      for (const m of noComments.matchAll(/([A-Z][\w$]*)\s*[:=]/g)) known.add(m[1]);

      // WHAT IT DRAWS. Read with the strings taken OUT, because the Tally
      // readers are full of XML tag names in quotes and those are not tags
      // being drawn.
      const code = noComments
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/`(?:\\.|[^`\\])*`/g, '``');
      for (const m of code.matchAll(/<([A-Z][\w$]*)/g)) {
        if (!known.has(m[1])) bad.push(`${path.relative(ROOT, q)} draws <${m[1]}> but never got it`);
      }
    }
  };
  // only the places that draw: the libraries render nothing
  for (const d of ['screens', 'components']) {
    const dir = path.join(ROOT, 'src', d);
    if (fs.existsSync(dir)) walk(dir);
  }
  return [...new Set(bad)];
})());

rule('the version on the phone can tell one build from the next', (() => {
  // WHY THIS IS A RULE AND NOT A HABIT.
  //
  // Three builds went out in one afternoon, all of them reading 1.10.5 with
  // versionCode 66, and when he asked "was it the 1.10.5 APK?" there was no
  // answer -- the number could not distinguish the build with a feature in it
  // from the build without. MoreScreen's own comment says the number matters
  // exactly when you are telling whether the phone has the build you just
  // made, so a delivery that changes the app and not the number breaks the one
  // promise that screen makes.
  const bad = [];
  const f = path.join(ROOT, 'app.json');
  if (!fs.existsSync(f)) return ['there is no app.json'];
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { return ['app.json is not valid JSON -- nothing will build']; }
  const v = j?.expo?.version;
  const c = j?.expo?.android?.versionCode;
  if (!v) bad.push('app.json has no version');
  if (!Number.isInteger(c)) bad.push('app.json has no android versionCode');
  // Android refuses an update whose versionCode did not go up, so the two have
  // to move together -- a new version with the old code installs as the same
  // build and the phone keeps what it has.
  if (v && Number.isInteger(c)) {
    const parts = String(v).split('.').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) {
      bad.push(`the version "${v}" is not a plain number.number.number`);
    }
  }
  return bad;
})());

rule('the import works out the tax on a reverse-charge bill', (() => {
  // WHY THIS IS A RULE.
  //
  // A transporter's bill under reverse charge carries NO TAX LEDGER in Tally,
  // because the tax is his to pay rather than the transporter's to collect. The
  // import read the tax off the voucher, so it read nothing, and GSTR-3B box
  // 3.1(d) showed 2,76,194.00 of freight with 0.00 of tax on it against Tally's
  // own 12,344.62 for the same month. Section 49(4) says that tax must be paid
  // in CASH and cannot come out of the credit balance, so a nil there is a
  // return filed short on the one amount that has to be handed over.
  //
  // WHAT THIS RULE USED TO DO, AND WHY IT WAS WEAK. It looked for the forbidden
  // line `cgst: v.cgst, sgst: v.sgst, igst: v.igst` and for the words
  // `v.reverse_charge &&`. Rename that variable and the rule goes quiet on code
  // that no longer works -- a tripwire on one mistake in one shape.
  //
  // So the arithmetic was moved into money.js as a named export, where it can
  // be loaded outside the app and put to real figures by
  // tools/reader-check.mjs. This rule now only checks the wiring, which is the
  // part a text search CAN see honestly, and the answer itself is checked by
  // running it.
  const bad = [];
  const mFile = path.join(ROOT, 'src', 'lib', 'money.js');
  const lFile = path.join(ROOT, 'src', 'lib', 'tallyload.js');
  const rFile = path.join(ROOT, 'src', 'lib', 'tallybook.js');
  if (!fs.existsSync(mFile) || !fs.existsSync(lFile) || !fs.existsSync(rFile)) {
    return ['one of money.js, tallyload.js or tallybook.js is missing'];
  }
  const m = fs.readFileSync(mFile, 'utf8');
  const l = fs.readFileSync(lFile, 'utf8');
  const r = fs.readFileSync(rFile, 'utf8');
  if (!/export function reverseChargeTax/.test(m)) {
    bad.push('money.js does not export reverseChargeTax, so nothing can test the arithmetic');
  }
  if (!/reverseChargeTax\s*\(/.test(l)) {
    bad.push('the import never calls reverseChargeTax, so a reverse-charge bill gets no tax');
  }
  // AND THE READER MUST TAKE TALLY'S OWN WORD FOR IT, not the ledger's name.
  //
  // Reading the name for "R.Charge" is a guess about other people's wording,
  // and on one day of his own book it already missed a bill: 102-56419, SHREE
  // SHYAM ROADWAYS, three legs all called "FREIGHT INTRA STATE".
  if (!/GSTOVRDNISREVCHARGEAPPL/.test(r)) {
    bad.push('the reader decides reverse charge from the ledger name alone, '
           + "not from Tally's own flag on the entry");
  }
  return bad;
})());

rule('the reader can be loaded and tested outside the app', (() => {
  // WHY THIS IS A RULE.
  //
  // The tax on a reverse-charge bill was worked out inside tallyload.js, which
  // reaches for Supabase -- so it could not be loaded by anything but the app,
  // and the only guard on it was a rule reading the source for a pattern. That
  // is how a figure that decides what he pays the government ended up with no
  // test that ran it.
  //
  // tools/reader-check.mjs loads the reader with plain node and puts invented
  // books through it. That only keeps working while the reader's imports stay
  // clean. One `import { supabase }` anywhere in the chain and the whole suite
  // goes dark -- so the chain is walked here.
  const LIB = path.join(ROOT, 'src', 'lib');
  const start = 'tallybook.js';
  if (!fs.existsSync(path.join(LIB, start))) return ['there is no src/lib/tallybook.js'];
  const seen = new Set();
  const bad = [];
  const walk = (file, from) => {
    if (seen.has(file)) return;
    seen.add(file);
    const f = path.join(LIB, file);
    if (!fs.existsSync(f)) { bad.push(`${from} imports ${file}, which is not there`); return; }
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('./')) { walk(spec.replace('./', ''), file); continue; }
      // anything that is not a sibling file is a package, and a package means
      // the reader cannot be loaded without the app around it
      bad.push(`${file} imports "${spec}", so the reader can no longer be run on its own`);
    }
  };
  walk(start, '(the reader)');
  if (!fs.existsSync(path.join(ROOT, 'tools', 'reader-check.mjs'))) {
    bad.push('tools/reader-check.mjs is gone, so nothing puts real figures through the reader');
  }
  return bad;
})());

rule("a ledger's group is followed up, not read one hop and given up on", (() => {
  // WHY THIS IS A RULE.
  //
  // Nobody files a supplier straight under Sundry Creditors. They make a group
  // for a trade or a town. On his own book: Transport -> Sundry Creditors, and
  // Umarpur Plastic Party -> Sundry Creditors. This file read the immediate
  // parent only, found "Transport", shrugged, and called six suppliers 'other'.
  //
  // That is not untidiness. Two lines below roleOfGroup there is a deliberate
  // guard -- a ledger the GROUP has placed is never put through the tax-name
  // test, because "a customer called GST TRADERS is not a tax ledger". A role
  // of 'other' switches that guard off. So the shallow read disarmed a guard
  // the code had already written.
  //
  // transfer.js walked the chain from the day it was written. tallybook.js did
  // not, and nothing pointed at the difference for months.
  const f = path.join(ROOT, 'src', 'lib', 'tallybook.js');
  if (!fs.existsSync(f)) return ['there is no src/lib/tallybook.js'];
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/export function groupsIn/.test(t)) {
    bad.push('the reader never reads the GROUP blocks, so it cannot follow a group up');
  }
  if (/role:\s*roleOfGroup\(parent\)/.test(t)) {
    bad.push("a ledger's role is taken from its immediate parent group only");
  }
  return bad;
})());

rule('the browser page asks which price list is which, as the phone does', (() => {
  // WHY THIS IS A RULE.
  //
  // Skwik bills on two prices. Tally holds as many as a shop cares to make --
  // his own masters carry ten, named "1 APRIL 2026", "OffSeason", "Wholesale"
  // and so on, and no rule on earth can work out from those names which is the
  // counter price and which the trade price. The phone asks. This page did not
  // ask at all, and did not even say a level existed: 495 items came in, 489
  // with a selling price and NOT ONE with a second price.
  //
  // The page is now the main way a year comes in, so a fix that lives only on
  // the phone is not a fix.
  const f = path.join(ROOT, 'web', 'skwik-io.html');
  if (!fs.existsSync(f)) return [];
  const t = fs.readFileSync(f, 'utf8');
  const bad = [];
  if (!/priceLevelsInTally/.test(t)) bad.push('the page never reads the price levels a file offers');
  if (!/applyPriceLevel/.test(t)) bad.push('the page never puts a chosen level onto the items');
  return bad;
})());

rule('the browser page carries over everything the reader found', (() => {
  // WHY THIS EXISTS.
  //
  // The page reads each picked file on its own and joins the books together.
  // It carried five of the reader's six lists and quietly dropped the sixth,
  // so every Contra in every import went in the bin -- eighteen deposits a
  // year, never written, never even counted as passed over, with nothing on
  // any screen saying a word. The test that was meant to catch it asked for
  // "a digit" and nought is a digit.
  // READ FROM DISK, NOT FROM THE src MAP -- that map holds src/*.js only, so
  // asking it for the web page gave nothing and this check quietly passed on
  // an empty string. Which is the same shape of fault it was written to catch.
  const pageFile = path.join(ROOT, 'web', 'skwik-io.html');
  const readerFile = path.join(ROOT, 'src', 'lib', 'tallybook.js');
  if (!fs.existsSync(pageFile) || !fs.existsSync(readerFile)) return [];
  const page = fs.readFileSync(pageFile, 'utf8');
  const reader = fs.readFileSync(readerFile, 'utf8');
  if (!page || !reader) return ['the page or the reader is empty'];
  // what the reader hands back
  const m = reader.match(/const book = \{([\s\S]*?)\};/);
  if (!m) return ['vouchersFromTallyXml does not build its book in one place any more'];
  const lists = [...m[1].matchAll(/([a-zA-Z]+)\s*:\s*\[\]/g)].map((x) => x[1]);
  if (lists.length < 4) return ['this check can no longer read the lists the reader builds'];
  const bad = [];
  for (const k of lists) {
    if (!new RegExp(`book\\.${k}\\.push`).test(page)) {
      bad.push(`the page never carries over book.${k} from each file`);
    }
  }
  return bad;
})());

rule('every way the page asks the database a question is one its own client has', (() => {
  // WHY THIS EXISTS.
  //
  // The phone talks to Supabase through the real library. The browser page
  // cannot -- it has no bundler -- so web/rest.js is a hand-written stand-in
  // that speaks the same shape over plain fetch. It only ever knew the ones
  // the page happened to use.
  //
  // Then a library reached for `.is('account_id', null)` -- perfectly normal,
  // the phone has had it for months -- and the page died at runtime on
  // "is is not a function". Nothing before this rule could have said so: the
  // libraries parse, they lint, the phone is happy. Only the page breaks, and
  // only once a shopkeeper presses the button.
  //
  // So: whatever the libraries the page loads call on a query, rest.js must
  // have. If a library starts using a new one, this fails here rather than in
  // his hands.
  const restFile = path.join(ROOT, 'web', 'rest.js');
  const pageFile = path.join(ROOT, 'web', 'skwik-io.html');
  if (!fs.existsSync(restFile) || !fs.existsSync(pageFile)) return [];
  const rest = fs.readFileSync(restFile, 'utf8');
  const page = fs.readFileSync(pageFile, 'utf8');

  // which libraries the page actually loads
  const loaded = [...page.matchAll(/['"]\.\.\/src\/lib\/([a-zA-Z0-9_]+)\.js['"]/g)]
    .map((m) => m[1]);
  if (!loaded.length) return ['the page loads none of the libraries any more'];

  // what rest.js can do: the methods on its query object, plus the two on the
  // client itself
  const have = new Set(['from', 'rpc', 'then', 'catch', 'finally']);
  for (const m of rest.matchAll(/^\s{8}(?:async\s+)?([a-zA-Z0-9_]+)\s*\(/gm)) have.add(m[1]);

  // every method chained onto supabase.from(...) in those libraries
  const bad = [];
  for (const name of loaded) {
    const f = path.join(ROOT, 'src', 'lib', `${name}.js`);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // start at each `.from(` and follow the chain of .word( that comes after
    for (const hit of text.matchAll(/\.from\(/g)) {
      const tail = text.slice(hit.index + 6, hit.index + 6 + 600);
      // stop the chain at the first thing that is plainly not part of it
      const chain = tail.match(/^[\s\S]*?(?=;|\)\s*[,)]|\n\s*\n)/);
      const run = chain ? chain[0] : tail;
      for (const c of run.matchAll(/\.([a-zA-Z0-9_]+)\s*\(/g)) {
        const meth = c[1];
        if (have.has(meth)) continue;
        // things that are plainly not query methods
        if (['map', 'filter', 'push', 'join', 'slice', 'toString', 'forEach',
             'reduce', 'replace', 'split', 'find', 'some', 'every', 'trim',
             'padStart', 'padEnd', 'concat', 'includes', 'startsWith',
             'endsWith', 'toFixed', 'sort', 'keys', 'values', 'entries',
             'from', 'rpc'].includes(meth)) continue;
        bad.push(`src/lib/${name}.js asks the database with .${meth}(), `
          + `which web/rest.js has no answer for`);
      }
    }
  }
  return [...new Set(bad)];
})());

// -------------------------------------------------------------------------
// 28. A MIGRATION THAT WRITES DOWN THE WORDS A COLUMN MAY HOLD HAS TO NAME
//     THE ONES THE BOOK ACTUALLY WRITES.
//
//     Written on the night two of these were wrong from memory and would each
//     have broken a real thing the day they ran:
//
//       * a rule for cash_moves.direction naming 'in' and 'out'. The column
//         has carried check (direction in ('deposit','withdrawal')) since
//         1.10.6, and every bank deposit would have been refused.
//       * a rule for payments.mode naming 'cash' and 'bank'. write_off() files
//         its entry with mode 'writeoff', and every write-off would have been
//         refused.
//
//     Both were caught by running it; neither would have been caught by
//     reading it. So the check is mechanical, and deliberately narrow enough
//     to be certain rather than wide enough to be noisy. Two questions only:
//
//       a) does an EXISTING constraint on the same column allow a word the new
//          list leaves out?
//       b) does any migration INSERT a word into that column that the new list
//          leaves out?
rule('every word list covers the words the book writes', (() => {
  const bad = [];
  const MIG = SQL.filter((f) => f.includes('migrations/'));

  const lists = [];
  for (const f of MIG) {
    for (const m of sql[f].matchAll(
      /tighten_words\s*\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*'[a-z_]+'\s*,\s*array\[([^\]]*)\]/gi)) {
      lists.push({ file: f, table: m[1], col: m[2],
                   ok: [...m[3].matchAll(/'([^']*)'/g)].map((x) => x[1]) });
    }
  }
  if (!lists.length) return [];

  // the literals at one column's position in an INSERT, respecting brackets and
  // quotes so a function call in an earlier column does not shift the count
  const insertedInto = (text, table, col) => {
    const found = new Set();
    const re = new RegExp(
      `insert\\s+into\\s+(?:public\\.)?${table}\\s*\\(([^)]*)\\)\\s*values\\s*`, 'gi');
    for (const m of text.matchAll(re)) {
      const cols = m[1].split(',').map((c) => c.trim().toLowerCase());
      const at = cols.indexOf(col);
      if (at < 0) continue;
      let i = m.index + m[0].length;
      // every ( ... ) tuple after VALUES, until the statement plainly ends
      while (text[i] === '(') {
        let depth = 0, q = false, part = 0, cur = '';
        for (; i < text.length; i++) {
          const ch = text[i];
          if (q) { cur += ch; if (ch === "'") q = false; continue; }
          if (ch === "'") { q = true; cur += ch; continue; }
          if (ch === '(') { depth++; if (depth === 1) continue; }
          if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
          if (ch === ',' && depth === 1) {
            if (part === at) { const v = cur.trim().match(/^'([^']*)'$/); if (v) found.add(v[1]); }
            part++; cur = ''; continue;
          }
          cur += ch;
        }
        if (part === at) { const v = cur.trim().match(/^'([^']*)'$/); if (v) found.add(v[1]); }
        while (/[\s,]/.test(text[i] || '')) i++;
      }
    }
    return found;
  };

  for (const L of lists) {
    const seen = new Set();
    for (const f of MIG) {
      const text = sql[f];
      // a) A CONSTRAINT ALREADY WRITTEN DOWN FOR THE SAME COLUMN -- and for the
      //    same TABLE. 'role' is a column on ledgers as well as on profiles,
      //    and reading ledgers' list as profiles' would say a login may have
      //    the role 'liability'. So only the text of a statement that names
      //    this table is looked at.
      const areas = [];
      for (const m of text.matchAll(
        new RegExp(`(?:create\\s+table[^;]*?|alter\\s+table\\s+)(?:if\\s+not\\s+exists\\s+)?`
                 + `(?:public\\.)?${L.table}\\b`, 'gi'))) {
        const end2 = text.indexOf(';', m.index);
        areas.push(text.slice(m.index, end2 < 0 ? text.length : end2));
      }
      for (const a of areas) {
        const re = new RegExp(`check\\s*\\(\\s*${L.col}\\s+in\\s*\\(([^)]*)\\)`, 'gi');
        for (const m of a.matchAll(re)) {
          for (const w of m[1].matchAll(/'([^']*)'/g)) seen.add(w[1]);
        }
      }
      // b) a word some migration puts into it
      for (const w of insertedInto(text, L.table, L.col)) seen.add(w);
    }
    for (const w of seen) {
      if (!L.ok.includes(w)) {
        bad.push(`${L.file}  ${L.table}.${L.col} is written as '${w}' somewhere in `
          + `the book, and the word list (${L.ok.join(', ')}) leaves it out`);
      }
    }
  }
  return [...new Set(bad)];
})());

// -------------------------------------------------------------------------
// 29. ANYTHING THAT PICKS BILLS OUT BY THEIR KIND HAS TO ASK WHETHER THEY
//     WERE CANCELLED.
//
//     A cancelled bill is not a bill. Every report inside the database asks
//     this already -- the balance sheet, the profit, GSTR-3B, both party
//     balances, the party ledger. Two places in the app did not:
//
//       * billsToCsv, the file that goes to his CA, which showed a cancelled
//         bill with its full taxable value, its tax and its total, and had no
//         column anywhere to say otherwise. The one place the figures leave
//         Skwik and get added up by somebody else.
//       * gstr2b's book side, which would have gone on matching a cancelled
//         debit note against the portal for ever once 1.10.41 started keeping
//         them instead of deleting them.
//
//     So: a file that filters on a voucher kind and sums or exports money must
//     mention cancelled_at somewhere. This does not prove it asks in the right
//     place -- nothing textual could -- but it makes forgetting it loud.
rule('nothing counts a bill by its kind without asking if it was cancelled', (() => {
  const bad = [];
  for (const f of APP) {
    const text = src[f];
    // A WHOLE ARRAY OF BILLS SORTED BY KIND is the shape that goes wrong. A
    // screen holding ONE bill is not: the sheet will not open a cancelled one,
    // the ledger's rows come from party_ledger which leaves them out, and the
    // server refuses to save over one.
    if (!/\.filter\(\s*\(?\s*[a-z]\w*\s*\)?\s*=>[^;]{0,200}?\bvtype\b/s.test(text)) continue;
    if (!/cancelled_at/.test(text)) {
      bad.push(`${f} sorts a list of bills by their kind and never mentions `
        + 'cancelled_at -- either leave the cancelled ones out, or say in a '
        + 'comment why they belong in what this builds');
    }
  }
  return bad;
})());

// -------------------------------------------------------------------------
console.log('');
if (!fails.length) {
  console.log(`${pass} checks passed. Nothing the audit found has come back.\n`);
  process.exit(0);
}
console.log(`${pass} passed, ${fails.length} FAILED:`);
fails.forEach((f) => console.log(`  - ${f}`));
console.log('');
process.exit(1);
