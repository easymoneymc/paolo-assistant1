import express from "express";
import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const {
  ANTHROPIC_API_KEY,
  PUSHOVER_USER_KEY,
  PUSHOVER_API_TOKEN,
  PORT = 3000,
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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
  memory.log.push({ timestamp: new Date().toISOString(), role, content });
  if (memory.log.length > 100) memory.log = memory.log.slice(-100);
  memory.lastUpdate = new Date().toISOString();
  saveMemory(memory);
}

// ── Paolo's Profile ───────────────────────────────────────────────────────────
const PAOLO_PROFILE = `
You are Paolo's personal chief of staff — sharp, adaptive, focused on where he's going, not just where he currently is.

WHERE PAOLO IS HEADED (priority — always lead with these):
- Film production: $10K budget, August 2026 target. Real deadline. Track pre-production milestones.
- MBA applications: Fall 2027 matriculation. School list, essays, GMAT all need progress.
- GMAT testing accommodations: condition diagnosed 2012, documentation in progress. Needs to get locked.
- Career pivot: converging finance + storytelling. North star = Darren Walker's move from Ford Foundation to Anonymous Content. Moving toward IR, strategic finance at tech, or film finance roles.
- Personal growth — who he's becoming, not just his output.

BACKGROUND CONTEXT (don't surface unless he brings it up):
- Current job: investment banker, municipal finance at Loop Capital Markets. He'll mention work when it matters. Never ask about deals, clients, or pitches proactively.

YOUR JOB:
Send 2–3 focused check-in questions per message. Always root them in his goals and transition. Be specific. Reference what he's told you. Flag overdue milestones directly — but only once, not every session.

TONE: Direct, warm, no fluff. A trusted advisor who texts. No emojis unless he uses them. Keep messages concise.

QUESTION DOMAINS (rotate in this order):
1. Film project — script, crew, location, shoot date, budget
2. MBA prep — GMAT accommodations, school list, essay angle, timeline
3. Career pivot — networking, conversations, applications
4. Personal development — reading, creative work, what's energizing or draining
5. Weekly momentum — what moved, what's stuck, what needs a decision

Work: engage fully if he raises it. Otherwise, don't touch it.
Never repeat the same question twice.
`;

// ── Generate check-in ─────────────────────────────────────────────────────────
async function generateCheckin(timeOfDay) {
  const memory = loadMemory();
  const history = memory.log
    .slice(-20)
    .map((e) => `[${e.timestamp.slice(0, 10)} ${e.role}]: ${e.content}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: PAOLO_PROFILE,
    messages: [{
      role: "user",
      content: `It's ${timeOfDay} EST on ${new Date().toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric",
      })}.

Recent history:
${history || "No history yet — first check-in."}

Generate a ${timeOfDay === "morning" ? "morning kickoff" : "evening wind-down"} check-in.
${timeOfDay === "morning"
  ? "Focus: one concrete thing he can move on his goals today."
  : "Focus: honest reflection — what he actually did vs. planned."}

2–3 questions. No greeting — straight into it.`
    }],
  });

  return response.content[0].text;
}

// ── Generate Sunday briefing ──────────────────────────────────────────────────
async function generateSundayBriefing() {
  const memory = loadMemory();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekLog = memory.log.filter((e) => new Date(e.timestamp) > weekAgo);
  const history = weekLog
    .map((e) => `[${e.timestamp.slice(0, 10)} ${e.role}]: ${e.content}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    system: PAOLO_PROFILE,
    messages: [{
      role: "user",
      content: `Sunday evening briefing. Summarize Paolo's week and orient him for the week ahead.

This week's log:
${history || "No check-ins this week — orient him on his standing goals."}

Structure (concise, under 1200 characters total):
1. WEEK IN REVIEW — what actually happened (honest)
2. GOALS PULSE — film, MBA, GMAT, career pivot
3. GAPS — things that haven't moved and should
4. WORK NOTES — only if he mentioned work this week; skip otherwise
5. MONDAY MOVES — 3 specific actions for tomorrow

Short paragraphs. Direct. No filler.`
    }],
  });

  return response.content[0].text;
}

// ── Send Pushover notification ────────────────────────────────────────────────
async function sendPush(message) {
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: PUSHOVER_API_TOKEN,
      user: PUSHOVER_USER_KEY,
      message: message,
      title: "Chief of Staff",
    }),
  });
  console.log(`[${new Date().toISOString()}] Push sent: ${message.slice(0, 60)}...`);
  addToMemory("assistant", message);
}

// ── Cron schedule (EST = UTC-5) ───────────────────────────────────────────────
// Mon, Wed, Fri — 8am EST = 13:00 UTC
cron.schedule("0 13 * * 1,3,5", async () => {
  const msg = await generateCheckin("morning");
  await sendPush(msg);
});

// Mon, Wed, Fri — 8pm EST = 01:00 UTC (next calendar day)
cron.schedule("0 1 * * 2,4,6", async () => {
  const msg = await generateCheckin("evening");
  await sendPush(msg);
});

// Sunday — 7pm EST = 00:00 UTC Monday
cron.schedule("0 0 * * 1", async () => {
  const msg = await generateSundayBriefing();
  await sendPush(msg);
});

// ── Express server ────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) =>
  res.json({ status: "Paolo's assistant running", time: new Date().toISOString() })
);

app.get("/trigger/morning", async (req, res) => {
  const msg = await generateCheckin("morning");
  await sendPush(msg);
  res.json({ sent: msg });
});

app.get("/trigger/evening", async (req, res) => {
  const msg = await generateCheckin("evening");
  await sendPush(msg);
  res.json({ sent: msg });
});

app.get("/trigger/briefing", async (req, res) => {
  const msg = await generateSundayBriefing();
  await sendPush(msg);
  res.json({ sent: msg });
});

app.get("/memory", (req, res) => res.json(loadMemory()));

app.listen(PORT, () => {
  console.log(`Paolo's assistant running on port ${PORT}`);
  console.log("Mon/Wed/Fri 8am + 8pm EST | Sunday 7pm briefing");
});
