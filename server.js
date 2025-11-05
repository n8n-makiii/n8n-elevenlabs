// server.js
// Twilio <-> ElevenLabs bridge (stable + keep-alive + robust WS dialer)

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();

// tiny request logger
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ----- ENV -----
const PORT = process.env.PORT || 10000;
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || '').trim();
const ELEVENLABS_AGENT_ID = (process.env.ELEVENLABS_AGENT_ID || '').trim();
const ELEVENLABS_REALTIME_URL = (process.env.ELEVENLABS_REALTIME_URL || '').trim();

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.warn('[WARN] Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID. Upstream will fail until set.');
}

// ----- HEALTH ROUTES -----
app.get('/', (_req, res) => res.status(200).send('Bridge is running ✅'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/twilio-media', (_req, res) => res.status(200).send('WS endpoint mounted ✅'));

// ----- DIAGNOSTIC ROUTE (check ElevenLabs auth) -----
app.get('/diag/elevenlabs-agent', async (_req, res) => {
  try {
    const agentId = ELEVENLABS_AGENT_ID;
    const apiKey  = ELEVENLABS_API_KEY;
    if (!agentId || !apiKey) return res.status(400).json({ error: 'ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY missing' });

    const url = `https://api.elevenlabs.io/v1/convai/agents/${agentId}`;
    const r = await fetch(url, { headers: { 'xi-api-key': apiKey } });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    res.status(r.status).json({ status: r.status, body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Inspect what the app is actually using (no secrets)
app.get('/diag/env', (_req, res) => {
  res.json({
    ELEVENLABS_REALTIME_URL,
    ELEVENLABS_AGENT_ID: ELEVENLABS_AGENT_ID ? `${ELEVENLABS_AGENT_ID.slice(0, 10)}…` : null,
    has_API_KEY: !!ELEVENLABS_API_KEY,
  });
});

// ----- HTTP SERVER -----
const server = http.createServer(app);
server.keepAliveTimeout = 120000;
server.headersTimeout  = 125000;
server.requestTimeout  = 0;

// ----- WS SERVER (Twilio connects here) -----
const wss = new WebSocket.Server({ server, path: '/twilio-media' });
const PING_INTERVAL_MS = 20000;

function attachKeepAlive(ws, label) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { ws.isAlive = false; });
  console.log(`[KA] keep-alive armed for ${label}`);
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.log('[KA] terminating dead Twilio ws');
      try { ws.terminate(); } catch (_) {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, PING_INTERVAL_MS);

function attachUpstreamKeepAlive(upstream) {
  upstream.isAlive = true;
  upstream.on('pong', () => (upstream.isAlive = true));
  const iv = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.ping(); } catch (_) {}
    }
  }, PING_INTERVAL_MS);
  upstream.on('close', () => clearInterval(iv));
}

const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Dial the Agents WS robustly:
 * - prefer ELEVENLABS_REALTIME_URL if provided
 * - otherwise try global → us → eu hosts on /v1/convai/conversation
 * - try both header styles (xi-api-key and Authorization Bearer)
 */
async function dialElevenLabsWS() {
  const agentId = ELEVENLABS_AGENT_ID;
  const key     = ELEVENLABS_API_KEY;

  const candidates = [];

  // 1) if user supplied a URL, try it first
  if (ELEVENLABS_REALTIME_URL) {
    candidates.push(ELEVENLABS_REALTIME_URL);
  }

  // 2) standard agents WS endpoints (conversation)
  const baseHosts = [
    'wss://api.elevenlabs.io',
    'wss://api.us.elevenlabs.io',
    'wss://api.eu.elevenlabs.io',
  ];
  for (const host of baseHosts) {
    candidates.push(`${host}/v1/convai/conversation`);
  }

  const headerModes = [
    { name: 'xi-api-key', headers: { 'xi-api-key': key } },
    { name: 'bearer',     headers: { 'Authorization': `Bearer ${key}` } },
  ];

  const failures = [];

  for (const base of candidates) {
    // build URL with agent_id
    const qp = new URLSearchParams({ agent_id: agentId });
    const url = `${base}?${qp.toString()}`;

    for (const mode of headerModes) {
      console.log(`[EL] Trying ${url} with header mode: ${mode.name}`);

      try {
        const ws = new WebSocket(url, { headers: mode.headers });

        await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('timeout')), 8000);

          ws.once('open', () => {
            clearTimeout(to);
            console.log('[EL] Connected with', base, 'mode', mode.name);
            resolve(null);
          });

          ws.once('unexpected-response', (_req, res) => {
            clearTimeout(to);
            const st = res && res.statusCode;
            const sm = res && res.statusMessage;
            failures.push({ url, mode: mode.name, status: st, statusMessage: sm });
            try { ws.close(); } catch (_) {}
            reject(new Error(`unexpected-response ${st} ${sm}`));
          });

          ws.once('error', (err) => {
            clearTimeout(to);
            failures.push({ url, mode: mode.name, error: err.message });
            reject(err);
          });
        });

        return { ws, url, mode: mode.name }; // success
      } catch (e) {
        // continue to next candidate
      }
    }
  }

  console.error('[EL] All dial attempts failed:', failures);
  throw new Error('All ElevenLabs WS dial attempts failed');
}

// ----- MAIN WS HANDLER -----
wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  attachKeepAlive(twilioWS, 'twilio');

  let elWS = null;
  let streamSid = null;

  async function connectUpstream() {
    if (elWS && (elWS.readyState === WebSocket.OPEN || elWS.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      const { ws, url, mode } = await dialElevenLabsWS();
      elWS = ws;
      attachUpstreamKeepAlive(elWS);
      // pipe upstream close/error logs
      elWS.on('close', (code, reason) => console.log(`[EL] Closed ${code} ${reason || ''}`.trim()));
      elWS.on('error', (err) => console.error('[EL] Error:', err.message));
      console.log('[EL] Upstream established ✅ via', url, 'using', mode);
    } catch (e) {
      console.error('[EL] Failed to connect upstream:', e.message);
    }
  }

  // ----- Twilio messages -----
  twilioWS.on('message', (raw) => {
    const msg = raw.toString();
    const parsed = safeJSON(msg);
    if (!parsed || !parsed.event) return;

    switch (parsed.event) {
      case 'start':
        streamSid = parsed.start?.streamSid || 'unknown';
        console.log(`[Twilio] stream started: ${streamSid}`);
        connectUpstream();
        break;

      case 'media':
        // (Place audio forwarding here if/when you implement it)
        break;

      case 'stop':
        console.log(`[Twilio] stream stopped: ${streamSid}`);
        streamSid = null;
        if (elWS && elWS.readyState === WebSocket.OPEN) {
          try { elWS.close(1000, 'twilio stop'); } catch (_) {}
        }
        elWS = null;
        break;

      default:
        break;
    }
  });

  twilioWS.on('close', (code, reason) => {
    console.log(`[Twilio] WS closed ${code} ${reason || ''}`.trim());
    if (elWS && elWS.readyState === WebSocket.OPEN) {
      try { elWS.close(1000, 'twilio disconnect'); } catch (_) {}
    }
    elWS = null;
  });

  twilioWS.on('error', (err) => console.error('[Twilio] WS error:', err.message));
});

// ----- START -----
server.listen(PORT, () => {
  console.log(`Bridge live on port ${PORT}`);
  console.log(`Health: GET /  | WS path: /twilio-media`);
});

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
