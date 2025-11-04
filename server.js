// server.js
// Hardened Twilio <-> ElevenLabs bridge with WS keep-alive + health checks

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

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

// ----- HEALTH ROUTES (HTTP) -----
app.get('/', (_req, res) => res.status(200).send('Render bridge is running ✅'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/twilio-media', (_req, res) =>
  res.status(200).send('WS endpoint is mounted ✅')
);

// ----- HTTP SERVER -----
const server = http.createServer(app);

// Loosen HTTP timeouts so proxy doesn’t cut us early
server.keepAliveTimeout = 120000; // 120s
server.headersTimeout = 125000;   // must be > keepAliveTimeout
server.requestTimeout = 0;        // disable per-request timeout

// ----- WS SERVER (Twilio connects here) -----
const wss = new WebSocket.Server({ server, path: '/twilio-media' });

// ping/pong keep-alive for Twilio <-> bridge sockets
const PING_INTERVAL_MS = 20000;

function attachKeepAlive(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, PING_INTERVAL_MS);

// Attach ping to upstream (ElevenLabs) sockets as well
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

// Helpers (optional logging)
const safeJSON = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

// ----- MAIN WS HANDLER -----
wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] WS connected from', req.socket.remoteAddress);
  attachKeepAlive(twilioWS);

  let streamSid = null;
  let elWS = null; // ElevenLabs upstream socket

  // When we get the Twilio "start" event, connect to ElevenLabs
  const connectUpstream = () => {
    if (elWS && (elWS.readyState === WebSocket.OPEN || elWS.readyState === WebSocket.CONNECTING))
      return;

    const url = `${ELEVENLABS_REALTIME_URL}?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}`;

    elWS = new WebSocket(url, {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      // If your Render env requires, you can set permessageDeflate: false
    });

    elWS.on('open', () => {
      console.log('[EL] Connected to ElevenLabs');
    });

    elWS.on('message', (data) => {
      // ElevenLabs Realtime may send JSON or binary audio frames depending on config.
      // If you already implemented audio forwarding back to Twilio, keep it here.
      // Example placeholder:
      // if (Buffer.isBuffer(data)) {
      //   const muLawBase64 = pcmToMuLawBase64(data); // you’d implement/keep your version
      //   if (twilioWS.readyState === WebSocket.OPEN) {
      //     twilioWS.send(
      //       JSON.stringify({ event: 'media', media: { payload: muLawBase64 } })
      //     );
      //   }
      // } else {
      //   console.log('[EL] JSON:', data.toString());
      // }
    });

    elWS.on('close', (code, reason) => {
      console.log(`[EL] Closed ${code} ${reason}`);
      elWS = null;
    });

    elWS.on('error', (err) => {
      console.error('[EL] Error:', err.message);
    });

    attachUpstreamKeepAlive(elWS);
  };

  // Incoming frames from Twilio
  twilioWS.on('message', (raw) => {
    const msg = raw.toString();
    const parsed = safeJSON(msg);

    if (!parsed || !parsed.event) {
      // Not Twilio media event; ignore or log
      return;
    }

    switch (parsed.event) {
      case 'start': {
        streamSid = parsed.start?.streamSid || 'unknown';
        console.log(`[Twilio] stream started: ${streamSid}`);
        // connect to ElevenLabs now that we know call started
        connectUpstream();
        break;
      }

      case 'media': {
        // Parsed Twilio audio inbound from callee -> forward to EL if you’ve implemented audio ingestion.
        // Twilio sends 8k μ-law, base64 in parsed.media.payload
        // To keep this template generic, we only keep the socket alive here.
        // If you already had audio-forwarding working before, keep your logic here:
        //
        // if (elWS && elWS.readyState === WebSocket.OPEN) {
        //   const pcm = muLawBase64ToPCM(Buffer.from(parsed.media.payload, 'base64'));
        //   elWS.send(pcm); // or your convai audio frame format
        // }
        break;
      }

      case 'stop': {
        console.log(`[Twilio] stream stopped: ${streamSid}`);
        streamSid = null;
        if (elWS && elWS.readyState === WebSocket.OPEN) {
          try { elWS.close(1000, 'twilio stop'); } catch (_) {}
        }
        elWS = null;
        break;
      }

      default:
        // other events (mark, dtmf, etc.)
        break;
    }
  });

  twilioWS.on('close', (code, reason) => {
    console.log(`[Twilio] WS closed ${code} ${reason}`);
    try { if (elWS && elWS.readyState === WebSocket.OPEN) elWS.close(1000, 'twilio disconnect'); } catch (_) {}
  });

  twilioWS.on('error', (err) => {
    console.error('[Twilio] WS error:', err.message);
  });
});

// ----- START -----
server.listen(PORT, () => {
  console.log(`==> Bridge live on port ${PORT}`);
  console.log(`==> Health: GET /  | WS path: /twilio-media`);
});
