// netlify/functions/maps-distance.js
// Driving distances from the restaurant to each delivery, keeping the Google key server-side.
//
// How each delivery is located (most reliable first):
//   1. POSTCODE — if the delivery has a full UK postcode, Google measures to the middle
//      of that postcode. The first line of the address is ignored, because drivers and
//      customers often type it wrong.
//   2. PLACE NAME — no postcode (e.g. someone typed "Freshwater"): known local places are
//      expanded to their full address, then Google's geocoder looks it up near the
//      restaurant (not anywhere in the UK).
//   3. ADDRESS TEXT — last resort: the typed address plus the local area.
// If a postcode gives a silly distance (likely misread), the address is tried as well
// and the more sensible answer is used — and flagged.
//
// Request (new):  { site: 'bridport', deliveries: [{ address, postcode }] }
//   → { results: [{ miles, method, matched, query, note }] }  (same order as sent)
// Request (old):  { origin, destinations: ['addr', ...] } — still supported.

const BATCH_SIZE = 25;          // Google limit per Distance Matrix request
const MAX_SANE_MILES = 12;      // one-way; anything further is probably a wrong match

const SITES = {
  bridport:   { origin: '68 South Street, Bridport, DT6 3NN',   area: 'Bridport, Dorset',     lat: 50.7336, lng: -2.7584 },
  dorchester: { origin: '5 Trinity Street, Dorchester, DT1 1TU', area: 'Dorchester, Dorset',   lat: 50.7154, lng: -2.4370 },
  rivaaz:     { origin: '7 St Thomas Street, Lymington, SO41 9NA', area: 'Lymington, Hampshire', lat: 50.7584, lng: -1.5446 }
};

// Short names people type → full address. Add more here as they come up.
const PLACE_ALIASES = {
  bridport: [
    [/fresh\s*water/i,            'Freshwater Beach Holiday Park, Burton Bradstock, Bridport, DT6 4PT'],
    [/west\s*bay\s*holiday/i,     'West Bay Holiday Park, West Bay, Bridport, DT6 4HB'],
    [/highlands?\s*end/i,         'Highlands End Holiday Park, Eype, Bridport, Dorset'],
    [/golden\s*cap/i,             'Golden Cap Holiday Park, Seatown, Chideock, Dorset'],
    [/seadown/i,                  'Seadown Holiday Park, Charmouth, Dorset']
  ],
  dorchester: [],
  rivaaz: []
};

const PC_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
function findPostcode(...texts) {
  for (const t of texts) {
    const m = String(t || '').toUpperCase().match(PC_RE);
    if (m) return m[1] + ' ' + m[2];
  }
  return '';
}

async function getJSON(url) {
  const r = await fetch(url);
  return r.json();
}

// Geocode free text, biased to ~25km around the restaurant.
async function geocodeNear(text, site, key) {
  const b = `${site.lat - 0.25},${site.lng - 0.4}|${site.lat + 0.25},${site.lng + 0.4}`;
  const url = 'https://maps.googleapis.com/maps/api/geocode/json'
    + `?address=${encodeURIComponent(text)}&bounds=${encodeURIComponent(b)}&components=country:GB&region=uk&key=${key}`;
  const data = await getJSON(url);
  if (data.status !== 'OK' || !data.results || !data.results.length) return { status: data.status };
  const g = data.results[0];
  return { status: 'OK', latlng: g.geometry.location.lat + ',' + g.geometry.location.lng, matched: g.formatted_address };
}

async function distanceBatch(origin, dests, key) {
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json'
    + `?origins=${encodeURIComponent(origin)}&destinations=${dests.map(encodeURIComponent).join('|')}`
    + `&units=imperial&mode=driving&region=uk&key=${key}`;
  const data = await getJSON(url);
  if (data.status !== 'OK') {
    return { error: data.status + (data.error_message ? ' — ' + data.error_message : ''), rows: dests.map(() => null) };
  }
  const els = (data.rows && data.rows[0] && data.rows[0].elements) || [];
  return {
    error: '',
    rows: dests.map((d, i) => {
      const el = els[i];
      return (el && el.status === 'OK' && el.distance)
        ? { miles: parseFloat((el.distance.value / 1609.34).toFixed(2)), matched: (data.destination_addresses || [])[i] || '' }
        : null;
    })
  };
}

