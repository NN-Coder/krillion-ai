try {
  importScripts("config.js"); // generated from .env; defines DEFAULT_GEMINI_API_KEY
} catch (e) {
  console.warn("[Krillion] config.js not found; set the API key in the popup.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GET_KRILLION_ANSWERS") return false;

  fetchRareAnswers(message.question)
    .then((answers) => sendResponse({ ok: true, answers }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // Keeps message channel open for async response
});

async function fetchRareAnswers(question) {
  const stored = await chrome.storage.local.get(["apiKey", "model"]);
  const apiKey = stored.apiKey || self.DEFAULT_GEMINI_API_KEY;
  const model = stored.model;

  if (!apiKey) {
    throw new Error("Missing Gemini API key in extension popup.");
  }

  // gemini-3.8-flash is overloaded/slow (up to ~70s); the game gives 25s per prompt.
  const userModel = model && model !== "gemini-3.8-flash" ? model : null;
  const models = [userModel, "gemini-3.1-flash-lite", "gemini-3.5-flash"].filter(
    (m, i, a) => m && a.indexOf(m) === i
  );

  const systemInstruction = `
You are playing Krillion, a trivia game where points are awarded based on answer rarity (up to 100 points for "One in a Krillion" answers).
Rules:
1. Every answer MUST strictly and indisputably satisfy all constraints of the prompt (dates, geography, category).
2. Avoid obvious or mainstream answers (e.g., for "Name a river", never say Nile or Amazon).
3. Choose obscure, deep-cut, well-documented real-world entities using their standard canonical English name/spelling so the game's validator accepts them.
4. Return a JSON array of 4 distinct valid answers ordered from rarest (highest scoring) to slightly safer fallback, with NO explanations or extra words—only the exact answer strings.
`.trim();

  const callModel = async (activeModel) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    activeModel
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: `Krillion Prompt: "${question}"` }]
        }
      ],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          items: { type: "STRING" }
        }
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  const parsed = JSON.parse(rawText);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Gemini returned no valid answer candidates.");
  }
  return parsed;
  };

  let lastErr;
  for (const m of models) {
    try {
      const parsed = await callModel(m);
      console.log("[Krillion] answers from", m, parsed);
      return parsed.map((ans) => String(ans).trim()).filter(Boolean);
    } catch (err) {
      console.warn("[Krillion] model failed:", m, err.message);
      lastErr = err;
    }
  }
  throw lastErr;
}
