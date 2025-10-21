/************************************************************
 * Flight Alert Subs for SleekFlow — /webhook/chat
 ************************************************************/

// === CONFIGURATION ===
const CFG = {
  AERO_BASE: process.env.AERO_BASE || 'https://aeroapi.flightaware.com/aeroapi',
  AERO_KEY: process.env.AERO_KEY, // REQUIRED
  DEBUG_LOG: (process.env.DEBUG_LOG || '0') === '1',
};

// === DEPENDENCIES ===
const express = require('express');
const app = express();
app.use(express.json({ limit: '128kb' }));

// === HELPERS ===
function parseYmdToStartMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  const yr = +yyyy, mon = +mm, day = +dd;
  const startMs = Date.UTC(yr, mon - 1, day, 0, 0, 0, 0);
  const chk = new Date(startMs);
  if (chk.getUTCFullYear() !== yr || chk.getUTCMonth() + 1 !== mon || chk.getUTCDate() !== day) return null;
  return startMs;
}

function buildFlightsUrl(ident, start, end, mode) {
  const base = `${CFG.AERO_BASE}/flights/${encodeURIComponent(ident)}`;
  if (mode === 'date') return `${base}?start=${start}`;
  return `${base}?start=${start}&end=${end}`;
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json; charset=UTF-8',
      'x-apikey': CFG.AERO_KEY
    },
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

function formatLocal(iso, tz) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false, timeZoneName: 'short'
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
    const dd = parts.day, mm = parts.month, yyyy = parts.year, HH = parts.hour, MM = parts.minute;
    const tzLabel = tz || 'UTC';
    const tzShort = parts.timeZoneName || 'GMT';
    return `${dd}-${mm}-${yyyy} ${HH}:${MM} (${tzLabel} ${tzShort})`;
  } catch {
    return iso;
  }
}

// === ROUTE ===
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

  const startEpoch = Math.floor((startMs - 12 * 3600 * 1000) / 1000);
  const endEpoch   = Math.floor((startMs + 36 * 3600 * 1000) / 1000);
  const baseStartSec = Math.floor(startMs / 1000);
  const identRaw = String(flightIdent).toUpperCase().replace(/\s+/g, '');
  let flights = [];

  try {
    // 1) Try provider-style (start=YYYY-MM-DD)
    const url1 = buildFlightsUrl(identRaw, departureDate, null, 'date');
    const q1 = await fetchJson(url1);
    if (q1.ok && q1.json?.flights?.length) flights = q1.json.flights;

    // 2) Fallback epoch window (covers UTC edge cases)
    if (flights.length === 0) {
      const url2 = buildFlightsUrl(identRaw, startEpoch, endEpoch, 'epoch');
      const q2 = await fetchJson(url2);
      if (q2.ok && q2.json?.flights?.length) flights = q2.json.flights;
    }

    if (flights.length === 0) {
      return res.status(200).json({ ok: false, message: 'No flights found' });
    }

    const chosen = pickBestFlight(flights, baseStartSec) || flights[0];

    // If AeroAPI gives both ident (ICAO) and operator_iata, capture both
    const flightno_iata = chosen.operator_iata && chosen.flight_number
      ? `${chosen.operator_iata}${chosen.flight_number}`
      : flightIdent.toUpperCase();
    const flightno_icao = chosen.ident || flightno_iata; // ident is usually ICAO

    const depISO = chosen.scheduled_out || chosen.estimated_out || null;
    const arrISO = chosen.scheduled_in  || chosen.estimated_in  || null;
    const depTZ  = chosen.origin?.timezone || 'UTC';
    const arrTZ  = chosen.destination?.timezone || 'UTC';

    return res.status(200).json({
      ok: true,
      message: 'Match',
      flightno_iata,
      flightno_icao,
      departure_date_time: formatLocal(depISO, depTZ),
      departing_from: chosen.origin?.name || null,
      departure_gate: chosen.gate_origin || null,
      arrival_date_time: formatLocal(arrISO, arrTZ),
      arriving_at: chosen.destination?.name || null,
      arrival_gate: chosen.gate_destination || null
    });
  } catch (err) {
    if (CFG.DEBUG_LOG) console.error(err);
    return res.status(200).json({ ok: false, message: 'No flights found' });
  }
});

// === SERVER START ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  if (CFG.DEBUG_LOG) console.log(`Listening on ${PORT}`);
});
