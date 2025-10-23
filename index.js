/************************************************************
 * Flight Alert Subs for SleekFlow — Cloud Run Frontend
 * 1️⃣ /webhook/chat       → lookup flight
 * 2️⃣ /webhook/subscribe  → create alert (1,3,5 min pre-dep)
 ************************************************************/

// === CONFIGURATION ===
const CFG = {
  AERO_BASE: process.env.AERO_BASE || 'https://aeroapi.flightaware.com/aeroapi',
  AERO_KEY:  process.env.AERO_KEY, // REQUIRED
  ALERTS_HOOK_BASE: process.env.ALERTS_HOOK_BASE || '',
  ALERTS_TOKEN:     process.env.ALERTS_TOKEN || 'change-me',
  SLEEKFLOW_WEBHOOK_URL: process.env.SLEEKFLOW_WEBHOOK_URL || '',
  SLEEKFLOW_AUTH:   process.env.SLEEKFLOW_AUTH || '',
  DEBUG_LOG: (process.env.DEBUG_LOG || '0') === '1'
};

// === DEPENDENCIES ===
const express = require('express');
const crypto  = require('crypto');
const app = express();
app.use(express.json({ limit: '128kb' }));

/************************************************************
 * === HELPERS (shared) ===
 ************************************************************/
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
    }
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

/************************************************************
 * 1️⃣  /webhook/chat  — flight lookup
 ************************************************************/
app.post('/webhook/chat', async (req, res) => {
  const { flightIdent, departureDate } = req.body || {};

  if (!flightIdent || !departureDate)
    return res.status(200).json({ ok: false, message: 'Invalid Date' });

  const startMs = parseYmdToStartMs(departureDate);
  if (startMs == null)
    return res.status(200).json({ ok: false, message: 'Invalid Date' });

  const startEpoch = Math.floor((startMs - 12 * 3600 * 1000) / 1000);
  const endEpoch   = Math.floor((startMs + 36 * 3600 * 1000) / 1000);
  const baseStartSec = Math.floor(startMs / 1000);
  const identRaw = String(flightIdent).toUpperCase().replace(/\s+/g, '');
  let flights = [];

  try {
    // Try provider-style (start=YYYY-MM-DD)
    const url1 = buildFlightsUrl(identRaw, departureDate, null, 'date');
    const q1 = await fetchJson(url1);
    if (q1.ok && q1.json?.flights?.length) flights = q1.json.flights;

    // Fallback epoch window (covers UTC edge cases)
    if (flights.length === 0) {
      const url2 = buildFlightsUrl(identRaw, startEpoch, endEpoch, 'epoch');
      const q2 = await fetchJson(url2);
      if (q2.ok && q2.json?.flights?.length) flights = q2.json.flights;
    }

    if (flights.length === 0)
      return res.status(200).json({ ok: false, message: 'No flights found' });

    const chosen = pickBestFlight(flights, baseStartSec) || flights[0];
    const flightno_iata = chosen.operator_iata && chosen.flight_number
      ? `${chosen.operator_iata}${chosen.flight_number}`
      : flightIdent.toUpperCase();
    const flightno_icao = chosen.ident || flightno_iata;

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

/************************************************************
 * 2️⃣  /webhook/subscribe  — create AeroAPI alert
 ************************************************************/

// --- helpers specific to alert creation ---
function buildAlertPayload({ identIcao, startYmd, targetUrl }) {
  return {
    ident: identIcao,
    start: startYmd,
    end:   startYmd,

    // Alert 1,3,5 min before departure
    impending_departure: [1, 3, 5],

    events: {
      departure: true,   // required for impending_departure to fire
      cancelled: true,
      diverted:  true,
      arrival:   false,
      filed:     false,
      out:       false,
      off:       false,
      on:        false,
      in:        false,
      hold_start:false,
      hold_end:  false
    },

    target_url: targetUrl
  };
}

async function postAeroAlert(payload) {
  const r = await fetch(`${CFG.AERO_BASE}/alerts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Accept': 'application/json; charset=UTF-8',
      'x-apikey': CFG.AERO_KEY
    },
    body: JSON.stringify(payload)
  });
  const raw = await r.text(); let json; try { json = JSON.parse(raw); } catch { json = null; }
  return { ok: r.ok, status: r.status, json, raw };
}

app.post('/webhook/subscribe', async (req, res) => {
  try {
    const { userRef, flightno_iata, flightno_icao, departureDate } = req.body || {};
    if (!userRef || !departureDate)
      return res.status(200).json({ ok: false, message: 'Missing userRef or departureDate' });
    if (!CFG.AERO_KEY)
      return res.status(200).json({ ok: false, message: 'Server missing AERO_KEY' });
    if (!CFG.ALERTS_HOOK_BASE || !CFG.ALERTS_TOKEN)
      return res.status(200).json({ ok: false, message: 'Server missing alerts hook config' });

    const identRaw = String((flightno_icao || flightno_iata || '')).toUpperCase().replace(/\s+/g, '');
    const startMs = parseYmdToStartMs(departureDate);
    if (startMs == null)
      return res.status(200).json({ ok: false, message: 'Invalid Date' });

    const startEpoch = Math.floor((startMs - 12 * 3600 * 1000) / 1000);
    const endEpoch   = Math.floor((startMs + 36 * 3600 * 1000) / 1000);
    const baseStartSec = Math.floor(startMs / 1000);
    const url1 = buildFlightsUrl(identRaw, departureDate, null, 'date');
    const q1 = await fetchJson(url1);
    let flights = q1.ok && q1.json?.flights?.length ? q1.json.flights : [];
    if (flights.length === 0) {
      const url2 = buildFlightsUrl(identRaw, startEpoch, endEpoch, 'epoch');
      const q2 = await fetchJson(url2);
      if (q2.ok && q2.json?.flights?.length) flights = q2.json.flights;
    }
    if (flights.length === 0)
      return res.status(200).json({ ok: false, message: 'No flights found' });

    const chosen = pickBestFlight(flights, baseStartSec) || flights[0];
    const flightnoIata = chosen.operator_iata && chosen.flight_number
      ? `${chosen.operator_iata}${chosen.flight_number}`
      : flightno_iata || identRaw;
    const flightnoIcao = chosen.ident || flightnoIata;

    const targetUrl = `${CFG.ALERTS_HOOK_BASE.replace(/\/+$/, '')}/${encodeURIComponent(CFG.ALERTS_TOKEN)}`;
    const payload = buildAlertPayload({ identIcao: flightnoIcao, startYmd: departureDate, targetUrl });

    const resp = await postAeroAlert(payload);
    if (!resp.ok) {
      if (CFG.DEBUG_LOG) console.error('AeroAPI /alerts failed:', resp.status, resp.raw);
      return res.status(200).json({ ok: false, message: `Provider error (${resp.status})` });
    }

    return res.status(200).json({
      ok: true,
      status: 'subscribed',
      flightno_icao: flightnoIcao,
      flightno_iata: flightnoIata,
      message: 'Subscription confirmed. You will receive alerts 1, 3, and 5 minutes before departure.'
    });
  } catch (e) {
    console.error('subscribe error:', e);
    return res.status(200).json({ ok: false, message: 'Internal error' });
  }
});

/************************************************************
 * === SERVER START ===
 ************************************************************/
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
