try {
  importScripts("config.js"); // generated from .env; defines DEFAULT_GEMINI_API_KEY
} catch (e) {
  console.warn("[Krillion] config.js not found; set the API key in the popup.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GET_KRILLION_ANSWERS") return false;

  fetchRareAnswers(message.question, message.mode, message.avoid)
    .then((answers) => sendResponse({ ok: true, answers }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // Keeps message channel open for async response
});

async function fetchRareAnswers(question, mode, avoid) {
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

  const soloInstruction = `
You are playing Krillion, a game where you name something that fits a prompt and are scored by how few other players would say the same thing. Scoring tiers:
- Plankton (10): the answer everyone blurts out (e.g. "Egg Timer" for "something that has a timer").
- Too Clever (15): a famously "obscure" pick that everyone reaches for. Other AI players land here.
- Schooler (30), Rare (60): uncommon but still a word many people could reach (e.g. "Scullery", "Plectrum").
- Deep Cut (85): true obscurity (e.g. "Ice Axe Leash" for "something people fasten to a backpack").
- One in a Krillion (100): the designated gem at the very bottom of the trench (e.g. "Dermatillomania" for "a bad habit").

Your goal is 100. How to get there:
1. First list the obvious answers, then the "clever obscure" answers a typical AI would give (rare dictionary words like scullery, plectrum, and anything that appears in "weird facts" lists). Reject all of them.
2. Go several layers deeper: precise technical, clinical, regional, trade or hobbyist terms, named sub-types, specific proper nouns from niche fields (a particular text, species, tool, part, ailment, dish, place). Specific and narrow beats merely unusual.
3. Evidence from past rounds: specific full names and precise terms scored 85-100 (Bristle-Thighed Curlew, Jock Hutchison, José Nasazzi, Kwek-kwek, Stratocracy). Short single common words that merely fit the category scored 15 (Oyster, Banshee). For open categories (a song, a golfer, a bird, a dish, a winner) never give the first famous-ish member; pick a specific, verifiable entry from a narrow sub-niche (an early era, a small country, a minor species, a regional dish, a forgotten winner). For "something people do/smell/keep/fasten" style prompts, avoid the stock answers and name a precise, genuinely applicable item from a specialist context.
4. Validity is a hard gate. An answer the validator rejects scores 0. It must unambiguously satisfy every constraint in the prompt (dates, geography, category, count, starting letter), be a real, well-documented thing, and be written in its standard canonical English spelling (keep real diacritics and hyphens as normally written, no articles or extra words).
5. Diversify: pick from fields different from the first one that comes to mind. If you have ever seen the answer in a listicle of "obscure X", it is Too Clever.

Return JSON: {"rejected":[...the 4 obvious/too-clever answers you ruled out...],"answers":[...]} where "answers" has 6 distinct valid answers ordered from deepest (most likely 100) to progressively safer. Answers must be the exact answer strings only, no explanations.
`.trim();

  const partyInstruction = `
You are playing a fast multiplayer category game with friends. Each player in turn names one valid item in the current category; an answer that has already been said, or does not belong to the category, loses a life. Rarity does not matter here, validity and not being repeated do.
Rules:
1. Every answer must unambiguously belong to the category and be a real, well-known-enough item that a game validator will accept in standard English spelling.
2. Spread across the category: mix famous answers with moderately uncommon ones, so you are unlikely to collide with answers other players give. Do not group similar items together.
3. Never include anything from the "already used" list given in the request.
4. Answers are the exact answer strings only (no articles, no explanations).
Return JSON: {"rejected":[],"answers":[...20 distinct valid answers...]}.
`.trim();
  const systemInstruction = mode === "party" ? partyInstruction : soloInstruction;
  const userText =
    mode === "party"
      ? `Category: "${question}"` +
        (avoid && avoid.length ? `\nAlready used (do not repeat): ${avoid.join(", ")}` : "")
      : `Krillion Prompt: "${question}"`;

  const callModel = async (activeModel) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    activeModel
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userText }]
        }
      ],
      generationConfig: {
        temperature: mode === "party" ? 0.9 : 1.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            rejected: { type: "ARRAY", items: { type: "STRING" } },
            answers: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["answers"]
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
  const obj = JSON.parse(rawText);
  const parsed = Array.isArray(obj) ? obj : obj?.answers;

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
