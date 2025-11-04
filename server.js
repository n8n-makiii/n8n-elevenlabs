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

// ----- DIAGNOSTIC ROUTE (check ElevenLabs auth) -----
app.get('/diag/elevenlabs-agent', async (_req, res) => {
  try {
    const agentId = (process.env.ELEVENLABS_AGENT_ID || '').trim();
    const apiKey = (process.env.ELEVENLABS_API_KEY || '').trim();

    if (!agentId || !apiKey) {
      return res.status(400).json({
        error: 'ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY missing',
      });
    }

    const url = `https://api.elevenlabs.io/v1/convai/agents/${agentId}`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
    });

    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    res.status(r.status).json({ status: r.status, body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- HTTP SERVER -----
const server = http.createServer(app);
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 0;

// ----- WS SERVER (Twilio connects here) -----
const wss = new WebSocket.Server({ server, path: '/twilio-media' });
const PING_INTERVAL_MS = 20000;

function attachKeepAlive(ws, label) {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('close', () => {
    ws.isAlive = false;
  });
  console.log(`[KA] keep-alive armed for ${label}`);
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.log('[KA] terminating dead Twilio ws');
      try {
        ws.terminate();
      } catch (_) {}
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {}
  }
}, PING_INTERVAL_MS);

function attachUpstreamKeepAlive(upstream) {
  upstream.isAlive = true;
  upstream.on('pong', () => (upstream.isAlive = true));
  const iv = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.ping();
      } catch (_) {}
    }
  }, PING_INTERVAL_MS);
  upstream.on('close', () => clearInterval(iv));
}

const safeJSON = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ----- MAIN WS HANDLER -----
wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  attachKeepAlive(twilioWS, 'twilio');

  let elWS = null;
  let streamSid = null;

  // ✅ REPLACED connectUpstream() block
  function connectUpstream() {
    if (
      elWS &&
      (elWS.readyState === WebSocket.OPEN ||
        elWS.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const url = `${ELEVENLABS_REALTIME_URL}?agent_id=${encodeURIComponent(
      ELEVENLABS_AGENT_ID
    )}`;
    console.log('[EL] Connecting to:', url);

    elWS = new WebSocket(url, {
      headers: {
        'xi-api-key': (ELEVENLABS_API_KEY || '').trim(),
        'Origin': 'https://api.us.elevenlabs.io', // critical for auth
        'User-Agent': 'n8n-elevenlabs-bridge/1.0',
      },
    });

    // ✅ If 403 or other handshake failure happens, log status & headers
    elWS.on('unexpected-response', (_req, res) => {
      console.error('[EL] unexpected-response', res.statusCode, res.statusMessage);
      console.error('[EL] headers:', res.headers);
    });

    elWS.on('open', () => console.log('[EL] Connected to ElevenLabs'));
    elWS.on('close', (code, reason) =>
      console.log(`[EL] Closed ${code} ${reason || ''}`.trim())
    );
    elWS.on('error', (err) => console.error('[EL] Error:', err.message));

    attachUpstreamKeepAlive(elWS);
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
        break;

      case 'stop':
        console.log(`[Twilio] stream stopped: ${streamSid}`);
        streamSid = null;
        if (elWS && elWS.readyState === WebSocket.OPEN) {
          try {
            elWS.close(1000, 'twilio stop');
          } catch (_) {}
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
      try {
        elWS.close(1000, 'twilio disconnect');
      } catch (_) {}
    }
    elWS = null;
  });

  twilioWS.on('error', (err) =>
    console.error('[Twilio] WS error:', err.message)
  );
});

// ----- START -----
server.listen(PORT, () => {
  console.log(`Bridge live on port ${PORT}`);
  console.log(`Health: GET /  | WS path: /twilio-media`);
});

process.on('uncaughtException', (e) =>
  console.error('[uncaughtException]', e)
);
process.on('unhandledRejection', (r) =>
  console.error('[unhandledRejection]', r)
);
