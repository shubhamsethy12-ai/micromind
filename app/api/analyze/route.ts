// app/api/analyze/route.ts
// MicroMind Execution Engine — powered by Claude
// Drop this file at: src/app/api/analyze/route.ts

import { NextRequest } from "next/server";

export const runtime = "edge";

// ── Rate limiting (simple in-memory for edge — swap for Upstash Redis in prod) ──
const rateLimitMap = new Map<string, { count: number; reset: number }>();
const RATE_LIMIT = 10; // requests per window
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) {
    rateLimitMap.set(ip, { count: 1, reset: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ── Input validation ──────────────────────────────────────────
function validateIdea(idea: unknown): string | null {
  if (typeof idea !== "string") return null;
  const trimmed = idea.trim();
  if (trimmed.length < 10) return null;
  if (trimmed.length > 2000) return trimmed.substring(0, 2000);
  return trimmed;
}

// ── System prompt — the core MicroMind operator brain ─────────
function buildSystemPrompt(): string {
  return `You are MicroMind, a high-level execution engine.
You think like a top 1% operator, but you speak in simple, direct actions.

THINK silently — do NOT include your thinking in the output:
1. What is the real goal behind this idea?
2. What stage is the user at? (idea, validation, building, distributing, scaling)
3. What is the highest-leverage action they can take RIGHT NOW?
4. What would a top operator in this domain do FIRST?
5. What single action creates real-world feedback the fastest?

OUTPUT RULES:
- Output ONLY a JSON object. Nothing else. No markdown. No explanation.
- The JSON must have exactly three keys: "understanding", "bottleneck", "nextStep"
- understanding: 1 sentence. What you see about their situation. Factual, not encouraging.
- bottleneck: 1 sentence. The single real thing blocking progress. Be specific, not generic.
- nextStep: 1 action. Executable in under 10 minutes. High-leverage. Domain-specific.

NEXT STEP RULES:
- Start with a strong action verb: Open, Call, Message, Ask, Write, Visit, Calculate, Post, List, Find
- Be extremely specific — include exact wording if it helps
- Must match the user's domain and real-world context
- No generic advice. A tech founder and a logistics operator get completely different steps.
- No explanation attached to the step
- No multiple options
- No theory or teaching

TONE:
- Calm, direct, sharp
- No fluff, no encouragement, no excitement language
- Feels like a senior operator giving one clear instruction

EXAMPLES:
User: "I want to build an app for students"
Output: {"understanding":"You are at idea stage for a student-facing product with no validated demand yet.","bottleneck":"You do not know if students have this problem badly enough to pay or change their behavior.","nextStep":"Message 3 students right now: 'What is the most confusing part of your coursework this week?' Write their exact answers."}

User: "I want to scale my logistics business all over India"
Output: {"understanding":"You have a working logistics operation and want to expand geographically.","bottleneck":"You are planning expansion before documenting what makes your current operation work reliably.","nextStep":"Call one distributor outside your current area. Ask exactly: how do you currently manage deliveries in your zone and what breaks most often?"}

User: "I have a tiffin service and want more customers"
Output: {"understanding":"You have a food business running and need to grow your customer base.","bottleneck":"You are not in the places where your next customers already look for food options.","nextStep":"Walk into 3 offices within 1 km of your kitchen today. Ask the receptionist: do people here order lunch and from where?"}

OUTPUT FORMAT — return ONLY this JSON, nothing else:
{"understanding":"...","bottleneck":"...","nextStep":"..."}`;
}

// ── POST handler ──────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // Rate limit
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Try again in an hour." }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  // Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid request body." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Validate idea
  const idea = validateIdea((body as Record<string, unknown>)?.idea);
  if (!idea) {
    return new Response(
      JSON.stringify({ error: "Idea must be between 10 and 2000 characters." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Check API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "AI engine not configured." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Call Claude
  let claudeResponse: Response;
  try {
    claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",   // fast + cheap for this use case
        max_tokens: 400,
        temperature: 0.3,                     // focused, not creative
        system: buildSystemPrompt(),
        messages: [
          {
            role: "user",
            content: `User idea: ${idea}`,
          },
        ],
      }),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Could not reach AI engine. Try again." }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!claudeResponse.ok) {
    const errorText = await claudeResponse.text().catch(() => "unknown error");
    console.error("Claude API error:", claudeResponse.status, errorText);
    return new Response(
      JSON.stringify({ error: "AI engine returned an error. Try again." }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // Parse Claude response
  let data: {
    content: Array<{ type: string; text?: string }>;
  };

  try {
    data = await claudeResponse.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Could not parse AI response." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const rawText = data.content
    ?.filter((b) => b.type === "text")
    ?.map((b) => b.text)
    ?.join("")
    ?.trim();

  if (!rawText) {
    return new Response(
      JSON.stringify({ error: "AI returned an empty response." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Parse JSON from Claude's response
  let parsed: { understanding: string; bottleneck: string; nextStep: string };
  try {
    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/```json\n?|\n?```/g, "").trim();
    parsed = JSON.parse(cleaned);

    // Validate required keys
    if (!parsed.understanding || !parsed.bottleneck || !parsed.nextStep) {
      throw new Error("Missing required keys");
    }
  } catch {
    // Fallback: try to extract with regex if JSON is malformed
    console.error("JSON parse failed. Raw:", rawText);
    return new Response(
      JSON.stringify({ error: "AI returned unexpected format. Try again." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Sanitize output — strip any trailing explanation Claude might add
  const clean = {
    understanding: parsed.understanding.substring(0, 300).trim(),
    bottleneck: parsed.bottleneck.substring(0, 300).trim(),
    nextStep: parsed.nextStep.substring(0, 500).trim(),
  };

  return new Response(JSON.stringify(clean), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