async function distances(origin, dests, key) {
  const uniq = [...new Set(dests.filter(Boolean))];
  const out = {}, errors = [];
  for (let i = 0; i < uniq.length; i += BATCH_SIZE) {
    const batch = uniq.slice(i, i + BATCH_SIZE);
    let ans;
    try { ans = await distanceBatch(origin, batch, key); }
    catch (e) { ans = { error: e.message, rows: batch.map(() => null) }; }
    if (ans.error) errors.push(ans.error);
    batch.forEach((d, j) => { out[d] = ans.rows[j]; });
  }
  return { map: out, errors };
}

const json = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return json(500, { error: 'Maps API key not configured' });

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return json(400, { error: 'Invalid JSON' }); }

  try {
    // ---- old request shape: plain address strings ----
    if (!body.deliveries) {
      const { origin, destinations } = body;
      if (!origin || !destinations || !destinations.length) return json(400, { error: 'Missing origin or destinations' });
      const d = await distances(origin, destinations, KEY);
      const results = destinations.map(dest => {
        const r = d.map[dest];
        return r ? { destination: dest, miles: r.miles, status: 'OK', matched: r.matched } : { destination: dest, miles: null, status: 'NO_RESULT' };
      });
      const payload = { results };
      if (d.errors.length && !results.some(r => r.status === 'OK')) payload.error = 'Maps API error: ' + d.errors[0];
      return json(200, payload);
    }

    // ---- new request shape ----
    const site = SITES[body.site] || SITES.bridport;
    const aliases = PLACE_ALIASES[body.site] || [];
    const list = body.deliveries || [];
    let geocodeDenied = false;

    // 1) decide what to measure to for each delivery
    const plans = await Promise.all(list.map(async (dl) => {
      const address = String(dl.address || '').trim();
      const pc = findPostcode(dl.postcode, address);
      const plan = { pc, address, primary: '', primaryMethod: '', fallback: '', fallbackMethod: '', matchedText: '' };
      // text version (used when there is no postcode, or the postcode gives a silly answer)
      let text = address.replace(PC_RE, '').replace(/[,\s]+$/, '').trim();
      const alias = aliases.find(a => a[0].test(text));
      if (alias) text = alias[1];
      let textDest = '', textMethod = '';
      if (text && text !== '—') {
        if (!geocodeDenied) {
          try {
            const g = await geocodeNear(alias ? text : text + ', ' + site.area, site, KEY);
            if (g.status === 'OK') { textDest = g.latlng; textMethod = alias ? 'place' : 'address'; plan.matchedText = g.matched; }
            else if (g.status === 'REQUEST_DENIED') geocodeDenied = true;
          } catch (e) { /* fall through to plain text */ }
        }
        if (!textDest) { textDest = (alias ? text : text + ', ' + site.area) + ', UK'; textMethod = alias ? 'place' : 'address'; }
      }
      if (pc) { plan.primary = pc + ', UK'; plan.primaryMethod = 'postcode'; plan.fallback = textDest; plan.fallbackMethod = textMethod; }
      else { plan.primary = textDest; plan.primaryMethod = textMethod; }
      return plan;
    }));

    // 2) measure everything in as few Google calls as possible
    const d = await distances(site.origin, plans.flatMap(p => [p.primary, p.fallback]), KEY);

    // 3) pick the answer for each delivery
    const results = plans.map(p => {
      const a = p.primary ? d.map[p.primary] : null;
      const b = p.fallback ? d.map[p.fallback] : null;
      const pick = (r, method, dest) => ({
        miles: r.miles, method,
        matched: method === 'postcode' ? p.pc : (p.matchedText || r.matched),
        query: dest
      });
      if (a && a.miles <= MAX_SANE_MILES) return pick(a, p.primaryMethod, p.primary);
      if (a && b && b.miles <= MAX_SANE_MILES) return Object.assign(pick(b, p.fallbackMethod, p.fallback), { note: `postcode ${p.pc} gave ${a.miles}mi — looks wrong, used the address instead` });
      if (a) return Object.assign(pick(a, p.primaryMethod, p.primary), { note: `${a.miles}mi — check this address` });
      if (b) return Object.assign(pick(b, p.fallbackMethod, p.fallback), { note: `postcode ${p.pc} not found — used the address` });
      return { miles: null, method: '', matched: '', query: p.primary, note: 'not found on Google Maps' };
    });

    const payload = { results };
    if (d.errors.length && !results.some(r => r.miles != null)) payload.error = 'Maps API error: ' + d.errors[0];
    else if (d.errors.length) payload.warning = 'Some addresses could not be looked up: ' + d.errors[0];
    if (geocodeDenied) payload.warning = (payload.warning ? payload.warning + '. ' : '') + 'Geocoding API is not enabled on the Google key, so place names were looked up as plain text';
    return json(200, payload);
  } catch (err) {
    return json(500, { error: err.message });
  }
};
