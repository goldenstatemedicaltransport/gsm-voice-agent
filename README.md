# Golden State Medical Transport Voice AI Agent

This project implements a full stack prototype of a voice assistant for Golden State Medical Transport (GSMT).  It uses Twilio to accept phone calls and stream the caller's audio over a WebSocket, an LLM (e.g. OpenAI's ChatGPT) to understand and generate responses, and Amazon Polly to synthesize natural speech for the agent's replies.  The server is designed to run on [Google Cloud Run](https://cloud.google.com/run), which scales automatically based on demand.

> **Important:** The code in this repository is a working skeleton meant to illustrate the major components of the system.  To deploy a production assistant you will need to fill in the stubbed functions for speech‑to‑text (`transcribeAudio`) and LLM calls (`generateLLMReply`), handle error cases, and tune the system prompt to match your business workflows.  The audio conversion functions included here provide a basic μ‑law/PCM bridge; you may want to use a more robust audio processing library (such as SoX or ffmpeg) in production.

## Prerequisites

1. **Twilio account & phone number** with Programmable Voice enabled.  You will configure the phone number's voice webhook to point at your Cloud Run service.
2. **AWS credentials** with permission to call Amazon Polly.  You can supply these via environment variables (e.g. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) or by configuring an IAM role for Cloud Run.  Set `AWS_REGION` and `AWS_POLLY_VOICE` accordingly.
3. **OpenAI API key** if you plan to use ChatGPT (or any other OpenAI LLM) for generating responses.  Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in your environment.  The code defaults to `gpt-3.5-turbo`.
4. **Google Cloud project** with Cloud Run enabled.  You'll containerise this application and deploy it here.
5. **Node.js** installed locally if you wish to run or test the service outside of Cloud Run.

## Installation and Local Testing

```bash
git clone https://github.com/your‑account/gsm-t-voice-agent.git
cd gsm-t-voice-agent
npm install

# Define environment variables.  You can also create a `.env` file and
# use dotenv to load variables automatically.
export PORT=8080
export BASE_URL=http://localhost:8080
export AWS_REGION=us-west-2
export AWS_POLLY_VOICE=Joanna
export TWILIO_AUTH_TOKEN=your_twilio_auth_token
export OPENAI_API_KEY=your_openai_api_key
export OPENAI_MODEL=gpt-3.5-turbo # or gpt-4 if available
export SYSTEM_PROMPT="You are Golden State Medical Transport’s voice agent. Speak concisely, warm and professional..."

npm start
# Visit http://localhost:8080/voice to see the TwiML response
```

To test end‑to‑end with Twilio, you can use the [TwiML Bins](https://www.twilio.com/docs/voice/twiml-bins) or [ngrok](https://ngrok.com/) to expose your local server and point your Twilio phone number's voice webhook to `https://<ngrok-id>.ngrok.io/voice`.  Calls to your number will be routed to your local process.

## Dockerfile

Deploying to Cloud Run requires containerising the service.  Below is a simple `Dockerfile` you can use:

```dockerfile
FROM node:18-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production
COPY . .
ENV PORT=8080
CMD ["npm", "start"]
```

Build and test locally:

```bash
docker build -t gsm-t-voice-agent .
docker run -p 8080:8080 \
  -e PORT=8080 \
  -e BASE_URL=http://localhost:8080 \
  -e AWS_REGION=us-west-2 -e AWS_POLLY_VOICE=Joanna \
  -e TWILIO_AUTH_TOKEN=your_twilio_auth_token \
  -e OPENAI_API_KEY=your_openai_api_key \
  gsm-t-voice-agent
```

## Deploying to Cloud Run

1. Create a new Cloud Run service in your Google Cloud project.
2. Store your secrets in [Secret Manager](https://cloud.google.com/secret-manager) and mount them as environment variables in the Cloud Run service.  At minimum you'll need `TWILIO_AUTH_TOKEN`, `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_POLLY_VOICE` and `BASE_URL` (set to your Cloud Run URL once deployed).
3. Build your container and push it to Google Artifact Registry:

   ```bash
   # From the voice-agent directory
   gcloud builds submit --tag gcr.io/your-project/gsm-t-voice-agent:latest
   ```

4. Deploy the service:

   ```bash
   gcloud run deploy gsm-t-voice-agent \
     --image gcr.io/your-project/gsm-t-voice-agent:latest \
     --platform managed \
     --allow-unauthenticated \
     --region us-west1 \
     --set-env-vars=BASE_URL=https://gsm-t-voice-agent-<hash>-uc.a.run.app \
     --update-secrets=TWILIO_AUTH_TOKEN=projects/your-project/secrets/TWILIO_AUTH_TOKEN:latest,OPENAI_API_KEY=projects/your-project/secrets/OPENAI_API_KEY:latest,AWS_ACCESS_KEY_ID=projects/your-project/secrets/AWS_ACCESS_KEY_ID:latest,AWS_SECRET_ACCESS_KEY=projects/your-project/secrets/AWS_SECRET_ACCESS_KEY:latest,AWS_REGION=projects/your-project/secrets/AWS_REGION:latest,AWS_POLLY_VOICE=projects/your-project/secrets/AWS_POLLY_VOICE:latest
   ```

   Replace `gsm-t-voice-agent-<hash>-uc.a.run.app` with the actual URL printed after deployment.

5. Update the `BASE_URL` secret to match your Cloud Run URL.  This is used to build the WebSocket URL returned to Twilio.

## Configuring Twilio

1. In the Twilio Console, navigate to **Phone Numbers ➜ Manage ➜ Active Numbers** and select your GSMT number.
2. Under **Voice & Fax**, set the **A CALL COMES IN** webhook to your Cloud Run `/voice` endpoint (e.g. `https://gsm-t-voice-agent-<hash>-uc.a.run.app/voice`).  Choose **HTTP POST**.
3. Save your changes.

When a call comes in, Twilio will fetch `/voice` to retrieve TwiML.  TwiML instructs Twilio to greet the caller and connect to the `/stream` WebSocket endpoint.  Twilio will then stream the caller's audio in real time.  The server listens for `media` messages, transcribes them, generates an LLM reply and synthesises a spoken response via Amazon Polly.  The agent uses the `clear` event to interrupt any previously queued audio when the caller speaks.

## Extending the Prototype

- **Speech‑to‑text:** Replace the stub `transcribeAudio` function with a call to your preferred STT service.  Many developers use Google Cloud Speech or OpenAI Whisper for low‑latency streaming transcription.
- **LLM integration:** Replace the stub `generateLLMReply` with a call to OpenAI's chat completions API (or another LLM provider).  Include a system prompt tailored to your business (pricing rules, scheduling logic, etc.).  Consider using the function calling capabilities of modern LLMs to trigger structured actions (e.g. create a booking, fetch an ETA) rather than generating free‑form text.
- **Audio processing:** For production use, incorporate a proper audio converter (e.g. `ffmpeg` or the ["twilio-media-converter"](https://github.com/twilio-labs/twilio-media-streams-demo)) to handle μ‑law/PCM conversion and resampling without aliasing.
- **Security:** Validate Twilio signatures (already implemented), secure your WebSocket endpoint, and handle authentication/authorisation for any backend APIs.
- **Observability:** Instrument the service with structured logging (e.g. using [Winston](https://github.com/winstonjs/winston)), metrics and distributed tracing.  Store call transcripts securely only if you have the caller's consent and handle protected health information (PHI) in compliance with HIPAA.

## License

This project is provided under the MIT license.  See `LICENSE` for details.