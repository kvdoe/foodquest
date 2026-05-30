export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon, address, displayName, cuisine, budget } = req.query;

  const YELP_API_KEY   = process.env.YELP_API_KEY;
  const MAPBOX_TOKEN   = process.env.MAPBOX_TOKEN;
  if (!YELP_API_KEY) return res.status(500).json({ error: 'Server misconfigured.' });

  // ── Resolve coordinates ────────────────────────────────────────────────────
  let searchLat    = lat;
  let searchLon    = lon;
  let resolvedName = displayName || address || '';

  if (!searchLat || !searchLon) {
    if (!address?.trim()) {
      return res.status(400).json({ error: 'Please enter a location.' });
    }
    const addr = address.trim();

    // Layer 1: Mapbox (best US coverage, Google Maps-level accuracy)
    if (MAPBOX_TOKEN) {
      try {
        const url =
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(addr)}.json` +
          `?access_token=${MAPBOX_TOKEN}&country=US&limit=1&language=en`;
        const r = await fetch(url, { headers: { 'User-Agent': 'TheHearthApp/1.0' }, signal: AbortSignal.timeout(6000) });
        if (r.ok) {
          const d = await r.json();
          const f = d.features?.[0];
          if (f) {
            searchLat    = String(f.geometry.coordinates[1]);
            searchLon    = String(f.geometry.coordinates[0]);
            resolvedName = f.place_name;
          }
        }
      } catch (_) {}
    }

    // Layer 2: US Census Bureau (official TIGER address database)
    if (!searchLat || !searchLon) {
      try {
        const cp = new URLSearchParams({ address: addr, benchmark: 'Public_AR_Current', format: 'json' });
        const cr = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${cp}`, { signal: AbortSignal.timeout(6000) });
        if (cr.ok) {
          const cd = await cr.json();
          const m  = cd?.result?.addressMatches?.[0];
          if (m) { searchLat = String(m.coordinates.y); searchLon = String(m.coordinates.x); resolvedName = m.matchedAddress; }
        }
      } catch (_) {}
    }

    // Layer 3: Photon
    if (!searchLat || !searchLon) {
      try {
        const pr = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(addr)}&limit=1&lang=en`, { signal: AbortSignal.timeout(5000) });
        if (pr.ok) {
          const pd  = await pr.json();
          const hit = (pd.features || []).find(f => !f.properties?.countrycode || f.properties.countrycode.toUpperCase() === 'US');
          if (hit) {
            searchLat    = String(hit.geometry.coordinates[1]);
            searchLon    = String(hit.geometry.coordinates[0]);
            const p      = hit.properties;
            resolvedName = [p.housenumber && p.street ? `${p.housenumber} ${p.street}` : (p.name || ''), p.city || p.town, p.state].filter(Boolean).join(', ');
          }
        }
      } catch (_) {}
    }

    // Layer 4: Nominatim (last resort)
    if (!searchLat || !searchLon) {
      try {
        const np = new URLSearchParams({ q: addr, format: 'json', limit: '1', countrycodes: 'us', 'accept-language': 'en' });
        const nr = await fetch(`https://nominatim.openstreetmap.org/search?${np}`, { headers: { 'User-Agent': 'TheHearthApp/1.0' }, signal: AbortSignal.timeout(5000) });
        if (nr.ok) { const nd = await nr.json(); if (nd?.length) { searchLat = nd[0].lat; searchLon = nd[0].lon; resolvedName = nd[0].display_name; } }
      } catch (_) {}
    }

    if (!searchLat || !searchLon) {
      return res.status(404).json({ error: `Could not locate "${addr}". Try selecting a suggestion from the dropdown, or add a city and state.` });
    }
  }

  // ── Exact price tier ───────────────────────────────────────────────────────
  const priceMap       = { '1':'1', '2':'2', '3':'3', '4':'4', any:'1,2,3,4' };
  const priceFilter    = priceMap[budget] || '1,2,3,4';
  const categoryFilter = cuisine || 'restaurants';

  // ── Yelp search ────────────────────────────────────────────────────────────
  const yp = new URLSearchParams({ latitude: searchLat, longitude: searchLon, categories: categoryFilter, price: priceFilter, sort_by: 'distance', limit: '12', radius: '8000' });
  const yr = await fetch(`https://api.yelp.com/v3/businesses/search?${yp}`, { headers: { Authorization: `Bearer ${YELP_API_KEY}` } });

  if (!yr.ok) {
    if (yr.status === 401) return res.status(502).json({ error: 'Yelp API key invalid.' });
    return res.status(502).json({ error: 'Could not fetch restaurants. Please try again.' });
  }

  const yd         = await yr.json();
  const businesses = yd.businesses || [];

  // For healthy searches, strip results whose Yelp categories include non-healthy food types.
  // Yelp's category aliases are food-type tags, not health indicators, so chains like BWW or
  // Marble Slab can appear if they have a secondary tag that matches. This blocklist removes them.
  const HEALTHY_BLOCKLIST = new Set(['icecream', 'chicken_wings', 'icecreameries', 'hotdog', 'hotdogs']);
  const results = categoryFilter.includes('healthfood')
    ? businesses.filter(b => !(b.categories || []).some(c => HEALTHY_BLOCKLIST.has(c.alias)))
    : businesses;

  // Enrich first 6 with real website URLs
  const enriched = await Promise.allSettled(
    results.slice(0, 6).map(async b => {
      try {
        const dr = await fetch(`https://api.yelp.com/v3/businesses/${b.id}`, { headers: { Authorization: `Bearer ${YELP_API_KEY}` } });
        if (dr.ok) { const dd = await dr.json(); return { ...b, website: dd.website || null }; }
      } catch (_) {}
      return { ...b, website: null };
    })
  );
  const enrichedMap = {};
  enriched.forEach((r, i) => { if (r.status === 'fulfilled') enrichedMap[results[i].id] = r.value; });

  return res.status(200).json({
    restaurants: results.map(b => enrichedMap[b.id] || b),
    total:       yd.total || results.length,
    geocoded:    resolvedName
  });
}