SKWIK ON A COMPUTER — IMPORT AND EXPORT
=======================================

WHAT THIS IS
------------
One web page that does the two heavy jobs where your Tally file already is:
bring a Tally export in, and take your whole book out. Nothing else — the
billing stays on the phone.

It is not a separate program. It loads the app's OWN files out of src/lib, so
the reading and the writing are the same code the phone runs. There is no
build step and it fetches nothing from anybody else's server.


PUTTING IT ONLINE (once, about two minutes)
-------------------------------------------
1. In your GitHub repo, go to Settings → Pages.
2. Under "Build and deployment", set Source to "Deploy from a branch",
   branch "main", folder "/ (root)". Save.
3. Wait a minute. GitHub gives you an address like
      https://pagarwaltsk-dot.github.io/skwik/
4. Your page is at that address plus  web/skwik-io.html  :
      https://pagarwaltsk-dot.github.io/skwik/web/skwik-io.html
   Bookmark it on the laptop. THIS is the link you give customers -- just the
   link. They sign in with their own mobile number and password and see their
   own books, nothing else.

You can also just open the file from your own computer, but a browser will
refuse to load the app's files that way. Pages is easier.


WHAT IT ASKS FOR
----------------
Only the mobile number and password the shopkeeper already uses on the phone.
Nothing else. It does not ask for the Supabase address or the anon key, and
you must never send those to a customer.

Every shop shares ONE Supabase project. Their books are kept apart inside it
by row security -- a shop can read only the rows belonging to its own firm --
not by giving each shop a project of its own. So the address and the anon key
are the same for every customer, and they are already inside the APK that
every customer installs. Putting them in the page gives away nothing that the
APK did not already carry.

They live in web/project.js. KEEP THAT FILE THE SAME AS src/lib/supabase.js.
If the project ever moves, both files change together; tools/check.mjs fails
if they drift apart, so you cannot forget one of them.

The anon key is not a password. It only says WHICH project you are talking to.
The login and the row rules are what keep one shop out of another shop's books.

A DOOR FOR TESTING
------------------
The page accepts ?project=...&key=... on the address so the test harness can
point it at a pretend server. That door is open ONLY for an address on the same
machine (127.0.0.1 or localhost). If it were open to any address, somebody
could send a shopkeeper a link to this very page that posted their password to
a server of their own choosing. Nine checks in the test suite try exactly that
-- including addresses built to look local, like 127.0.0.1.evil.example.com
and 127.0.0.1@evil.example.com -- and the page refuses all of them.


USING IT
--------
IMPORT.  Export out of Tally as XML -- a whole year at once is fine here, which
is the point. Pick the file (or several at once; it joins them up). The page
reads it, checks it, and shows you what is in it BEFORE writing anything.
Press "Bring it in".

Tally exports the BILLS and the MASTERS by separate commands, and the page
takes either:

  the bills    Gateway of Tally -> Display -> Day Book -> set the period
               -> Export, format XML
  the items    Gateway of Tally -> Chart of Accounts -> Stock Items -> Export
  the names    Gateway of Tally -> Chart of Accounts -> Ledgers -> Export

A file of masters shows "Stock items in the file" instead of "Bills", which is
how you know which kind you picked. If a file yields nothing at all, the page
now says WHY -- wrong export format, an export of a report rather than of the
books, or ledgers that are all sales and tax accounts -- and names the command
in Tally that gives the right file. It no longer just shows a screen of
noughts.

Bringing the same period in twice writes nothing the second time. Tested: the
same 90 bills fed in four times over put 90 bills in the books and refused the
other 270 without being asked.

EXPORT.  "Save my whole book" writes every row to a file Skwik can read back.
On Chrome and Edge it asks where to save and then writes straight to disk as
it goes, so the size of your book does not matter. On Firefox and Safari it
gathers it and hands it over as an ordinary download.


WHAT WAS TESTED
---------------
25 checks, in a real browser against a real database, with your own 9 MB day
book going in through the file picker exactly as you would pick it:

  · the page loads with no build step and nothing from outside
  · it reads a 9 MB Tally file in about a second
  · 90 bills, 433 lines, 108 money entries, 547 stock movements, 185 items
    and 59 names land in the database
  · 16 suppliers come in with their GST numbers, and Shobha Steel comes in as
    Delhi rather than Assam
  · not one line carries the tax twice
  · the same file again writes nothing
  · the backup writes 1,429 rows — every row the database holds — as 11
    pieces straight to disk, and the download road gives a byte-identical
    file apart from the moment it was taken


CHARGES ON A BILL WITH NO STOCK ITEM UNDER THEM
-----------------------------------------------
Insurance, packing & forwarding and the like are booked in Tally as ledger
legs -- there is no inventory entry, so there is no stock item for the charge
to ride on:

  National Insurance Company Limited    17518.00
  Fire Insurance (Godown)             -14846.00
  CGST                                 -1336.14
  SGST                                 -1336.14
  Round Off                                 0.28

Only charges riding on a stock item used to be counted, so that bill added up
to 2672 against Tally's 17518 and the import stopped dead. Every charge on the
bill is now counted, and the rate it was taxed at is worked out from the tax
the goods cannot account for -- 18% on the insurance above, 5% on a packing
charge sitting beside aluminium at 5%. If that figure does not land on a real
GST rate it is left at nought rather than guessed, because a rate that is
nearly right is worse than none.

ONE ODD BILL NO LONGER HOLDS A YEAR HOSTAGE
-------------------------------------------
A bill whose pieces do not add up to what Tally says it came to still stops
the import -- it would put a wrong figure in the books. But the page now
offers "Bring in the rest, leave these N out": the named bills are left out,
everything else goes in, and the ones left out are listed again after the
import so they can be entered by hand. Nothing is written for them.
