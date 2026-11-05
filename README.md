# mini-gateway

Stateless minimal AI gateway — request in, output out, nothing saved.

No database, no state, no snapshots.

## What it does

- OpenAI-compatible: `GET /v1/models`, `POST /v1/chat/completions`
- Anthropic-compatible: `POST /v1/messages` — native proxy to the full gateway, with SSE streaming passthrough and a translated fallback

## Routing

In order:

1. Full OmniRoute gateway, proxied with the same key. If it returns 503, the request falls through to:
2. Gemini, when `GEMINI_KEY` is set.
3. Pollinations (keyless), the always-available fallback.

## Run

- Requires Node.js >= 20.
- `npm start` (runs `node server.js`).
- Listens on `PORT` (default 3000).

## Configuration

| Variable | Purpose |
| --- | --- |
| `API_KEY` | The Bearer key clients must send. Stored base64-encoded in the environment to avoid paste mangling. |
| `UPSTREAM` | Full gateway URL (default `https://omniroute-boot.onrender.com`). |
| `GEMINI_KEY` | Optional; enables the Gemini backend. |
| `PORT` | Port to listen on (default 3000; set automatically on Render). |

## Also in this repo

- `aws-setup.sh` — OmniRoute AWS EC2 (t3.micro) self-host setup: adds 2 GB swap, installs Docker, downloads the OmniRoute self-host files, locks the `.env` down (API key required, binds to 127.0.0.1), starts the stack, and waits for health on `http://127.0.0.1:20128/healthz`.
- `aws-bindfix.sh` — Rebinds OmniRoute to 0.0.0.0 so the dashboard is reachable (API key still required).

## License

MIT — see [LICENSE](LICENSE).
