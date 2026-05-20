// netlify/functions/maps-distance.js
// Proxies Google Maps Distance Matrix API — keeps API key server-side

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!GOOGLE_MAPS_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Maps API key not configured' }) };
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

  // Build Distance Matrix request
  const destStr = destinations.map(d => encodeURIComponent(d)).join('|');
  const originStr = encodeURIComponent(origin);
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originStr}&destinations=${destStr}&units=imperial&mode=driving&key=${GOOGLE_MAPS_KEY}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: 'Maps API error: ' + data.status, raw: data })
      };
    }

    // Extract miles for each destination
    const rows = data.rows[0].elements;
    const results = destinations.map((dest, i) => {
      const el = rows[i];
      if (el.status === 'OK') {
        // distance.value is in metres — convert to miles
        const miles = el.distance.value / 1609.34;
        return { destination: dest, miles: parseFloat(miles.toFixed(2)), status: 'OK' };
      }
      return { destination: dest, miles: null, status: el.status };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
