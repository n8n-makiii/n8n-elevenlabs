import 'dotenv/config';
import express from 'express';
import expressWs from 'express-ws';
import WebSocket from 'ws';

const PORT = process.env.PORT || 10000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_REALTIME_URL =
  process.env.ELEVENLABS_REALTIME_URL || 'wss://api.elevenlabs.io/v1/convai/stream';

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID env vars.');
  process.exit(1);
}

const app = express();
expressWs(app);

app.get('/', (req, res) => res.status(200).send('OK'));

// Twilio WS connection handler
app.ws('/twilio-media', async (twilioWs, req) => {
  console.log('Twilio connected:', req.query);

  const elWs = new WebSocket(ELEVENLABS_REALTIME_URL, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });

  let streamSid = null;
  let elevenReady = false;

  elWs.on('open', () => {
    console.log('Connected to ElevenLabs');
    elWs.send(JSON.stringify({
      type: 'session.update',
      session: { agent_id: ELEVENLABS_AGENT_ID }
    }));
  });

  elWs.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'session.updated') {
        elevenReady = true;
        console.log('ElevenLabs ready');
      }
      if (msg.type === 'audio' && msg.audio?.audio_base64 && streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.audio.audio_base64 }
        }));
      }
    } catch (e) {
      console.error('Error parsing ElevenLabs message', e);
    }
  });

  twilioWs.on('message', (raw) => {
    const data = JSON.parse(raw.toString());
    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid;
        console.log('Twilio stream started:', streamSid);
        break;
      case 'media':
        if (elevenReady && elWs.readyState === WebSocket.OPEN) {
          elWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.media.payload
          }));
        }
        break;
      case 'stop':
        console.log('Stream stopped');
        elWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        elWs.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WS closed');
    try { elWs.close(); } catch {}
  });
});

app.listen(PORT, () => console.log(`Bridge live on port ${PORT}`));
