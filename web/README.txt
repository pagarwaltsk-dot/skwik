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
   Bookmark it on the laptop.

You can also just open the file from your own computer, but a browser will
refuse to load the app's files that way. Pages is easier.


THE TWO THINGS IT ASKS FOR THE FIRST TIME
-----------------------------------------
Your Supabase address and your anon key. Both are in your Supabase dashboard
under Settings → API:

  Project URL     https://xxxxxxxxxxxx.supabase.co
  anon public     a long key starting eyJ...

The page does not remember them — close the tab and it forgets. That is on
purpose: nothing of yours is left sitting in a browser.

The anon key is MEANT to be public. It is not a password; it only says which
project you are talking to, and your login and your row security are what
protect the data. But anyone who opens this page still sees a sign-in screen,
so keep the address to yourself anyway.


USING IT
--------
IMPORT.  Export out of Tally as XML — a whole year at once is fine here, which
is the point. Pick the file (or several at once; it joins them up). The page
reads it, checks it, and shows you what is in it BEFORE writing anything.
Press "Bring it in".

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
