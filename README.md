# TWS Wheel Tracking
Open index.html (pick the station in the dropdown at the bottom; each phone remembers its station). office.html opens the Office view.
All phones share one job list held by the TWS Cloudflare Worker (const API at the top of the script in index.html).
The rules (strict order, acid max 8, oven batch max 6, office alerts) are in logic.js and are enforced on the Worker.
Each phone asks once for the workshop PIN (ask Ian; it is not stored in this repo). A phone with no signal cannot save - it shows a red "Not connected" bar.
Fitting is two steps: station 11 "Tyre fit & balance" + station 13 "Fit to car". Results report to the Office view (Export JSON/CSV there).
