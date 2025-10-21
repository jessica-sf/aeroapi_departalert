/************************************************************
 * Flight Alert Subs for SleekFlow
 ************************************************************/

// === CONFIGURATION ===
const CFG = {
  AERO_BASE: process.env.AERO_BASE || 'https://aeroapi.flightaware.com/aeroapi',
  AERO_KEY: process.env.AERO_KEY, // required
  DEBUG_LOG: false,
};

// === DEPENDENCIES ===
const express = require('express');
const fetch = global.fetch;

// === INIT ===
const app = express();
app.use(express.json({ limit: '128kb' }));

// === HELPERS ===
function parseYmdToStartEnd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd || '').trim());
  if (!m) return { ok: false };
  const [_, yyyy, mm, dd] = m;
  const yr = +yyyy, mon = +mm, day = +dd;

  const startMs = Date.UTC(yr, mon - 1, day, 0, 0, 0, 0);
  const chk = new Date(startMs);
  if (chk.getUTCFullYear() !== yr || (chk.getUTCMonth() + 1) !== mon || chk.getUTCDate() !== day) {
    return { ok: false };
  }
  return { ok: true, start: Math.floor(startMs / 1000), end: Math.floor(startMs / 1000) + 86400 };
}

function flightsUrl(ident, start, end) {
  return `${CFG.AERO_BASE}/flights/${encodeURIComponent(ident)}?start=${start}&end=${end}`;
}

// === ROUTES ===
// POST /webhook/chat
// Body: { "flightIdent": "AK6322", "departureDate": "2025-10-21" }
app.post('/webhook/chat', async (req, res) => {
  try {
    const { flightIdent, departureDate } = req.body || {};
    if (!flightIdent || !departureDate) {
      return res.status(200).json({ ok: false, message: 'Invalid Date' });
    }

    const parsed = parseYmdToStartEnd(departureDate);
    if (!parsed.ok) {
      return res.status(200).json({ ok: false, message: 'Invalid Date' });
    }

    const ident = String(flightIdent).toUpperCase().trim();
    const url = flightsUrl(ident, parsed.start, parsed.end);
    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json; charset=UTF-8',
        'x-apikey': CFG.AERO_KEY
      }
    });

    if (!r.ok) {
      return res.status(200).json({ ok: false, message: 'No flights found' });
    }

    const data = await r.json();
    const flights = Array.isArray(data.flights) ? data.flights : [];
    if (flights.length === 0) {
      return res.status(200).json({ ok: false, message: 'No flights found' });
    }

    // Pick instance closest to day start by scheduled_out (simple & fast)
    const base = parsed.start;
    const chosen = flights
      .map(f => {
        const ts = Date.parse(f.scheduled_out || f.scheduled_off || f.scheduled_departure || '') || 0;
        return { f, score: Math.abs(ts ? ts / 1000 - base : Number.MAX_SAFE_INTEGER) };
      })
      .sort((a, b) => a.score - b.score)[0].f;

    // Return separated vars
    return res.status(200).json({
      ok: true,
      message: 'Match',
      flight_no: chosen.ident || null,
      departure_date_time: chosen.scheduled_out || chosen.estimated_out || null,
      departing_from: chosen.origin?.airport_code || chosen.origin?.code || null, // IATA first, fallback ICAO
      departure_gate: chosen.gate_origin || null,
      arrival_date_time: chosen.scheduled_in || chosen.estimated_in || null,
      arriving_at: chosen.destination?.airport_code || chosen.destination?.code || null,
      arrival_gate: chosen.gate_destination || null
    });
  } catch (e) {
    if (CFG.DEBUG_LOG) console.error('SERVER_ERROR:', e);
    return res.status(200).json({ ok: false, message: 'No flights found' });
  }
});

// (Future) POST /webhook/subscribing  ← add later for creating alert subscriptions

// === SERVER START ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  if (CFG.DEBUG_LOG) console.log(`Listening on ${PORT}`);
});
