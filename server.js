/**
 * Mini Gateway — stateless minimal AI gateway.
 *
 * Request in -> AI output out -> done. No database, no state, no snapshots.
 * OpenAI-compatible: GET /v1/models, POST /v1/chat/completions.
 *
 * Routing (in order):
 *  1. Full OmniRoute gateway (all 478 models) — proxied with the same key.
 *     If it 503s (Render memory pressure), seamlessly falls through to:
 *  2. Gemini (when GEMINI_KEY is set) — high-quality free tier.
 *  3. Pollinations (keyless) — always-available fallback.
 *
 * Env:
 *   API_KEY     - the Bearer key clients must send
 *   UPSTREAM    - full gateway URL, e.g. https://omniroute-boot.onrender.com
 *   GEMINI_KEY  - optional; enables Gemini backend
 *   PORT        - set by Render automatically
 */
const http = require("http");

// API_KEY is stored base64-encoded in the env to avoid paste mangling.
const API_KEY = Buffer.from((process.env.API_KEY || "").trim(), "base64").toString("utf8").trim();
const UPSTREAM = (process.env.UPSTREAM || "https://omniroute-boot.onrender.com").replace(/\/$/, "");
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const PORT = parseInt(process.env.PORT || "3000", 10);

// ---------- backends ----------

async function upstreamChat(key, model, messages, maxTokens) {
  const r = await fetch(UPSTREAM + "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens || 2000, stream: false }),
  });
  if (r.status === 503) {
    const t = await r.text();
    throw new Error("upstream_unavailable: " + t.slice(0, 100));
  }
  if (!r.ok) throw new Error("upstream HTTP " + r.status);
  const d = await r.json();
  const c = d.choices?.[0] || {};
  return {
    text: c.message?.content || "",
    model: d.model || model,
    promptTokens: d.usage?.prompt_tokens || 0,
    completionTokens: d.usage?.completion_tokens || 0,
  };
}

async function pollinationsChat(messages, maxTokens) {
  const r = await fetch("https://text.pollinations.ai/openai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai", messages, max_tokens: maxTokens || 2000 }),
  });
  if (!r.ok) throw new Error("pollinations HTTP " + r.status);
  const d = await r.json();
  return {
    text: d.choices?.[0]?.message?.content || "",
    model: "pollinations/openai",
    promptTokens: 0,
    completionTokens: 0,
  };
}

async function geminiChat(model, messages, maxTokens) {
  const geminiModel = model === "auto" ? "gemini-2.0-flash" : String(model).replace(/^gemini\//, "");
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (maxTokens) body.generationConfig = { maxOutputTokens: maxTokens };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!r.ok) throw new Error("gemini HTTP " + r.status);
  const d = await r.json();
  const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  const u = d.usageMetadata || {};
  return {
    text,
    model: "gemini/" + geminiModel,
    promptTokens: u.promptTokenCount || 0,
    completionTokens: u.candidatesTokenCount || 0,
  };
}

async function routeChat(clientKey, model, messages, maxTokens) {
  const errors = [];
  // 1. Full gateway (all models)
  try {
    return await upstreamChat(clientKey, model, messages, maxTokens);
  } catch (e) {
    errors.push("upstream: " + e.message);
    console.error("[route]", e.message);
  }
  // 2. Gemini (if configured)
  if (GEMINI_KEY) {
    try {
      return await geminiChat(model, messages, maxTokens);
    } catch (e) {
      errors.push("gemini: " + e.message);
      console.error("[route]", e.message);
    }
  }
  // 3. Pollinations (always available)
  try {
    return await pollinationsChat(messages, maxTokens);
  } catch (e) {
    errors.push("pollinations: " + e.message);
  }
  throw new Error(errors.join(" | "));
}

async function upstreamModels(clientKey) {
  try {
    const r = await fetch(UPSTREAM + "/v1/models", {
      headers: { Authorization: "Bearer " + clientKey },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    return null;
  }
}

// ---------- http ----------

function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!API_KEY) return true;
  return (req.headers.authorization || "").trim() === "Bearer " + API_KEY;
}

function clientKey(req) {
  return ((req.headers.authorization || "").trim().replace(/^Bearer\s+/i, ""));
}

const FALLBACK_MODELS = [
  { id: "auto", owned_by: "mini-gateway" },
  { id: "gemini-2.0-flash", owned_by: "mini-gateway" },
  { id: "pollinations-openai", owned_by: "mini-gateway" },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  if (url.pathname === "/api/health" || url.pathname === "/healthz") {
    return send(res, 200, {
      status: "ok",
      upstream: UPSTREAM,
      backends: ["upstream", ...(GEMINI_KEY ? ["gemini"] : []), "pollinations"],
    });
  }

  if (!authorized(req)) {
    return send(res, 401, { error: { message: "Invalid API key", code: "invalid_api_key" } });
  }
  const key = clientKey(req);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const up = await upstreamModels(key);
    if (up) return send(res, 200, up);
    return send(res, 200, { object: "list", data: FALLBACK_MODELS });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    try {
      const body = await readBody(req);
      const { text, model, promptTokens, completionTokens } = await routeChat(
        key,
        body.model || "auto",
        body.messages || [],
        body.max_tokens
      );
      return send(res, 200, {
        id: "chatcmpl-mini-" + Date.now().toString(36),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    } catch (e) {
      console.error("[chat] all backends failed:", e.message);
      return send(res, 502, { error: { message: "All backends failed: " + e.message } });
    }
  }

  return send(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, () => console.log("[mini-gateway] listening on " + PORT));
