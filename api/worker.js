// TWS wheel tracking shared API. One state row in D1; every change is a compare-and-swap on a
// version number, so two phones scanning at once can never both take the same wheel.
// Rules (strict order, acid 8, oven 6) live in ../app/logic.js and run HERE, not just on the phone.
import '../logic.js';
import { readPart } from './vision-read.js';
const { apply, empty, SCHEMA, photoOk, last4, jobKey, where, mark } = globalThis.TWS;
const EVENT_COLS = ['colour', 'photo', 'last4', 'job_id']; // added 2026-11-11; older rows keep blanks
const KEEP_DONE_DAYS = 3;   // finished jobs leave the live state after this; their permanent record stays in the jobs table
let READY = false;          // tables/migrations checked once per Worker instance
const doneTime = j => j.doneAt || (j.ticks || []).map(t => t.t || (t.item === 'batch time' ? t.value : '')).filter(Boolean).sort().pop() || j.booked;
const words = (v, out = []) => { if (v && typeof v === 'object') for (const x of Object.values(v)) words(x, out); else if (v !== null && v !== undefined && v !== '') out.push(String(v)); return out; };
// One permanent row per job (never deleted). rec = whole job (booking fields, ticks with name/time/device, values, holds) + status.
// Backfilled pre-release history goes in its own column (written once, never overwritten by later updates).
function record(j, status, extra = {}, history = []) {
  const rec = { id: jobKey(j), status, booked: j.booked, doneAt: j.done ? doneTime(j) : '', last4: last4(j.part), colour: j.colour || '', mark: mark(j), ...extra, job: j };
  return { id: rec.id, booked: j.booked || '', status, rec: JSON.stringify(rec), history: JSON.stringify(history), search: words([rec, history.map(h => h.name)]).join(' ').toLowerCase() };
}
const UPSERT = "INSERT INTO jobs (id, booked, status, updated, search, rec, history) SELECT ?, ?, ?, ?, ?, ?, '[]' WHERE COALESCE((SELECT v FROM state WHERE id=1), 0)=? " +
  "ON CONFLICT(id) DO UPDATE SET booked=excluded.booked, status=excluded.status, updated=excluded.updated, search=excluded.search || ' ' || COALESCE((SELECT group_concat(json_extract(h.value, '$.name'), ' ') FROM json_each(jobs.history) h), ''), rec=excluded.rec";
