/*
 * Main entry point for the Golden State Medical Transport voice AI agent.  This
 * server is designed to be deployed on Google Cloud Run and is responsible
 * for handling incoming Twilio Voice webhooks, negotiating a WebSocket
 * connection for real‑time audio streaming and orchestrating speech‑to‑text,
 * large language model responses and text‑to‑speech synthesis.  It uses
 * Express for HTTP routing and the `ws` library for WebSocket support.
 *
 * The code intentionally includes stubbed functions for speech‑to‑text and
 * OpenAI calls.  You should fill in these functions with calls to your
 * chosen STT service (e.g. Google Cloud Speech or OpenAI Whisper) and
 * OpenAI's chat API.  Similarly, the Amazon Polly integration is
 * implemented here using the AWS SDK; be sure to configure your AWS
 * credentials and region via environment variables or IAM roles when
 * deploying this service.
 */

const express = require('express');
const twilio = require('twilio');
const WebSocket = require('ws');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const axios = require('axios');
const http = require('http');
const url = require('url');

// Environment variables: configure these in your deployment environment
const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || 'https://your-cloud-run-url';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Google Speech‑to‑Text API key.  If provided, the transcribeAudio() function
// will send caller audio to the Google Speech API for transcription.  Using
// Google STT avoids the need to build a local mu‑law → wav converter and
// supports μ‑law audio directly.  Set GOOGLE_SPEECH_API_KEY in your
// environment (for example via Cloud Run secret) to enable STT.
const GOOGLE_SPEECH_API_KEY = process.env.GOOGLE_SPEECH_API_KEY || '';
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const AWS_POLLY_VOICE = process.env.AWS_POLLY_VOICE || 'Joanna';

// Create AWS Polly client
const pollyClient = new PollyClient({ region: AWS_REGION });

// Create Express app and underlying HTTP server
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const server = http.createServer(app);

// Create a WebSocket server and attach it to the HTTP server.  We do not
// expose this directly through Express; instead we handle WebSocket upgrade
// requests on the same HTTP port.  Twilio will connect to `/stream` over
// WebSocket.
const wss = new WebSocket.Server({ noServer: true });

// Active connections keyed by callSid.  Each call gets its own WebSocket.
const connections = {};

/*
 * Utility: verify that an incoming HTTP request is legitimately from
 * Twilio.  Twilio signs webhook requests using your account's auth token.
 */
function verifyTwilioRequest(req) {
  const twilioSignature = req.headers['x-twilio-signature'];
  const validator = new twilio.webhook.WebhookSignatureValidator(TWILIO_AUTH_TOKEN);
  const urlToCheck = BASE_URL + req.originalUrl;
  return validator.validate(urlToCheck, req.body, twilioSignature);
}

/*
 * Endpoint for Twilio voice webhook.  When a call comes in, Twilio will
 * request this endpoint via HTTP POST.  We respond with TwiML instructing
 * Twilio to connect the call to our WebSocket endpoint for bi‑directional
 * audio streaming.  You can optionally greet the caller with a short
 * message using Twilio's built‑in Polly voice support (the <Say> verb).
 */
app.post('/voice', (req, res) => {
  // Validate that the request came from Twilio when deployed.
  if (TWILIO_AUTH_TOKEN && !verifyTwilioRequest(req)) {
    console.error('Request did not pass Twilio signature validation');
    return res.status(403).send('Forbidden');
  }

  // Use Twilio helper to build TwiML response
  const twiml = new twilio.twiml.VoiceResponse();

  // Play an initial greeting using Twilio's built‑in Polly voice.  The
  // "Polly." prefix instructs Twilio to use Amazon Polly Neural voices.
  twiml.say({ voice: `Polly.${AWS_POLLY_VOICE}-Neural` }, 'Hello. You are speaking with the Golden State Medical Transport virtual assistant.');

  // Ask Twilio to open a WebSocket connection to our /stream endpoint for
  // bi‑directional audio.  The callSid query parameter allows us to
  // associate the WebSocket with the current call.
  twiml.connect().stream({ url: `${BASE_URL.replace(/\/$/, '')}/stream?callSid=${req.body.CallSid}` });

  // Return TwiML
  res.type('text/xml');
  res.send(twiml.toString());
});

