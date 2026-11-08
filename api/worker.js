// TWS wheel tracking shared API. One state row in D1; every change is a compare-and-swap on a
// version number, so two phones scanning at once can never both take the same wheel.
// Rules (strict order, acid 8, oven 6) live in ../app/logic.js and run HERE, not just on the phone.
import '../logic.js';
import { readPart } from './vision-read.js';
const { apply, empty, SCHEMA } = globalThis.TWS;
const ORIGINS = /^(https:\/\/rodgers77\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
export default {
  async fetch(req, env) {
    const o = req.headers.get('Origin') || '';
    const cors = ORIGINS.test(o) ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-PIN' } : { Vary: 'Origin' };
    const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: ORIGINS.test(o) ? 204 : 403, headers: cors });
    if (o && !ORIGINS.test(o)) return json({ error: 'origin' }, 403);
    const pin = req.headers.get('X-PIN') || '';
    if (!env.PIN || pin.length !== env.PIN.length || !crypto.subtle.timingSafeEqual(new TextEncoder().encode(pin), new TextEncoder().encode(env.PIN)))
      return json({ error: 'Wrong workshop PIN' }, 401);
    // --- camera: photo -> part number (Workers AI). Separate block, touches no data. ---
    if (req.method === 'POST' && new URL(req.url).pathname === '/read-part') {
      try { return json(await readPart(env, await req.arrayBuffer())); } catch (e) { return json({ code: '', error: 'reader failed' }, 502); }
    }
    // --- end camera block ---
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, v INTEGER NOT NULL, db TEXT NOT NULL)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, part TEXT, jobno TEXT, cust TEXT, station TEXT, action TEXT, items TEXT, nums TEXT, name TEXT, dev TEXT, detail TEXT)').run();
    const load = async () => { const r = await env.DB.prepare('SELECT v, db FROM state WHERE id=1').first();
      return r ? { v: r.v, db: JSON.parse(r.db) } : { v: 0, db: empty() }; };
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/export.csv') {   // full event log, any computer with the PIN
      const { results } = await env.DB.prepare('SELECT * FROM events ORDER BY id').all();
      const uk = t => new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/London' });
      const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const head = ['time_utc', 'time_uk', 'part', 'job_no', 'customer', 'station', 'action', 'checklist_items', 'numbers', 'staff', 'device', 'detail'];
      const rows = results.map(e => [e.t, uk(e.t), e.part, e.jobno, e.cust, e.station, e.action, e.items, e.nums, e.name, e.dev, e.detail].map(q).join(','));
      return new Response('\ufeff' + head.join(',') + '\r\n' + rows.join('\r\n') + '\r\n', { headers: { ...cors, 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (req.method === 'GET' && path === '/state') { const { v, db } = await load(); return json({ v, db }); }
    if (req.method === 'POST' && path === '/action') {
      let a; try { const t = await req.text(); if (t.length > 4000) throw 0; a = JSON.parse(t); } catch { return json({ error: 'Bad JSON' }, 400); }
      if (!a || typeof a !== 'object' || Array.isArray(a)) return json({ error: 'Bad action' }, 400);
      if (a.schema !== SCHEMA) return json({ error: 'App updated: reload the station or office page before making changes.', code: 'APP_UPDATE_REQUIRED' }, 409);
      for (let i = 0; i < 8; i++) {
        const { v, db } = await load();
        // delete is version-aware: refuse if the board was looking at an older state (409, nothing changed)
        if (a && ['delete','priority','rank'].includes(a.type) && a.v !== v) return json({ error: 'Board out of date, refresh and try again', v }, 409);
        const r = apply(db, a);
        if (a && ['delete','priority','rank'].includes(a.type) && !r.ok) return json({ error: r.msg, v }, r.code || 400);
        const ev = r.events || []; delete r.events;
        if (r.ignored) return json({ r, v, db });   // empty scan: nothing saved
        const res = v === 0
          ? await env.DB.prepare('INSERT OR IGNORE INTO state (id, v, db) VALUES (1, 1, ?)').bind(JSON.stringify(db)).run()
          : await env.DB.prepare('UPDATE state SET v=v+1, db=? WHERE id=1 AND v=?').bind(JSON.stringify(db), v).run();
        if (res.meta.changes === 1) {
          if (ev.length) await env.DB.batch(ev.map(e => env.DB.prepare('INSERT INTO events (t, part, jobno, cust, station, action, items, nums, name, dev, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .bind(e.t, e.part, e.jobno, e.cust, e.station, e.action, e.items, e.nums, e.name, e.dev, e.detail)));
          return json({ r, v: v + 1, db });
        }
      }
      return json({ error: 'Busy, try again' }, 503);
    }
    return json({ error: 'Not found' }, 404);
  }
};
