/**
 * Mini Gateway — stateless minimal AI gateway.
 *
 * Request in -> AI output out -> done. No database, no state, no snapshots.
 * OpenAI-compatible: GET /v1/models, POST /v1/chat/completions.
 * Anthropic-compatible: POST /v1/messages (native proxy to the full gateway,
 *   with SSE streaming passthrough and a translated fallback).
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

async function upstreamChat(key, model, messages, maxTokens, tools) {
  const r = await fetch(UPSTREAM + "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens || 2000,
      stream: false,
      ...(tools ? { tools } : {}),
    }),
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
    toolCalls: c.message?.tool_calls || [],
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

let GEMINI_MODEL_CACHE = null;

async function geminiPickModel() {
  if (GEMINI_MODEL_CACHE) return GEMINI_MODEL_CACHE;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`
    );
    if (!r.ok) throw new Error("list models HTTP " + r.status);
    const d = await r.json();
    const models = (d.models || [])
      .map((m) => m.name.replace("models/", ""))
      .filter((n) => /flash/i.test(n) && /generateContent/i.test(
        (d.models.find((m) => m.name.endsWith(n))?.supportedGenerationMethods || []).join(",")
      ));
    // Prefer the newest flash model.
    models.sort().reverse();
    if (models.length) {
      GEMINI_MODEL_CACHE = models[0];
      console.log("[gemini] auto-selected model:", GEMINI_MODEL_CACHE);
      return GEMINI_MODEL_CACHE;
    }
  } catch (e) {
    console.error("[gemini] model discovery failed:", e.message);
  }
  // Fallback guesses if discovery fails.
  return "gemini-2.0-flash";
}

async function geminiChat(model, messages, maxTokens) {
  const wanted = String(model || "auto").replace(/^gemini\//, "");
  const preferred = wanted === "auto" ? await geminiPickModel() : wanted;
  const candidates = [preferred, "gemini-2.0-flash", "gemini-1.5-flash"];
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => String(m.content || ""))
    .join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }],
    }))
    .filter((c) => c.parts[0].text);
  if (!contents.length) throw new Error("gemini: no content to send");
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (maxTokens) body.generationConfig = { maxOutputTokens: maxTokens };
  const errors = [];
  for (const geminiModel of candidates) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`gemini ${geminiModel} HTTP ${r.status}: ${t.slice(0, 100)}`);
      }
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      if (!text) throw new Error(`gemini ${geminiModel}: empty response`);
      const u = d.usageMetadata || {};
      return {
        text,
        model: "gemini/" + geminiModel,
        promptTokens: u.promptTokenCount || 0,
        completionTokens: u.candidatesTokenCount || 0,
      };
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(errors.join(" | "));
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

async function routeChat(clientKey, model, messages, maxTokens, tools) {
  const errors = [];
  // 1. Full gateway (all models)
  try {
    return await upstreamChat(clientKey, model, messages, maxTokens, tools);
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
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
  const auth = (req.headers.authorization || "").trim();
  const xkey = (req.headers["x-api-key"] || "").trim();
  // Claude Code sends the token as x-api-key; browsers/apps use Bearer.
  return auth === "Bearer " + API_KEY || xkey === API_KEY;
}

function clientKey(req) {
  const auth = (req.headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "");
  return (req.headers["x-api-key"] || "").trim();
}

// ---------- anthropic /v1/messages ----------

// Primary path: the full gateway speaks Anthropic natively — proxy body as-is.
async function upstreamMessages(clientKey, body, anthropicVersion) {
  const r = await fetch(UPSTREAM + "/v1/messages", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + clientKey,
      "Content-Type": "application/json",
      "anthropic-version": anthropicVersion || "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (r.status === 503) {
    const t = await r.text();
    throw new Error("upstream_unavailable: " + t.slice(0, 100));
  }
  if (!r.ok) throw new Error("upstream HTTP " + r.status);
  return r;
}

// Fallback path: translate Anthropic messages -> OpenAI chat (with tools),
// route via the working chat-completions backends, translate back.
function anthropicToOpenAI(body) {
  const msgs = [];
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : String(body.system);
    if (sys) msgs.push({ role: "system", content: sys });
  }
  for (const m of body.messages || []) {
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          msgs.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
          });
        } else if (b.type === "text" && b.text) {
          msgs.push({ role: "user", content: b.text });
        } else if (b.type === "image") {
          msgs.push({ role: "user", content: "[image omitted on fallback backend]" });
        }
      }
      continue;
    }
    let text = "";
    const toolCalls = [];
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ type: "text", text: typeof m.content === "string" ? m.content : "" }];
    for (const b of blocks) {
      if (b.type === "text") text += b.text || "";
      else if (b.type === "tool_use")
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
    }
    const msg = { role: "assistant", content: text || null };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    msgs.push(msg);
  }
  const tools = (body.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
  return { messages: msgs, tools: tools.length ? tools : undefined };
}

function openAIToAnthropic(text, toolCalls, model, promptTokens, completionTokens) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const tc of toolCalls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch (_) {}
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "tool", input });
  }
  return {
    id: "msg_mini_" + Date.now().toString(36),
    type: "message",
    role: "assistant",
    model: model || "auto",
    content,
    stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: promptTokens || 0, output_tokens: completionTokens || 0 },
  };
}

// Synthesize Anthropic SSE events from a translated (non-stream) answer,
// so streaming clients keep working when the native upstream stream is down.
function anthropicSSE(res, msg) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: msg.id, type: "message", role: "assistant", content: [],
      model: msg.model, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 },
    },
  });
  let idx = 0;
  for (const b of msg.content) {
    if (b.type === "text") {
      send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
      // Emit in small chunks to look like a real stream.
      const t = b.text;
      for (let i = 0; i < t.length; i += 60) {
        send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: t.slice(i, i + 60) } });
      }
      send("content_block_stop", { type: "content_block_stop", index: idx });
      idx++;
    } else if (b.type === "tool_use") {
      send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const js = JSON.stringify(b.input);
      for (let i = 0; i < js.length; i += 60) {
        send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: js.slice(i, i + 60) } });
      }
      send("content_block_stop", { type: "content_block_stop", index: idx });
      idx++;
    }
  }
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: msg.usage.output_tokens },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

function upstreamAnswerUsable(d) {
  if (!d || d.type !== "message" || !Array.isArray(d.content)) return false;
  // Strip the upstream's empty-response placeholder text; it's noise.
  d.content = d.content.filter(
    (b) => !(b.type === "text" && (!b.text || b.text === "(empty response)"))
  );
  const hasTool = d.content.some((b) => b.type === "tool_use");
  const text = d.content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
  return hasTool || !!text;
}

async function routeMessages(clientKey, body) {
  const errors = [];
  // 1. Native proxy — but only trust it if the answer has real content.
  try {
    const r = await upstreamMessages(clientKey, body, undefined);
    const d = await r.json();
    if (upstreamAnswerUsable(d)) return { status: r.status, json: d };
    errors.push("upstream: empty response");
  } catch (e) {
    errors.push("upstream: " + e.message);
    console.error("[messages]", e.message);
  }
  // 2. Translated fallback via the working chat-completions backends.
  try {
    const oai = anthropicToOpenAI(body);
    const { text, toolCalls, model, promptTokens, completionTokens } = await routeChat(
      clientKey, body.model || "auto", oai.messages, body.max_tokens, oai.tools
    );
    if (!text && !(toolCalls || []).length) throw new Error("fallback returned empty");
    return { status: 200, json: openAIToAnthropic(text, toolCalls, model, promptTokens, completionTokens) };
  } catch (e) {
    errors.push("fallback: " + e.message);
  }
  throw new Error(errors.join(" | "));
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
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

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    try {
      const body = await readBody(req);
      const anthropicVersion = req.headers["anthropic-version"] || "2023-06-01";
      const out = await routeMessages(key, body);
      if (body.stream) {
        // Try the native upstream SSE first.
        try {
          const r = await upstreamMessages(key, body, anthropicVersion);
          res.writeHead(r.status, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          for await (const chunk of r.body) res.write(chunk);
          return res.end();
        } catch (e) {
          // Native stream unavailable/broken: synthesize SSE from the
          // translated answer so streaming clients keep working.
          console.error("[messages] stream upstream failed, synthesizing SSE:", e.message);
          return anthropicSSE(res, out.json);
        }
      }
      return send(res, out.status, out.json);
    } catch (e) {
      console.error("[messages] all backends failed:", e.message);
      return send(res, 502, { type: "error", error: { type: "api_error", message: "All backends failed: " + e.message } });
    }
  }

  return send(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, () => console.log("[mini-gateway] listening on " + PORT));
