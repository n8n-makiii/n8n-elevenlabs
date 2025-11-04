// server.js
// Twilio <-> ElevenLabs bridge (stable + keep-alive)

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
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_REALTIME_URL =
  process.env.ELEVENLABS_REALTIME_URL || 'wss://api.elevenlabs.io/v1/convai/stream';

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.warn(
    '[WARN] Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID. ' +
      'Upstream connection will fail until set.'
  );
}

// ----- HEALTH ROUTES -----
app.get('/', (_req, res) => res.status(200).send('Bridge is running ✅'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/twilio-media', (_req, res) => res.status(200).send('WS endpoint mounted ✅'));

// ----- HTTP SERVER -----
const server = http.createServer(app);

// keep the HTTP proxy happy
server.keepAliveTimeout = 120000; // 120s
server.headersTimeout  = 125000;  // must be > keepAliveTimeout
server.requestTimeout  = 0;       // disable per-request timeout

// ----- WS SERVER (Twilio connects here) -----
const wss = new WebSocket.Server({ server, path: '/twilio-media' });

// Keep-alive (ping/pong) settings
const PING_INTERVAL_MS = 20000;

// Attach ping/pong to any WebSocket
function attachKeepAlive(ws, label) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { ws.isAlive = false; });
  console.log(`[KA] keep-alive armed for ${label}`);
}

// Sweep all Twilio connections every PING_INTERVAL_MS
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

// Attach ping/pong to upstream (ElevenLabs) sockets
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

// Helper: safe JSON parse
const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ----- MAIN WS HANDLER -----
wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  attachKeepAlive(twilioWS, 'twilio');

  let elWS = null;
  let streamSid = null;

  function connectUpstream() {
    if (elWS && (elWS.readyState === WebSocket.OPEN || elWS.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const url = `${ELEVENLABS_REALTIME_URL}?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}`;
    elWS = new WebSocket(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });

    elWS.on('open', () => console.log('[EL] Connected to ElevenLabs'));
    elWS.on('close', (code, reason) => {
      console.log(`[EL] Closed ${code} ${reason || ''}`.trim());
    });
    elWS.on('error', (err) => console.error('[EL] Error:', err.message));
    attachUpstreamKeepAlive(elWS);
  }

  // Twilio messages
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
        // Here you can forward audio to EL if you already convert mulaw->PCM and speak the right protocol.
        // This template only keeps the sockets alive.
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

// Optional global guards (nice-to-have)
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
