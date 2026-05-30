export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { street, city, state, zip, cuisine, budget } = req.query;

  if (!city && !zip) {
    return res.status(400).json({ error: 'Please enter at least a city or ZIP code.' });
  }

  const YELP_API_KEY = process.env.YELP_API_KEY;
  if (!YELP_API_KEY) {
    return res.status(500).json({
      error: 'YELP_API_KEY is not set. Add it in Vercel → Settings → Environment Variables.'
    });
  }

  let lat, lon, displayName;

  // ── Strategy 1: US Census Bureau geocoder ──────────────────────────────────
  // Most accurate for US street addresses. Free, no key, structured query.
  if (street && (city || zip)) {
    try {
      const p = new URLSearchParams({ benchmark: 'Public_AR_Current', format: 'json' });
      p.set('street', street);
      if (city)  p.set('city', city);
      if (state) p.set('state', state);
      if (zip)   p.set('zip', zip);

      const r = await fetch(
        'https://geocoding.geo.census.gov/geocoder/locations/address?' + p,
        {
          headers: { 'User-Agent': 'TheHearthApp/1.0' },
          signal: AbortSignal.timeout(6000)
        }
      );
      if (r.ok) {
        const d = await r.json();
        const m = d?.result?.addressMatches?.[0];
        if (m) {
          lat         = String(m.coordinates.y); // Census returns y=lat, x=lon
          lon         = String(m.coordinates.x);
          displayName = m.matchedAddress;
        }
      }
    } catch (e) {
      console.error('Census geocoder error:', e.message);
    }
  }

  // ── Strategy 2: Nominatim structured search, US only ──────────────────────
  // Used when Census doesn't match (city-only, ZIP-only, or Census timeout).
  if (!lat || !lon) {
    try {
      // Build the best possible query from provided parts
      const queryParts = [street, city, state, zip].filter(Boolean);
      const q = queryParts.join(', ');

      const p = new URLSearchParams({
        q,
        format:       'json',
        limit:        '1',
        countrycodes: 'us',      // restrict to United States — fixes "Frisco" → SF bug
        addressdetails: '1',
        'accept-language': 'en'
      });

      const r = await fetch(
        'https://nominatim.openstreetmap.org/search?' + p,
        {
          headers: { 'User-Agent': 'TheHearthApp/1.0', 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(6000)
        }
      );
      if (r.ok) {
        const d = await r.json();
        if (d?.length) {
          lat         = d[0].lat;
          lon         = d[0].lon;
          displayName = d[0].display_name;
        }
      }
    } catch (e) {
      console.error('Nominatim error:', e.message);
    }
  }

  if (!lat || !lon) {
    return res.status(404).json({
      error: 'Location not found. Try adding a state or ZIP code for better accuracy.'
    });
  }

  // ── Yelp restaurant search ─────────────────────────────────────────────────
  const budgetMap = { '1': '1', '2': '1,2', '3': '1,2,3', '4': '1,2,3,4', any: '1,2,3,4' };
  const priceFilter    = budgetMap[budget] || '1,2,3,4';
  const categoryFilter = cuisine || 'restaurants';

  const yp = new URLSearchParams({
    latitude:   lat,
    longitude:  lon,
    categories: categoryFilter,
    price:      priceFilter,
    sort_by:    'distance',
    limit:      '12',
    radius:     '8000'
  });

  const yr = await fetch('https://api.yelp.com/v3/businesses/search?' + yp, {
    headers: { Authorization: 'Bearer ' + YELP_API_KEY }
  });

  if (!yr.ok) {
    const txt = await yr.text().catch(() => '');
    console.error('Yelp error', yr.status, txt);
    if (yr.status === 401) {
      return res.status(502).json({ error: 'Invalid Yelp API key.' });
    }
    return res.status(502).json({ error: 'Restaurant data unavailable right now. Try again.' });
  }

  const yd = await yr.json();
  const businesses = yd.businesses || [];

  // Enrich first 6 with real website URL (details endpoint)
  const toEnrich = businesses.slice(0, 6);
  const enriched = await Promise.allSettled(
    toEnrich.map(async b => {
      try {
        const dr = await fetch('https://api.yelp.com/v3/businesses/' + b.id, {
          headers: { Authorization: 'Bearer ' + YELP_API_KEY }
        });
        if (dr.ok) {
          const dd = await dr.json();
          return { ...b, website: dd.website || null };
        }
      } catch (_) {}
      return { ...b, website: null };
    })
  );
  const enrichedMap = {};
  enriched.forEach((r, i) => {
    if (r.status === 'fulfilled') enrichedMap[toEnrich[i].id] = r.value;
  });
  const restaurants = businesses.map(b => enrichedMap[b.id] || b);

  return res.status(200).json({
    restaurants,
    total:    yd.total || businesses.length,
    geocoded: displayName
  });
}