async function setup(env) {
  if (READY) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, v INTEGER NOT NULL, db TEXT NOT NULL)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, part TEXT, jobno TEXT, cust TEXT, station TEXT, action TEXT, items TEXT, nums TEXT, name TEXT, dev TEXT, detail TEXT)').run();
  // Safe migration: add new columns only if missing; existing rows are never rewritten.
  const have = new Set((await env.DB.prepare('PRAGMA table_info(events)').all()).results.map(c => c.name));
  for (const c of EVENT_COLS) if (!have.has(c)) await env.DB.prepare(`ALTER TABLE events ADD COLUMN ${c} TEXT`).run();
  // Front-of-wheel photos live in their own table (fetched one at a time), never in the polled state. Never deleted.
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, t TEXT NOT NULL, jpeg TEXT NOT NULL)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, booked TEXT, status TEXT, updated TEXT, search TEXT, rec TEXT NOT NULL, history TEXT)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)').run();
  if (!await env.DB.prepare("SELECT v FROM meta WHERE k='jobs_backfill_v1'").first()) await backfill(env);
  READY = true;
}
// One-off, idempotent: copy every job already in the live state (plus jobs deleted earlier, from the event log) into the
// permanent jobs table with their history. INSERT OR IGNORE never overwrites a newer record.
async function backfill(env) {
  const row = await env.DB.prepare('SELECT db FROM state WHERE id=1').first(), db = row ? JSON.parse(row.db) : empty();
  const { results: evs } = await env.DB.prepare("SELECT t, part, jobno, cust, station, action, items, nums, name, dev, detail FROM events WHERE part<>'' OR action='complete' ORDER BY id").all();
  const now = new Date().toISOString(), out = [];
  const mine = (e, part) => e.part === part || (e.action === 'complete' && String(e.detail).includes('Job complete: ' + part + ' ('));
  const window = (part, from, to) => evs.filter(e => mine(e, part) && e.t >= from && (!to || e.t < to));
  const fromLog = (part, from, to, before) => (db.log || []).filter(r => r.job === part && r.t >= from && (!to || r.t < to) && (!before || r.t < before))
    .map(r => ({ t: r.t, part, station: r.station, action: r.what, detail: r.what, name: r.name || '' }));
  for (const j of db.jobs) {
    const next = db.jobs.filter(o => o !== j && o.part === j.part && o.booked > j.booked).map(o => o.booked).sort()[0];
    const e = window(j.part, j.booked, next), history = [...fromLog(j.part, j.booked, next, e[0] && e[0].t), ...e];
    out.push(record(j, j.done ? 'Finished' : 'In progress', { backfilled: now }, history));
  }
  for (const d of evs.filter(e => e.action === 'delete')) {
    if (db.jobs.some(j => j.part === d.part && j.booked <= d.t && (!j.done || doneTime(j) >= d.t))) continue;
    const booked = evs.filter(e => e.part === d.part && e.action === 'book' && e.t <= d.t).map(e => e.t).pop() || d.t;
    const j = { part: d.part, job: d.jobno, cust: d.cust, booked, ticks: [] };
    out.push(record({ ...j, id: 'deleted-' + d.t + '-' + d.part }, 'Deleted', { deletedAt: d.t, backfilled: now }, window(d.part, booked, d.t).concat(d)));
  }
  const ins = env.DB.prepare('INSERT OR IGNORE INTO jobs (id, booked, status, updated, search, rec, history) VALUES (?, ?, ?, ?, ?, ?, ?)');
  await env.DB.batch([...out.map(r => ins.bind(r.id, r.booked, r.status, now, r.search, r.rec, r.history)),
    env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('jobs_backfill_v1', ?)").bind(now)]);
}
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
    await setup(env);
    const load = async () => { const r = await env.DB.prepare('SELECT v, db FROM state WHERE id=1').first();
      return r ? { v: r.v, db: JSON.parse(r.db) } : { v: 0, db: empty() }; };
    const path = new URL(req.url).pathname, origin = new URL(req.url).origin;
    const photoLink = id => id ? origin + '/photo/' + id : '';
    if (req.method === 'GET' && path.startsWith('/photo/')) {   // needs X-PIN like every other route
      const row = /^\/photo\/[a-z0-9-]{8,64}$/.test(path) && await env.DB.prepare('SELECT jpeg FROM photos WHERE id=?').bind(path.slice(7)).first();
      if (!row) return json({ error: 'No photo' }, 404);
      const bin = atob(row.jpeg), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new Response(u, { headers: { ...cors, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' } });
    }
    if (req.method === 'GET' && path === '/export.csv') {   // full event log, any computer with the PIN
      const { results } = await env.DB.prepare('SELECT * FROM events ORDER BY id').all();
      const uk = t => new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/London' });
      const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const head = ['time_utc', 'time_uk', 'part', 'last4', 'job_no', 'customer', 'colour', 'photo_link', 'station', 'action', 'checklist_items', 'numbers', 'staff', 'device', 'detail'];
      // Legacy rows: last four derived from the stored part for the export only (rows are not rewritten).
      const rows = results.map(e => [e.t, uk(e.t), e.part, e.last4 || last4(e.part), e.jobno, e.cust, e.colour, e.photo, e.station, e.action, e.items, e.nums, e.name, e.dev, e.detail].map(q).join(','));
      return new Response('\ufeff' + head.join(',') + '\r\n' + rows.join('\r\n') + '\r\n', { headers: { ...cors, 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // Job history (history.html): search any field, optional booked-date range and status, newest first.
    if (req.method === 'GET' && path === '/jobs') {
      const u = new URL(req.url).searchParams, lim = Math.min(100, Math.max(1, +u.get('limit') || 50)), off = Math.max(0, +u.get('offset') || 0);
      const { results } = await env.DB.prepare("SELECT rec FROM jobs WHERE instr(search, ?) > 0 AND booked >= ? AND booked < ? AND (?='' OR status=?) ORDER BY booked DESC, id DESC LIMIT ? OFFSET ?")
        .bind(String(u.get('q') || '').trim().toLowerCase().slice(0, 80), u.get('from') || '', u.get('to') || '\uffff', u.get('status') || '', u.get('status') || '', lim + 1, off).all();
      const rows = results.map(r => { const x = JSON.parse(r.rec), j = x.job; return { id: x.id, status: x.status, booked: x.booked, doneAt: x.doneAt, deletedAt: x.deletedAt || '',
        stage: x.status === 'In progress' ? where(j).text : '', part: j.part, last4: x.last4, job: j.job, cust: j.cust, reg: j.reg, make: j.make, colour: x.colour, mark: mark(j), n: j.n, finish: j.finish, photo: j.photo || '' }; });
      return json({ rows: rows.slice(0, lim), more: rows.length > lim });
    }
    if (req.method === 'GET' && path.startsWith('/job/')) {
      const id = decodeURIComponent(path.slice(5)), r = await env.DB.prepare('SELECT rec, history FROM jobs WHERE id=?').bind(id).first();
      if (!r) return json({ error: 'No such job' }, 404);
      const { results } = await env.DB.prepare('SELECT * FROM events WHERE job_id=? ORDER BY id').bind(id).all();
      return json({ rec: { ...JSON.parse(r.rec), history: JSON.parse(r.history || '[]') }, events: results });
    }
    if (req.method === 'GET' && path === '/state') { const { v, db } = await load(); return json({ v, db }); }
    if (req.method === 'POST' && path === '/action') {
      let a; try { const t = await req.text(); if (t.length > 4000 + 460000) throw 0; a = JSON.parse(t); if (t.length - String(a?.photo ?? '').length > 4000) throw 0; } catch { return json({ error: 'Bad JSON' }, 400); }
      if (!a || typeof a !== 'object' || Array.isArray(a)) return json({ error: 'Bad action' }, 400);
      if (a.schema !== SCHEMA) return json({ error: 'App updated: reload the station or office page before making changes.', code: 'APP_UPDATE_REQUIRED' }, 409);
      // Only the Worker issues photo ids, and only for a valid JPEG sent with a booking.
      delete a.photoId; let photo = null;
      if (a.photo !== undefined) {
        if (a.type !== 'book' || !photoOk(a.photo)) return json({ error: 'Photo must be a JPEG under 330 KB - retake the photo.' }, 400);
        photo = a.photo.slice(23); a.photoId = crypto.randomUUID(); delete a.photo;
      }
      for (let i = 0; i < 8; i++) {
        const { v, db } = await load(), before = new Map(db.jobs.map(j => [jobKey(j), JSON.stringify(j)]));
        // delete is version-aware: refuse if the board was looking at an older state (409, nothing changed)
        if (a && ['delete','priority','rank'].includes(a.type) && a.v !== v) return json({ error: 'Board out of date, refresh and try again', v }, 409);
        const r = apply(db, a);
        if (a && ['delete','priority','rank'].includes(a.type) && !r.ok) return json({ error: r.msg, v }, r.code || 400);
        const ev = r.events || []; delete r.events;
        if (r.ignored) return json({ r, v, db });   // empty scan: nothing saved
        // Permanent records: every job whose data changed, deleted jobs (marked Deleted), and finished jobs leaving the live state.
        const now = new Date().toISOString(), recs = [];
        for (const j of db.jobs) if (before.get(jobKey(j)) !== JSON.stringify(j)) recs.push(record(j, j.done ? 'Finished' : 'In progress'));
        if (a.type === 'delete' && r.ok) for (const [k, txt] of before) if (!db.jobs.some(j => jobKey(j) === k)) recs.push(record(JSON.parse(txt), 'Deleted', { deletedAt: ev[0]?.t || now }));
        const old = Date.now() - KEEP_DONE_DAYS * 864e5, gone = db.jobs.filter(j => j.done && new Date(doneTime(j)).getTime() < old);
        if (gone.length) { db.jobs = db.jobs.filter(j => !gone.includes(j)); gone.forEach(j => recs.push(record(j, 'Finished'))); }
        const ups = recs.map(x => env.DB.prepare(UPSERT).bind(x.id, x.booked, x.status, now, x.search, x.rec, v));
        const save = v === 0
          ? env.DB.prepare('INSERT OR IGNORE INTO state (id, v, db) VALUES (1, 1, ?)').bind(JSON.stringify(db))
          : env.DB.prepare('UPDATE state SET v=v+1, db=? WHERE id=1 AND v=?').bind(JSON.stringify(db), v);
        // Photo row is written in the same batch, only if the state is still at the version we read.
        const keep = photo && r.ok && env.DB.prepare('INSERT OR REPLACE INTO photos (id, t, jpeg) SELECT ?, ?, ? WHERE COALESCE((SELECT v FROM state WHERE id=1), 0)=?').bind(a.photoId, new Date().toISOString(), photo, v);
        const res = (await env.DB.batch([...(keep ? [keep] : []), ...ups, save])).at(-1);
        if (res.meta.changes === 1) {
          if (ev.length) await env.DB.batch(ev.map(e => env.DB.prepare('INSERT INTO events (t, part, jobno, cust, station, action, items, nums, name, dev, detail, colour, photo, last4, job_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .bind(e.t, e.part, e.jobno, e.cust, e.station, e.action, e.items, e.nums, e.name, e.dev, e.detail, e.colour, photoLink(e.photo), last4(e.part), e.jobId)));
          return json({ r, v: v + 1, db });
        }
      }
      return json({ error: 'Busy, try again' }, 503);
    }
    return json({ error: 'Not found' }, 404);
  }
};
