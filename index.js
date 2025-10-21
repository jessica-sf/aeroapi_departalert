/************************************************************
 * Flight Alert Subs for SleekFlow — /webhook/chat 
 * - Airport names for departing/arriving
 * - Times formatted: DD-MM-YYYY HH:mm (Area/City GMT+X)
 ************************************************************/

// === CONFIGURATION ===
const CFG = {
  AERO_BASE: process.env.AERO_BASE || 'https://aeroapi.flightaware.com/aeroapi',
  AERO_KEY: process.env.AERO_KEY,           // REQUIRED
  DEBUG_LOG: (process.env.DEBUG_LOG || '0') === '1',
};

// === DEPENDENCIES ===
const express = require('express');
const app = express();
app.use(express.json({ limit: '128kb' }));

// Minimal IATA → ICAO map (extend as needed)
const IATA_TO_ICAO = {
  AK: 'AXM', MH: 'MAS', SQ: 'SIA', TR: 'TGW', OD: 'MXD',
  QZ: 'AWQ', FD: 'AIQ', '6E': 'IGO', GA: 'GIA',
};

// === HELPERS ===
function parseYmdToStartMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  const yr = +yyyy, mon = +mm, day = +dd;
  const startMs = Date.UTC(yr, mon - 1, day, 0, 0, 0, 0);
  const chk = new Date(startMs);
  if (chk.getUTCFullYear() !== yr || (chk.getUTCMonth() + 1) !== mon || chk.getUTCDate() !== day) return null;
  return startMs;
}

function buildFlightsUrl(ident, start, end, mode) {
  const base = `${CFG.AERO_BASE}/flights/${encodeURIComponent(ident)}`;
  if (mode === 'date') return `${base}?start=${start}`;          // start as 'YYYY-MM-DD'
  return `${base}?start=${start}&end=${end}`;                    // epoch seconds
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { 'Accept': 'application/json; charset=UTF-8', 'x-apikey': CFG.AERO_KEY },
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { ok: r.ok, status: r.status, json, raw: text, url };
}

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

// Format ISO → "DD-MM-YYYY HH:mm (Area/City GMT+X)"
function formatLocal(iso, tz) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
      timeZoneName: 'short' // usually gives "GMT+8"
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
    const dd = parts.day, mm = parts.month, yyyy = parts.year, HH = parts.hour, MM = parts.minute;
    const tzLabel = tz || 'UTC';
    const tzShort = parts.timeZoneName || 'GMT';
    return `${dd}-${mm}-${yyyy} ${HH}:${MM} (${tzLabel} ${tzShort})`;
  } catch {
    return iso; // fallback
  }
}

// === ROUTES ===
// POST /webhook/chat
// Body: { "flightIdent": "AK6322", "departureDate": "2025-10-22" }
app.post('/webhook/chat', async (req, res) => {
  const { flightIdent, departureDate } = req.body || {};
  const debug = {};

  if (!flightIdent || !departureDate) {
    return res.status(200).json({ ok: false, message: 'Invalid Date' });
  }

  const startMs = parseYmdToStartMs(departureDate);
  if (startMs == null) {
    return res.status(200).json({ ok: false, message: 'Invalid Date' });
  }

  const startEpoch = Math.floor((startMs - 12 * 3600 * 1000) / 1000); // -12h
  const endEpoch   = Math.floor((startMs + 36 * 3600 * 1000) / 1000); // +36h
  const baseStartSec = Math.floor(startMs / 1000);
  if (CFG.DEBUG_LOG) debug.window = { startEpoch, endEpoch };

  const identRaw = String(flightIdent).toUpperCase().replace(/\s+/g, '');

  try {
    // 1) Try provider-style: start=YYYY-MM-DD
    const url1 = buildFlightsUrl(identRaw, departureDate, null, 'date');
    const q1 = await fetchJson(url1);
    if (CFG.DEBUG_LOG) debug.try1 = { url: q1.url, status: q1.status };
    let flights = (q1.ok && q1.json && Array.isArray(q1.json.flights)) ? q1.json.flights : [];

    // 2) Fallback: epoch window
    if (flights.length === 0) {
      const url2 = buildFlightsUrl(identRaw, startEpoch, endEpoch, 'epoch');
      const q2 = await fetchJson(url2);
      if (CFG.DEBUG_LOG) debug.try2 = { url: q2.url, status: q2.status };
      flights = (q2.ok && q2.json && Array.isArray(q2.json.flights)) ? q2.json.flights : [];
    }

    // 3) Fallback: map IATA → ICAO and retry (date mode)
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

    if (flights.length === 0) {
      return res.status(200).json({ ok: false, message: 'No flights found', ...(CFG.DEBUG_LOG ? { debug } : {}) });
    }

    const chosen = pickBestFlight(flights, baseStartSec) || flights[0];

    // Choose times (scheduled preferred; fallback to estimated) and format in local airport TZs
    const depISO = chosen.scheduled_out || chosen.estimated_out || null;
    const arrISO = chosen.scheduled_in  || chosen.estimated_in  || null;
    const depTZ  = chosen.origin?.timezone || 'UTC';
    const arrTZ  = chosen.destination?.timezone || 'UTC';

    return res.status(200).json({
      ok: true,
      message: 'Match',
      flight_no: chosen.ident || null,
      departure_date_time: formatLocal(depISO, depTZ),
      departing_from: chosen.origin?.name || null,          // <-- airport name
      departure_gate: chosen.gate_origin || null,
      arrival_date_time: formatLocal(arrISO, arrTZ),
      arriving_at: chosen.destination?.name || null,        // <-- airport name
      arrival_gate: chosen.gate_destination || null,
      ...(CFG.DEBUG_LOG ? { debug } : {})
    });
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
