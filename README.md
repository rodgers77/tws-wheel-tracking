# TWS Wheel Tracking
Open index.html (pick the station in the dropdown at the bottom; each phone remembers its station). office.html opens the Office view.
Config block is at the top of the <script> in index.html: REPORT_URL (blank = this phone only), ACID_MAX=8, OVEN_MAX=6.
Ian's answers (2 Nov): fitting is two steps = station 11 "Tyre fit & balance" + station 13 "Fit to car" (still 13 stations).
Results report to the Office view. Each phone only stores its own data until a shared backend/relay is set up (like box-lookup/relay) and its URL goes in REPORT_URL. Use Export JSON/CSV on the Office screen.
Tests: serve this folder on :8765, then `node test-phone.js` (needs playwright-core + Chrome). Screenshots in screenshots/.
