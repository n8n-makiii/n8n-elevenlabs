// server.js
// Twilio <-> ElevenLabs bridge (stable version)

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();

// Simple logger
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
  console.warn('[WARN] Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID.');
}

// ----- HEALTH ROUTES -----
app.get('/', (_req, res) => res.status(200).send('Bridge is running ✅'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

// ----- HTTP SERVER -----
const server = http.createServer(app);
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 0;

// ----- WEBSOCKET -----
const wss = new WebSocket.Server({ server, path: '/twilio-media' });

wss.on('connection', (twilioWS, req) => {
  console.log('[Twilio] Connected from', req.socket.remoteAddress);

  let elWS = null;
  const url = `${ELEVENLABS_REALTIME_URL}?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}`;

  elWS = new WebSocket(url, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY },
  });

  elWS.on('open', () => console.log('[EL] Connected to ElevenLabs'));
  elWS.on('close', () => console.log('[EL] Connection closed'));
  elWS.on('error', (err) => console.error('[EL] Error:', err.message));

  twilioWS.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.event === 'start') console.log('[Twilio] Stream started');
      if (parsed.event === 'stop') console.log('[Twilio] Stream stopped');
    } catch (_) {}
  });

  twilioWS.on('close', () => {
    console.log('[Twilio] Closed connection');
    if (elWS && elWS.readyState === WebSocket.OPEN) elWS.close();
  });
});

// ----- START -----
server.listen(PORT, () => {
  console.log(`Bridge live on port ${PORT}`);
  console.log(`Health: GET / | WS path: /twilio-media`);
});