/*
 * Upgrade handler.  This tells the HTTP server to upgrade incoming
 * connections that request /stream to our WebSocket server.  We parse
 * the callSid from the query string and store the WebSocket in our
 * connections map for easy access.
 */
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  if (pathname === '/stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

/*
 * Handle a new WebSocket connection from Twilio.  A callSid query
 * parameter identifies the call; we'll store the WebSocket under that key.
 */
wss.on('connection', (ws, req) => {
  const params = new url.URL(req.url, 'http://localhost').searchParams;
  const callSid = params.get('callSid');
  if (!callSid) {
    ws.close();
    return;
  }
  console.log(`New WebSocket connection for call ${callSid}`);
  connections[callSid] = ws;

  ws.on('message', async (data) => {
    // Twilio sends JSON messages with an event field.  We need to
    // differentiate media messages from pings, marks, etc.
    let message;
    try {
      message = JSON.parse(data);
    } catch (err) {
      console.error('Failed to parse WebSocket message', err);
      return;
    }
    if (message.event === 'media') {
      await handleMediaMessage(callSid, message);
    } else if (message.event === 'closed') {
      console.log(`Call ${callSid} WebSocket closed by Twilio`);
      ws.close();
      delete connections[callSid];
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket closed for call ${callSid}`);
    delete connections[callSid];
  });
});

/*
 * Process an incoming audio media message from Twilio.  The message
 * contains a base64‑encoded audio payload (typically 8 kHz μ‑law).
 * This function decodes the audio, calls a speech‑to‑text service,
 * sends the transcript to the LLM and synthesizes the response via
 * Amazon Polly.  The synthesized audio is then streamed back to
 * Twilio over the WebSocket.
 */
async function handleMediaMessage(callSid, message) {
  const payload = message.media && message.media.payload;
  if (!payload) return;
  const ws = connections[callSid];
  if (!ws) return;

  // Decode base64 payload to a Buffer containing μ‑law audio.  In a
  // production implementation you should convert this to linear PCM
  // before sending it to your speech‑to‑text service.
  const audioBuffer = Buffer.from(payload, 'base64');

  // TODO: convert μ‑law to PCM.  For demonstration purposes we pass
  // the raw buffer directly.  Replace this with proper conversion.
  const transcript = await transcribeAudio(audioBuffer);
  if (!transcript) {
    return;
  }
  console.log(`Transcript: ${transcript}`);
  const reply = await generateLLMReply(transcript, callSid);
  console.log(`LLM reply: ${reply}`);
  const speechAudio = await synthesizeSpeech(reply);
  // Convert the PCM output from Polly to μ‑law and base64 encode it
  const muLawAudio = pcmToMuLaw(speechAudio);
  const b64 = muLawAudio.toString('base64');
  // Clear any queued audio so Twilio plays the new response
  ws.send(JSON.stringify({ event: 'clear' }));
  // Send the synthesized audio back to Twilio
  ws.send(JSON.stringify({
    event: 'media',
    media: { payload: b64 },
  }));
}

/*
 * Stub: convert μ‑law audio to linear PCM (16‑bit signed little endian).  In
 * production you should implement proper μ‑law decoding here.  Many
 * libraries exist for this (e.g. mu-law-js) but to keep this file
 * self‑contained we include a simple implementation.  The returned Buffer
 * contains 16‑bit PCM samples at 8 kHz.
 */
function muLawToPcm(muLawBuffer) {
  const PCM_MAX = 32767;
  const MU_LAW_MAX = 0x1F;
  const result = Buffer.alloc(muLawBuffer.length * 2);
  for (let i = 0; i < muLawBuffer.length; i++) {
    const c = ~muLawBuffer[i];
    let mantissa = c & 0x0F;
    let exponent = (c & 0x70) >> 4;
    let magnitude = ((mantissa << 4) + 0x08) << (exponent + 3);
    if (c & 0x80) magnitude = -magnitude;
    const sample = magnitude;
    result.writeInt16LE(sample, i * 2);
  }
  return result;
}

/*
 * Convert a PCM buffer to μ‑law.  Amazon Polly returns PCM at 16 kHz,
 * 16‑bit signed little endian.  Twilio expects 8 kHz μ‑law at 8‑bit.
 * For demonstration purposes this implementation performs a simple
 * downsample by discarding every other sample.  In production you should
 * use a proper resampler to avoid aliasing.
 */
function pcmToMuLaw(pcmBuffer) {
  // Downsample to 8 kHz by taking every second sample
  const samples = [];
  for (let i = 0; i < pcmBuffer.length; i += 4) {
    // 16‑bit sample at 16 kHz
    const sample = pcmBuffer.readInt16LE(i);
    samples.push(sample);
  }
  const muLawBuffer = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const sign = (x >> 8) & 0x80;
    let magnitude = Math.abs(x);
    if (magnitude > 32635) magnitude = 32635;
    // Convert to μ‑law
    const exponent = Math.floor(Math.log1p((magnitude) / 32) / Math.LN2);
    const mantissa = (magnitude >> (exponent + 3)) & 0x0F;
    let muLaw = ~(sign | (exponent << 4) | mantissa);
    muLawBuffer[i] = muLaw;
  }
  return muLawBuffer;
}

/*
 * Stub: send audio to a speech‑to‑text engine and return the transcript.
 * Replace this implementation with calls to your preferred STT service.
 */
async function transcribeAudio(buffer) {
  /*
   * Transcribe caller audio to text.  If a Google Speech API key is configured
   * via the environment variable GOOGLE_SPEECH_API_KEY, this function will
   * perform a synchronous recognition request against the Google Speech API
   * using the μ‑law encoded audio from Twilio.  If no API key is set the
   * function returns an empty string which will cause the assistant to echo
   * the caller's utterance via fallback logic in generateLLMReply().
   */
  if (!GOOGLE_SPEECH_API_KEY) {
    console.warn('No Google Speech API key configured; skipping STT');
    return '';
  }
  try {
    // The Twilio media payload is 8‑bit μ‑law at 8 kHz.  Google Speech API
    // accepts μ‑law directly when specified in the config.  Encode the raw
    // audio buffer to base64 for transmission in the JSON request.
    const audioContent = buffer.toString('base64');
    const requestBody = {
      config: {
        encoding: 'MULAW',
        sampleRateHertz: 8000,
        languageCode: 'en-US'
      },
      audio: {
        content: audioContent
      }
    };
    const url = `https://speech.googleapis.com/v1/speech:recognize?key=${GOOGLE_SPEECH_API_KEY}`;
    const response = await axios.post(url, requestBody);
    const results = response.data.results || [];
    if (results.length > 0 && results[0].alternatives && results[0].alternatives.length > 0) {
      return results[0].alternatives[0].transcript || '';
    }
    return '';
  } catch (err) {
    console.error('Error calling Google Speech API:', err.response ? err.response.data : err.message);
    return '';
  }
}

/*
 * Stub: send the transcript to an LLM and return a reply.  Replace this
 * implementation with calls to OpenAI's Chat API.  You can include the
 * system prompt from your design here to shape the assistant's behavior.
 */
/**
 * Maintain per‑call conversation history in memory.  Each key is a callSid
 * and maps to an array of OpenAI chat messages.  When a new transcript
 * arrives we append the user's utterance and ask ChatGPT for a reply.
 */
const conversationHistory = {};

/**
 * Generate a reply from OpenAI Chat completions API.  The function
 * constructs a messages array containing the system prompt (loaded from
 * the environment variable SYSTEM_PROMPT or a default), followed by
 * the prior conversation history for the call.  The new transcript is
 * appended as a user message.  The assistant's reply is appended to
 * the history and returned to the caller.
 *
 * @param {string} transcript The latest utterance from the caller
 * @param {string} callSid A unique identifier for the call (maps to a conversation)
 */
async function generateLLMReply(transcript, callSid) {
  if (!transcript || transcript.trim().length === 0) {
    return '';
  }
  const systemPrompt = process.env.SYSTEM_PROMPT ||
    'You are Golden State Medical Transport’s voice agent. Speak concisely, warm and professional. You can: quote wheelchair/gurney trips, schedule pickups, check driver ETA, and send GPS links. Always confirm patient name, pickup/drop-off, date/time, mobility type, oxygen needs, weight, and stairs. If authorizations are required (Prospect/Astrana/Regal), gather member ID and case manager contact. If uncertain, politely ask clarifying questions or transfer to a human dispatcher. Comply with two‑party consent laws for recordings.';

  // Initialise conversation history for this call if it doesn't exist
  if (!conversationHistory[callSid]) {
    conversationHistory[callSid] = [];
  }
  // Build the messages array for OpenAI
  const messages = [];
  messages.push({ role: 'system', content: systemPrompt });
  // Append previous messages
  for (const m of conversationHistory[callSid]) {
    messages.push(m);
  }
  // Append the new user message
  messages.push({ role: 'user', content: transcript });

  try {
    const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        messages,
        temperature: 0.5,
        max_tokens: 200,
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const replyContent = response.data.choices[0].message.content.trim();
    // Save the assistant reply to the history
    conversationHistory[callSid].push({ role: 'user', content: transcript });
    conversationHistory[callSid].push({ role: 'assistant', content: replyContent });
    return replyContent;
  } catch (err) {
    console.error('Error calling OpenAI API:', err.response ? err.response.data : err.message);
    // Fall back to echo if something goes wrong
    return `You said: ${transcript}`;
  }
}

/*
 * Use Amazon Polly to synthesize speech from a string.  Returns a Buffer of
 * linear PCM audio at 16 kHz.  Polly voices are configured via
 * AWS_POLLY_VOICE.  Note that Polly returns audio at the requested
 * sample rate, which must then be downsampled to 8 kHz for Twilio.
 */
async function synthesizeSpeech(text) {
  if (!text) return Buffer.alloc(0);
  const input = {
    OutputFormat: 'pcm',
    SampleRate: '16000',
    Text: text,
    TextType: 'text',
    VoiceId: AWS_POLLY_VOICE,
  };
  const command = new SynthesizeSpeechCommand(input);
  const response = await pollyClient.send(command);
  // response.AudioStream is a readable stream; accumulate into a Buffer
  const chunks = [];
  for await (const chunk of response.AudioStream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Start the server
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});