// netlify/functions/maps-distance.js
// Proxies Google Maps Distance Matrix API — keeps API key server-side.
//
// Google only accepts 25 destinations per request. Busy nights have more drops than
// that, so the addresses are sent in batches of 25 and the answers stitched together.
// (Before, one request with 30+ addresses failed outright and every drop silently
// fell back to the AI's guessed miles.)

const BATCH_SIZE = 25;

async function lookupBatch(origin, batch, key) {
  const destStr = batch.map(d => encodeURIComponent(d)).join('|');
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json'
    + `?origins=${encodeURIComponent(origin)}&destinations=${destStr}`
    + `&units=imperial&mode=driving&region=uk&key=${key}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.status !== 'OK') {
    const why = data.status + (data.error_message ? ' — ' + data.error_message : '');
    return { error: why, results: batch.map(dest => ({ destination: dest, miles: null, status: data.status })) };
  }
  const els = (data.rows && data.rows[0] && data.rows[0].elements) || [];
  return {
    error: '',
    results: batch.map((dest, i) => {
      const el = els[i];
      if (el && el.status === 'OK' && el.distance) {
        // distance.value is in metres — convert to miles
        return { destination: dest, miles: parseFloat((el.distance.value / 1609.34).toFixed(2)), status: 'OK',
                 matched: (data.destination_addresses || [])[i] || '' };
      }
      return { destination: dest, miles: null, status: el ? el.status : 'NO_RESULT' };
    })
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!GOOGLE_MAPS_KEY) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Maps API key not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { origin, destinations } = body;
  if (!origin || !destinations || !destinations.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing origin or destinations' }) };
  }

  try {
    const batches = [];
    for (let i = 0; i < destinations.length; i += BATCH_SIZE) batches.push(destinations.slice(i, i + BATCH_SIZE));
    const answers = await Promise.all(batches.map(b => lookupBatch(origin, b, GOOGLE_MAPS_KEY).catch(err => ({
      error: err.message, results: b.map(dest => ({ destination: dest, miles: null, status: 'FETCH_FAILED' }))
    }))));

    const results = [].concat(...answers.map(a => a.results));
    const errors = answers.map(a => a.error).filter(Boolean);
    const payload = { results };
    // Only report an overall error if nothing at all came back
    if (errors.length && !results.some(r => r.status === 'OK')) payload.error = 'Maps API error: ' + errors[0];
    else if (errors.length) payload.warning = 'Some addresses could not be looked up: ' + errors[0];

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
