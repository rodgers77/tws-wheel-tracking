// Photo -> part number via Cloudflare Workers AI (Mistral Small 3.1 vision). ~38 neurons per 1024px photo.
// Result is only a suggestion: the phone shows it for staff to check, never auto-submits.
const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const PROMPT = 'This photo shows an alloy wheel or a wheel label. Find the part number cast, stamped or printed on it (examples of formats: 52910-F1500, 8K0601025K, A2054011800, 36116796249). The text may be sideways or upside down. Reply with ONLY the part number exactly as shown, including any dash, or NONE.';
const OK = /^(\d{5}-[A-Z0-9]{5}|A\d{10}|\d{11}|\d[A-Z]\d{7}[A-Z]{0,2}|[A-Z0-9]{2,3}\d{6}[A-Z]{0,2}|[A-Z0-9][A-Z0-9-]{5,15})$/;
export async function readPart(env, bytes) {
  if (!env.AI) return { code: '', error: 'no AI binding' };
  if (bytes.byteLength > 4e6) return { code: '', error: 'photo too big' };
  const u = new Uint8Array(bytes); let s = '';
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  const r = await env.AI.run(MODEL, { max_tokens: 30, messages: [{ role: 'user', content: [
    { type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + btoa(s) } }] }] });
  const raw = String(r.response ?? r.choices?.[0]?.message?.content ?? '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '');
  return { code: raw && raw !== 'NONE' && OK.test(raw) ? raw : '', raw: raw.slice(0, 40) };
}
