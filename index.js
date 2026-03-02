import express from "express";
import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const {
  ANTHROPIC_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  MY_PHONE_NUMBER,
  PORT = 3000,
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Memory ────────────────────────────────────────────────────────────────────
const MEMORY_FILE = path.join(__dirname, "data", "memory.json");

function loadMemory() {
  try {
    if (!fs.existsSync(path.join(__dirname, "data"))) {
      fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
    }
    if (!fs.existsSync(MEMORY_FILE)) return { log: [], lastUpdate: null };
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
  } catch {
    return { log: [], lastUpdate: null };
  }
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

function addToMemory(role, content) {
  const memory = loadMemory();
  memory.log.push({
    timestamp: new Date().toISOString(),
    role,
    content,
  });
  // Keep last 100 entries
  if (memory.log.length > 100) memory.log = memory.log.slice(-100);
  memory.lastUpdate = new Date().toISOString();
  saveMemory(memory);
}

// ── Paolo's Profile ───────────────────────────────────────────────────────────
const PAOLO_PROFILE = `
You are Paolo's personal chief of staff — his adaptive, proactive assistant. 

PAOLO'S WORLD:
- Investment banker, municipal finance @ Loop Capital Markets
- Currently pitching NTTA (North Texas Tollway Authority) — analyzing $8.8B debt portfolio, identifying high-coupon defeasance candidates, building a mandate pitch
- Producing his own film: $10K budget, target August 2026
- Applying to MBA programs: Fall 2027 matriculation
- Working on GMAT testing accommodations (condition diagnosed 2012)
- Career north star: converging finance + storytelling (inspired by Darren Walker's move to Anonymous Content)

YOUR JOB:
Send 2–4 focused check-in questions. Be specific to his actual work — not generic. Reference what he's told you before when relevant. Push him on things he hasn't updated you on in a while.

TONE: Direct, warm, no fluff. Like a trusted advisor who texts, not a bot. No emojis unless he uses them. Keep it under 320 characters per message when possible — this is SMS.

DOMAINS TO ROTATE THROUGH:
1. NTTA pitch progress — meetings, analysis milestones, competitive intel
2. Film project — script, crew, budget, shoot date locked?
3. MBA prep — GMAT accommodations status, school list, essays
4. Career pivot thinking — any IR/strategic finance/film finance conversations
5. Weekly wins + blockers — what moved, what's stuck

Use recent conversation history to avoid repeating questions. If something is overdue (like film milestone or GMAT docs), flag it gently.
`;

// ── Generate check-in message ─────────────────────────────────────────────────
async function generateCheckin(timeOfDay) {
  const memory = loadMemory();
  const recentLog = memory.log.slice(-20);
  const history = recentLog
    .map((e) => `[${e.timestamp.slice(0, 10)} ${e.role}]: ${e.content}`)
    .join("\n");

  const prompt = `It's ${timeOfDay} EST on ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.

Recent conversation history:
${history || "No history yet — this is the first check-in."}

Generate a ${timeOfDay === "morning" ? "morning kickoff" : "evening wind-down"} check-in. 
${timeOfDay === "morning" ? "Focus on: what's the priority today, any NTTA/deal updates needed, mindset." : "Focus on: what got done, what's blocked, film/MBA progress."}

Write 2–3 SMS-length questions as a single text message. No intro like 'Good morning!' — just get into it. Natural, direct.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: PAOLO_PROFILE,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].text;
}

// ── Generate Sunday briefing ──────────────────────────────────────────────────
async function generateSundayBriefing() {
  const memory = loadMemory();
  const weekLog = memory.log.filter((e) => {
    const entryDate = new Date(e.timestamp);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return entryDate > weekAgo;
  });

  const history = weekLog
    .map((e) => `[${e.timestamp.slice(0, 10)} ${e.role}]: ${e.content}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    system: PAOLO_PROFILE,
    messages: [
      {
        role: "user",
        content: `It's Sunday evening. Generate Paolo's weekly briefing based on everything he's told you this week.

This week's log:
${history || "No check-ins logged this week."}

Structure:
1. THE WEEK IN REVIEW — what actually happened based on his updates
2. DEAL PIPELINE — NTTA status, any other work items
3. PERSONAL GOALS PULSE — film project, MBA, GMAT
4. GAPS — things he hasn't updated you on (flag honestly)
5. TOP 3 MONDAY MOVES — specific, actionable

Keep it tight. This is being sent as SMS so break it into short paragraphs. Total under 1200 characters.`,
      },
    ],
  });

  return response.content[0].text;
}

// ── Send SMS ──────────────────────────────────────────────────────────────────
async function sendSMS(message) {
  await twilioClient.messages.create({
    body: message,
    from: TWILIO_FROM_NUMBER,
    to: MY_PHONE_NUMBER,
  });
  console.log(`[${new Date().toISOString()}] SMS sent: ${message.slice(0, 60)}...`);
  addToMemory("assistant", message);
}

// ── Cron schedule (EST = UTC-5) ───────────────────────────────────────────────
// Mon, Wed, Fri — 8am EST = 13:00 UTC
cron.schedule("0 13 * * 1,3,5", async () => {
  console.log("Running morning check-in...");
  const msg = await generateCheckin("morning");
  await sendSMS(msg);
});

// Mon, Wed, Fri — 8pm EST = 01:00 UTC next day
cron.schedule("0 1 * * 2,4,6", async () => {
  console.log("Running evening check-in...");
  const msg = await generateCheckin("evening");
  await sendSMS(msg);
});

// Sunday — 7pm EST = 00:00 UTC Monday
cron.schedule("0 0 * * 1", async () => {
  console.log("Running Sunday briefing...");
  const msg = await generateSundayBriefing();
  await sendSMS(msg);
});

// ── Webhook: receive Paolo's replies ─────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/sms", (req, res) => {
  const incomingMsg = req.body.Body || "";
  const from = req.body.From || "";

  console.log(`[${new Date().toISOString()}] Reply from ${from}: ${incomingMsg}`);

  // Log his reply to memory
  if (incomingMsg.trim()) {
    addToMemory("paolo", incomingMsg.trim());
  }

  // Twilio expects TwiML response (empty = no auto-reply)
  res.set("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
});

// Health check
app.get("/", (req, res) => res.json({ status: "Paolo's assistant is running", time: new Date().toISOString() }));

// Manual trigger endpoints (for testing)
app.get("/trigger/morning", async (req, res) => {
  const msg = await generateCheckin("morning");
  await sendSMS(msg);
  res.json({ sent: msg });
});

app.get("/trigger/evening", async (req, res) => {
  const msg = await generateCheckin("evening");
  await sendSMS(msg);
  res.json({ sent: msg });
});

app.get("/trigger/briefing", async (req, res) => {
  const msg = await generateSundayBriefing();
  await sendSMS(msg);
  res.json({ sent: msg });
});

app.get("/memory", (req, res) => {
  res.json(loadMemory());
});

app.listen(PORT, () => {
  console.log(`Paolo's assistant running on port ${PORT}`);
  console.log("Schedule: Check-ins Mon/Wed/Fri 8am+8pm EST | Briefing Sunday 7pm EST");
});
