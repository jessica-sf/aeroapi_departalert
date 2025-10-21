/************************************************************
 * Flight Alert Subs for SleekFlow — /webhook/chat (Lean)
 ************************************************************/

// === CONFIGURATION ===
const CFG = {
  AERO_BASE: process.env.AERO_BASE || 'https://aeroapi.flightaware.com/aeroapi',
  AERO_KEY: process.env.AERO_KEY,           // REQUIRED
  DEBUG_LOG: (process.env.DEBUG_LOG || '0') === '1',
};

// === DEPENDENCIES ===
// Using Node 20 global fetch; only Express is needed.
const express = require('express');

// === INIT ===
const app = express();
app.use(express.json({ limit: '128kb' }));

// === SECTION: CONSTANTS / MAPS ===
// Minimal IATA → ICAO map. Extend as needed for your region.
const IATA_TO_ICAO = {
  AK: 'AXM', // AirAsia
  MH: 'MAS', // Malaysia Airlines
  SQ: 'SIA', // Singapore Airlines
  TR: 'TGW', // Scoot
  OD: 'MXD', // Batik Air Malaysia (Malindo)
  QZ: 'AWQ', // Indonesia AirAsia
  FD: 'AIQ', // Thai AirAsia
  '6E': 'IGO', // IndiGo
  GA: 'GIA', // Garuda Indonesia
};

// === SECTION: HELPERS ===
// -- Validate YYYY-MM-DD → return start-of-day UTC (ms) or null
function parseYmdToStartMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  const yr = +yyyy, mon = +mm, day = +dd;
  const startMs = Date.UTC(yr, mon - 1, day, 0, 0, 0, 0);
  const chk = new Date(startMs);
  if (chk.getUTCFullYear() !== yr || (chk.getUTCMonth() + 1) !== mon || chk.getUTCDate() !== day) {
    return null; // catches things like 2025-02-31
  }
  return startMs;
}

// -- Build URLs
function buildFlightsUrl(ident, start, end, mode) {
  const base = `${CFG.AERO_BASE}/flights/${encodeURIComponent(ident)}`;
  if (mode === 'date') {
    // Mirror working portal style: start=YYYY-MM-DD (no end)
    return `${base}?start=${start}`; // start is a YYYY-MM-DD string here
  }
  // Epoch window
  return `${base}?start=${start}&end=${end}`; // start/end are seconds since epoch
}

// -- Fetch wrapper (returns {ok,status,json,raw})
async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json; charset=UTF-8',
      'x-apikey': CFG.AERO_KEY,
    },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { ok: r.ok, status: r.status, json, raw: text, url };
}

// -- Pick the flight instance nearest to the day start by scheduled_out
function pickBestFlight(flights, baseStartSec) {
  if (!Array.isArray(flights) || flights.length === 0) return null;
  const chosen = flights
    .map(f => {
      const ts = Date.parse(f.scheduled_out || f.scheduled_off || f.scheduled_departure || '') || 0;
      return { f, score: Math.abs(ts ? ts / 1000 - baseStartSec : Number.MAX_SAFE_INTEGER) };
    })
    .sort((a, b) => a.score - b.score)[0].f;
  return chosen || null;
}

// === ROUTES ===
// -- POST /webhook/chat
// Body: { "flightIdent": "AK6322", "departureDate": "2025-10-22" }
app.post('/webhook/chat', async (req, res) => {
  const { flightIdent, departureDate } = req.body || {};
  const debug = {};

  // Basic input checks
  if (!flightIdent || !departureDate) {
    return res.status(200).json({ ok: false, message: 'Invalid Date' });
  }

  // Validate date format and compute midnight UTC
  const startMs = parseYmdToStartMs(departureDate);
  if (startMs == null) {
    return res.status(200).json({ ok: false, message: 'Invalid Date' });
  }

  // Build a wider epoch window (-12h, +36h) to avoid UTC edge misses
  const startEpoch = Math.floor((startMs - 12 * 3600 * 1000) / 1000);
  const endEpoch   = Math.floor((startMs + 36 * 3600 * 1000) / 1000);
  const baseStartSec = Math.floor(startMs / 1000);
  if (CFG.DEBUG_LOG) debug.window = { startEpoch, endEpoch };

  // Normalize ident
  const identRaw = String(flightIdent).toUpperCase().replace(/\s+/g, '');

  try {
    // 1) Try provider-style: start=YYYY-MM-DD (no end)
    const url1 = buildFlightsUrl(identRaw, departureDate, null, 'date');
    const q1 = await fetchJson(url1);
    if (CFG.DEBUG_LOG) debug.try1 = { url: q1.url, status: q1.status };

    let flights = (q1.ok && q1.json && Array.isArray(q1.json.flights)) ? q1.json.flights : [];

    // 2) If none, fall back to epoch window
    if (flights.length === 0) {
      const url2 = buildFlightsUrl(identRaw, startEpoch, endEpoch, 'epoch');
      const q2 = await fetchJson(url2);
      if (CFG.DEBUG_LOG) debug.try2 = { url: q2.url, status: q2.status };
      flights = (q2.ok && q2.json && Array.isArray(q2.json.flights)) ? q2.json.flights : [];
    }

    // 3) If still none and ident looks IATA (2 letters + digits), map to ICAO and retry date-style
    if (flights.length === 0) {
      const m = /^([A-Z]{2})(\d{1,5})$/.exec(identRaw);
      if (m && IATA_TO_ICAO[m[1]]) {
        const icaoIdent = `${IATA_TO_ICAO[m[1]]}${m[2]}`;
        const url3 = buildFlightsUrl(icaoIdent, departureDate, null, 'date');
        const q3 = await fetchJson(url3);
        if (CFG.DEBUG_LOG) debug.try3 = { url: q3.url, status: q3.status };
        flights = (q3.ok && q3.json && Array.isArray(q3.json.flights)) ? q3.json.flights : [];
      } else if (CFG.DEBUG_LOG) {
        debug.try3 = { skipped: true, reason: 'not-iata-or-no-mapping' };
      }
    }

    // Final check
    if (flights.length === 0) {
      return res.status(200).json({
        ok: false,
        message: 'No flights found',
        ...(CFG.DEBUG_LOG ? { debug } : {}),
      });
    }

    // Pick best instance and return the 7 fields
    const chosen = pickBestFlight(flights, baseStartSec) || flights[0];
    const payload = {
      ok: true,
      message: 'Match',
      flight_no: chosen.ident || null,
      departure_date_time: chosen.scheduled_out || chosen.estimated_out || null,
      departing_from: chosen.origin?.airport_code || chosen.origin?.code || null,    // IATA first, fallback ICAO
      departure_gate: chosen.gate_origin || null,
      arrival_date_time: chosen.scheduled_in || chosen.estimated_in || null,
      arriving_at: chosen.destination?.airport_code || chosen.destination?.code || null,
      arrival_gate: chosen.gate_destination || null,
    };
    if (CFG.DEBUG_LOG) payload.debug = debug;
    return res.status(200).json(payload);

  } catch (err) {
    if (CFG.DEBUG_LOG) {
      debug.error = err?.message || String(err);
      return res.status(200).json({ ok: false, message: 'No flights found', debug });
    }
    return res.status(200).json({ ok: false, message: 'No flights found' });
  }
});

// === SERVER START ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  if (CFG.DEBUG_LOG) console.log(`Listening on ${PORT}`);
});
