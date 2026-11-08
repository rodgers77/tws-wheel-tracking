# TWS Wheel Tracking

Static phone app: index.html. Always-on office board: office.html (refreshes every 5 seconds, search, Hold/Release, completed today and CSV download).

Seven checkpoints: Reception, Wheel machine (book-in), Acid room, Prep, Oven, Diamond cut, Lacquer. Diamond cut returns to Oven before Lacquer. Acid capacity 8 wheels; oven batch capacity 6. Lacquer includes final fitting checks and completes the job.

All phones share the existing Cloudflare Worker and D1 database. Rules in logic.js run on both phone and Worker. Each computer remembers its workshop PIN; the PIN is never committed. No connection means no shared scans can be saved.

Camera reading uses Workers AI first, then barcode and on-phone OCR. Results only fill the input for staff to check; they never submit automatically.

Worker source and AI/D1 bindings are in api/. Deploy with `cd api && npm ci && npx wrangler deploy`. Publish the static root through GitHub Pages together with the Worker. GET /export.csv requires X-PIN and exports the events table from this release onward; earlier audit entries remain in the state log.

Never copy .pin, .dev.vars, .env files or local database state into version control. Local workflow tests must use isolated local D1, never production test jobs.
