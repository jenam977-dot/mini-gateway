/**
 * Mini Gateway — stateless minimal AI gateway.
 *
 * Request in -> AI output out -> done. No database, no state, no snapshots.
 * OpenAI-compatible: GET /v1/models, POST /v1/chat/completions.
 * Backend: keyless free providers (Pollinations). Add a GEMINI_KEY env var
 * later to route through Gemini instead — no code change needed.
 *
 * Env:
 *   API_KEY    - the Bearer key clients must send (e.g. the existing omr_ key)
 *   GEMINI_KEY - optional; when set, "auto"/"gemini-*" models use Gemini
 *   PORT       - set by Render automatically
 */
const http = require("http");

const API_KEY = process.env.API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_KEY || "";
const PORT = parseInt(process.env.PORT || "3000", 10);

// ---------- backends ----------

async function pollinationsChat(messages, maxTokens) {
  const r = await fetch("https://text.pollinations.ai/openai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai",
      messages,
      max_tokens: maxTokens || 2000,
    }),
  });
  if (!r.ok) throw new Error("pollinations HTTP " + r.status);
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || "";
  return { text, model: "pollinations/openai", promptTokens: 0, completionTokens: 0 };
}

async function geminiChat(messages, model, maxTokens) {
  const geminiModel =
    model === "auto" ? "gemini-2.0-flash" : model.replace(/^gemini\//, "");
  // OpenAI -> Gemini format
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (maxTokens) body.generationConfig = { maxOutputTokens: maxTokens };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error("gemini HTTP " + r.status + ": " + t.slice(0, 120));
  }
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

async function routeChat(model, messages, maxTokens) {
  const m = (model || "auto").toLowerCase();
  // Gemini first when a key is configured and the model asks for it
  if (GEMINI_KEY && (m === "auto" || m.startsWith("gemini"))) {
    try {
      return await geminiChat(m, messages, maxTokens);
    } catch (e) {
      console.error("[route] gemini failed, falling back:", e.message);
    }
  }
  return await pollinationsChat(messages, maxTokens);
}

// ---------- http ----------

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
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
  if (!API_KEY) return true; // no key configured = open (dev only)
  const h = req.headers.authorization || "";
  return h === "Bearer " + API_KEY;
}

const MODELS = [
  { id: "auto", owned_by: "mini-gateway" },
  { id: "gemini-2.0-flash", owned_by: "mini-gateway" },
  { id: "pollinations-openai", owned_by: "mini-gateway" },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/api/health" || url.pathname === "/healthz") {
    return send(res, 200, { status: "ok", backend: GEMINI_KEY ? "gemini+pollinations" : "pollinations" });
  }

  if (!authorized(req)) {
    return send(res, 401, { error: { message: "Invalid API key", code: "invalid_api_key" } });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return send(res, 200, { object: "list", data: MODELS });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    try {
      const body = await readBody(req);
      const { text, model, promptTokens, completionTokens } = await routeChat(
        body.model,
        body.messages || [],
        body.max_tokens
      );
      return send(res, 200, {
        id: "chatcmpl-mini-" + Date.now().toString(36),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: text },
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    } catch (e) {
      console.error("[chat] failed:", e.message);
      return send(res, 502, { error: { message: "All backends failed: " + e.message } });
    }
  }

  return send(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, () => console.log("[mini-gateway] listening on " + PORT));
