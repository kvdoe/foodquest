export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon, address, cuisine, budget } = req.query;

  const YELP_API_KEY = process.env.YELP_API_KEY;
  if (!YELP_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured — contact support.' });
  }

  // ── Resolve coordinates ──────────────────────────────────────────────────
  // Priority: frontend-supplied lat/lon (from autocomplete, exact) > text geocoding
  let searchLat = lat;
  let searchLon = lon;
  let displayName = req.query.displayName || address || '';

  if (!searchLat || !searchLon) {
    if (!address) {
      return res.status(400).json({ error: 'Please enter and select a location.' });
    }

    // Text geocoding fallback — US only
    // Try Census Bureau first (most accurate for street addresses)
    try {
      const censusParams = new URLSearchParams({
        address: address,
        benchmark: 'Public_AR_Current',
        format: 'json'
      });
      const cr = await fetch(
        'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?' + censusParams,
        { headers: { 'User-Agent': 'TheHearthApp/1.0' }, signal: AbortSignal.timeout(5000) }
      );
      if (cr.ok) {
        const cd = await cr.json();
        const match = cd?.result?.addressMatches?.[0];
        if (match) {
          searchLat  = String(match.coordinates.y);
          searchLon  = String(match.coordinates.x);
          displayName = match.matchedAddress;
        }
      }
    } catch (_) {}

    // Nominatim fallback (city-only, ZIP, neighborhood searches)
    if (!searchLat || !searchLon) {
      try {
        const np = new URLSearchParams({
          q: address,
          format: 'json',
          limit: '1',
          countrycodes: 'us',
          addressdetails: '1',
          'accept-language': 'en'
        });
        const nr = await fetch(
          'https://nominatim.openstreetmap.org/search?' + np,
          {
            headers: { 'User-Agent': 'TheHearthApp/1.0', 'Accept-Language': 'en' },
            signal: AbortSignal.timeout(5000)
          }
        );
        if (nr.ok) {
          const nd = await nr.json();
          if (nd?.length) {
            searchLat  = nd[0].lat;
            searchLon  = nd[0].lon;
            displayName = nd[0].display_name;
          }
        }
      } catch (_) {}
    }

    if (!searchLat || !searchLon) {
      return res.status(404).json({
        error: 'Location not found. Please select a result from the dropdown suggestions.'
      });
    }
  }

  // ── Price filter — exact tier matching ────────────────────────────────────
  // $ = only $ restaurants, $$ = only $$, etc.  "any" = all tiers.
  const priceMap = { '1': '1', '2': '2', '3': '3', '4': '4', any: '1,2,3,4' };
  const priceFilter    = priceMap[budget] || '1,2,3,4';
  const categoryFilter = cuisine || 'restaurants';

  // ── Yelp search ───────────────────────────────────────────────────────────
  const yp = new URLSearchParams({
    latitude:   searchLat,
    longitude:  searchLon,
    categories: categoryFilter,
    price:      priceFilter,
    sort_by:    'distance',
    limit:      '12',
    radius:     '8000'   // ~5 miles
  });

  const yr = await fetch('https://api.yelp.com/v3/businesses/search?' + yp, {
    headers: { Authorization: 'Bearer ' + YELP_API_KEY }
  });

  if (!yr.ok) {
    if (yr.status === 401) return res.status(502).json({ error: 'Yelp API key invalid.' });
    return res.status(502).json({ error: 'Could not fetch restaurants. Please try again.' });
  }

  const yd = await yr.json();
  const businesses = yd.businesses || [];

  // Enrich first 6 results with the restaurant's actual website URL
  const enriched = await Promise.allSettled(
    businesses.slice(0, 6).map(async b => {
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
    if (r.status === 'fulfilled') enrichedMap[businesses[i].id] = r.value;
  });

  return res.status(200).json({
    restaurants: businesses.map(b => enrichedMap[b.id] || b),
    total:       yd.total || businesses.length,
    geocoded:    displayName
  });
}