# TWS Wheel Tracking

Static phone app: index.html. Always-on office board: office.html (refreshes every 5 seconds, search, Hold/Release, completed today and CSV download).

Seven checkpoints: Reception, Wheel machine (book-in), Acid room, Prep, Oven, Diamond cut, Lacquer. Diamond cut returns to Oven before Lacquer. Acid capacity 8 wheels; oven batch capacity 6. Lacquer includes final fitting checks and completes the job.

All phones share the existing Cloudflare Worker and D1 database. Rules in logic.js run on both phone and Worker. Each computer remembers its workshop PIN; the PIN is never committed. No connection means no shared scans can be saved.

Camera reading uses Workers AI first, then barcode and on-phone OCR. Results only fill the input for staff to check; they never submit automatically.

Worker source and AI/D1 bindings are in api/. Deploy with `cd api && npm ci && npx wrangler deploy`. Publish the static root through GitHub Pages together with the Worker. GET /export.csv requires X-PIN and exports the events table from this release onward; earlier audit entries remain in the state log.

Never copy .pin, .dev.vars, .env files or local database state into version control. Local workflow tests must use isolated local D1, never production test jobs.

## Last four + front photo (draft 2026-11-11)

Booking needs the full part number, finish colour and a photo of the FRONT of the wheel (phone camera, shrunk to ~800 px JPEG on the phone, advisory blur/dark check). Stations show the photo, customer, job number and colour, never the part number: the lad types the last four letters/digits (spaces and punctuation ignored, any case) read off the back of the wheel, checked against the next due job only. Finish adds a named "Inserts fitted" tick when Inserts = Yes at booking.

Photos are stored in the D1 `photos` table (GET /photo/<job id>, X-PIN). Every job is kept permanently in the D1 `jobs` table (search with GET /jobs, full record GET /job/<id>; history.html). Finished jobs leave the live state 3 days after completion. /export.csv columns: time_utc, time_uk, part, last4, job_no, customer, colour, photo_link, station, action, checklist_items, numbers, staff, device, detail.

## Triangle / Square marks (draft 2026-11-11)

The same part number can be in the workshop up to three times: unmarked, Triangle and Square. A duplicate can only be booked with a mark no other open job of that part uses. Marked jobs show a big "This should be TRIANGLE/SQUARE" banner on station screens and need a "Confirm wheel is marked ..." tick at every checklist station (enforced by the Worker). Jobs are found by their permanent key (jobKey), not by part number, so duplicates never get each other's ticks, holds, priorities or deletes.
