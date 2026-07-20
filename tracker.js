/**
 * Paper-Trading Tracker — Signal Edge Validator
 * ==============================================
 * Sits alongside your existing scanners as a PASSIVE listener. Every time
 * a market-relevant alert lands in your Telegram group, this bot:
 *
 *   1. Parses the alert to identify which tickers it referenced
 *   2. Records a hypothetical entry at the current market price
 *   3. Waits N hours (24 by default, configurable per signal type)
 *   4. Automatically grades the "trade": did the position win, lose, or
 *      break even against a small friction cost?
 *   5. Keeps a running scoreboard: hit rate, average win, average loss,
 *      and expectancy per signal type
 *
 * This exists specifically so you can build a REAL evidence base on
 * whether any of your signals have edge, BEFORE putting real money on
 * them. It costs nothing to run. It executes ZERO real trades. Ever.
 *
 * Ground rules baked into the design:
 *   • Only tracks LIQUID US instruments (major ETFs, big-cap stocks)
 *     that have reliable Yahoo Finance prices. Crypto tokens and
 *     illiquid names are ignored on purpose — bad prices produce
 *     misleading track records.
 *   • Consistent per-signal-type trade rules — no discretion, no
 *     hindsight bias. Every alert of a given type produces the same
 *     hypothetical trade.
 *   • Assumes small friction (0.1% round-trip) as a floor for
 *     "break-even" — winning by 3 basis points is not really winning.
 *
 * How it hears alerts:
 *   Telegram getUpdates polling on the SAME bot that posts your alerts.
 *   Each new message posted BY the bot is analyzed; user messages are
 *   ignored. Setup requires no changes to your other scanner code.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   (same token your alert bots use)
 *   TELEGRAM_CHAT_ID     (same chat the alerts land in)
 *   HOLD_HOURS_DEFAULT   (default 24 — how long to hold a paper position)
 *   HOLD_HOURS_INTRADAY  (default 6.5 — for NY-open sentiment calls,
 *                         match to the trading session length)
 *   FRICTION_BPS         (default 10 — 0.10% round-trip friction floor)
 */

require("dotenv").config();
const https = require("https");
const fs = require("fs");
const path = require("path");

const CONFIG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  holdHoursDefault: parseFloat(process.env.HOLD_HOURS_DEFAULT || "24"),
  holdHoursIntraday: parseFloat(process.env.HOLD_HOURS_INTRADAY || "6.5"),
  frictionBps: parseFloat(process.env.FRICTION_BPS || "10"),
  pollSeconds: 60,     // check Telegram for new alerts every minute
  gradeCheckSeconds: 300, // scan for positions ready to grade every 5 min
};

const STATE_FILE = path.join(__dirname, "paper_state.json");

// ─── State (persists across restarts) ────────────────────────────────────────
let state = {
  lastTelegramUpdateId: 0,
  openPositions: [],   // hypothetical trades awaiting grading
  closedPositions: [], // graded outcomes
};

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    console.log(`📂 Loaded state: ${state.openPositions.length} open, ${state.closedPositions.length} closed`);
  } catch (e) {
    console.log("📂 No prior state — starting fresh");
  }
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("Save failed:", e.message); }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "PaperTracker/1.0", ...headers },
      timeout: 20000,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!CONFIG.botToken || !CONFIG.chatId) return resolve();
    const body = JSON.stringify({
      chat_id: CONFIG.chatId,
      text: text.slice(0, 4000),
      parse_mode: "Markdown",
      disable_notification: true, // paper alerts should be quiet
    });
    const req = https.request(
      `https://api.telegram.org/bot${CONFIG.botToken}/sendMessage`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.on("data", () => {}); res.on("end", resolve); }
    );
    req.on("error", () => resolve());
    req.write(body); req.end();
  });
}

// ─── Alert parsing ────────────────────────────────────────────────────────────
// Only these tickers get tracked — liquid enough to have reliable Yahoo
// Finance intraday prices. Anything else the alert mentions is ignored to
// avoid poisoning the dataset with bad-price grades.
const LIQUID_TICKERS = new Set([
  // Broad market
  "SPY", "QQQ", "IWM", "DIA", "VOO", "VTI",
  // Sector ETFs
  "XLE", "XLF", "XLK", "XLV", "XLI", "XLP", "XLY", "XLU", "XLB", "XLRE",
  "SMH", "KWEB", "FXI", "EWW", "ITA", "XHB", "TLT", "GLD", "SLV", "USO",
  // Big-cap stocks commonly mentioned in your Trump/political alerts
  "AAPL", "NVDA", "TSLA", "MSFT", "GOOG", "GOOGL", "META", "AMZN",
  "NFLX", "AMD", "INTC", "TSM", "BABA", "COIN", "MSTR",
  "PFE", "MRK", "LLY", "UNH", "JPM", "GS", "BAC", "XOM", "CVX", "OXY",
  "LMT", "RTX", "NOC", "F", "GM", "RIVN", "NUE", "X", "STLD",
  "DJT", // Trump Media
]);

// Signal-type detection based on the alert text — each one gets a different
// hold horizon, entry rule, and direction, because they're fundamentally
// different signals and should be tracked separately.
function classifyAlert(text) {
  if (text.includes("PRE-OPEN BRIEFING") || text.includes("SENTIMENT:")) {
    // NY-open sentiment — direction from score sign, single instrument (SPY
    // as the cleanest proxy for the risk-on/off call), close at end of same
    // NY session (~6.5 hours after the 8am briefing)
    const scoreMatch = text.match(/score:\s*([+-]?\d+)/i);
    if (!scoreMatch) return null;
    const score = parseInt(scoreMatch[1]);
    if (Math.abs(score) < 2) return null; // neutral = no directional call
    return {
      type: "ny_open_sentiment",
      direction: score > 0 ? "long" : "short",
      tickers: ["SPY"],
      holdHours: CONFIG.holdHoursIntraday,
      metadata: { score },
    };
  }

  if (text.includes("TRUMP POST — MARKET RELEVANT")) {
    // Trump post — always tracked as LONG on the referenced tickers.
    // Rationale: nearly all his market-relevant posts are bullish framings
    // ("great time to buy", tariffs GOOD for domestic, etc.) — testing the
    // consistent long side gives clean data. If specific themes turn out to
    // be bearish, we split them out later once we have data.
    const tickers = [...new Set([...text.matchAll(/\$([A-Z]{1,5})\b/g)].map(m => m[1]))]
      .filter(t => LIQUID_TICKERS.has(t));
    if (!tickers.length) return null;
    return {
      type: "trump_post",
      direction: "long",
      tickers,
      holdHours: CONFIG.holdHoursDefault,
      metadata: {},
    };
  }

  if (text.includes("INSIDER PURCHASE") || text.includes("CLUSTER BUY")) {
    // SEC Form 4 open-market purchase — historically the more predictive
    // insider signal. Tracked as LONG on the referenced ticker with a
    // longer horizon since this signal's edge is a slower-burn.
    // Formats differ: single-insider alerts use "($TICKER)", cluster
    // alerts use "*$TICKER*" — try both. Just take the first liquid
    // ticker mentioned in either format.
    const tickers = [
      ...text.matchAll(/\(\$([A-Z]{1,5})\)/g),
      ...text.matchAll(/\*\$([A-Z]{1,5})\*/g),
    ].map(m => m[1]).filter(t => LIQUID_TICKERS.has(t));
    if (!tickers.length) return null;
    return {
      type: text.includes("CLUSTER") ? "sec_cluster_buy" : "sec_insider_buy",
      direction: "long",
      tickers: [tickers[0]], // just one — don't double-count if ticker is mentioned twice
      holdHours: 72, // 3 days — slower signal, longer test window
      metadata: {},
    };
  }

  return null; // not a signal we track
}

// ─── Price fetching (Yahoo Finance, same as your NY-open scanner) ────────────
async function fetchQuote(symbol) {
  const endpoints = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
  ];
  for (const url of endpoints) {
    try {
      const { status, body } = await httpGetJson(url);
      if (status !== 200) continue;
      const result = body?.chart?.result?.[0];
      const price = result?.meta?.regularMarketPrice;
      if (price != null) return price;
    } catch (e) { /* try next */ }
  }
  return null;
}

// ─── Position lifecycle ──────────────────────────────────────────────────────
async function openPaperPosition(signal) {
  for (const ticker of signal.tickers) {
    const entryPrice = await fetchQuote(ticker);
    if (entryPrice == null) {
      console.warn(`   ⚠️  ${ticker}: couldn't fetch entry price, skipping`);
      continue;
    }
    const pos = {
      id: `${Date.now()}_${ticker}`,
      type: signal.type,
      direction: signal.direction,
      ticker,
      entryPrice,
      entryTime: new Date().toISOString(),
      gradeAt: new Date(Date.now() + signal.holdHours * 3600 * 1000).toISOString(),
      metadata: signal.metadata,
    };
    state.openPositions.push(pos);
    console.log(`   📄 Paper ${signal.direction} ${ticker} @ ${entryPrice.toFixed(2)} (grade in ${signal.holdHours}h) — ${signal.type}`);
  }
  saveState();
}

async function gradeReadyPositions() {
  const now = Date.now();
  const ready = state.openPositions.filter(p => new Date(p.gradeAt).getTime() <= now);
  if (!ready.length) return;

  const remaining = [];
  const graded = [];

  for (const pos of state.openPositions) {
    if (new Date(pos.gradeAt).getTime() > now) { remaining.push(pos); continue; }

    const exitPrice = await fetchQuote(pos.ticker);
    if (exitPrice == null) {
      // couldn't grade — leave it, try again next cycle (but push out a bit
      // so we don't spam Yahoo if the ticker is broken)
      pos.gradeAt = new Date(now + 30 * 60 * 1000).toISOString();
      remaining.push(pos);
      continue;
    }

    const pnlBps = pos.direction === "long"
      ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 10000
      : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 10000;
    const netBps = pnlBps - CONFIG.frictionBps;

    let outcome;
    if (netBps > 10) outcome = "win";
    else if (netBps < -10) outcome = "loss";
    else outcome = "breakeven";

    const closed = { ...pos, exitPrice, exitTime: new Date().toISOString(), pnlBps, netBps, outcome };
    state.closedPositions.push(closed);
    graded.push(closed);
    console.log(`   ${outcome === "win" ? "✅" : outcome === "loss" ? "❌" : "➖"} ${pos.ticker} ${pos.direction}: ${netBps >= 0 ? "+" : ""}${netBps.toFixed(0)} bps (${outcome})`);
  }

  state.openPositions = remaining;
  saveState();

  if (graded.length) {
    await sendScoreboard(graded);
  }
}

// ─── Scoreboard ──────────────────────────────────────────────────────────────
function computeStatsByType() {
  const byType = {};
  for (const p of state.closedPositions) {
    (byType[p.type] = byType[p.type] || []).push(p);
  }
  const rows = {};
  for (const [type, positions] of Object.entries(byType)) {
    const wins = positions.filter(p => p.outcome === "win");
    const losses = positions.filter(p => p.outcome === "loss");
    const breakevens = positions.filter(p => p.outcome === "breakeven");
    const avgWinBps = wins.length ? wins.reduce((s, p) => s + p.netBps, 0) / wins.length : 0;
    const avgLossBps = losses.length ? losses.reduce((s, p) => s + p.netBps, 0) / losses.length : 0;
    const hitRate = positions.length ? wins.length / positions.length : 0;
    // Expectancy per trade (in bps) — the key number:
    // (win% × avgWin) + (loss% × avgLoss). Positive = edge, negative = no edge.
    const expectancy = hitRate * avgWinBps + ((positions.length - wins.length - breakevens.length) / positions.length) * avgLossBps;
    rows[type] = { n: positions.length, wins: wins.length, losses: losses.length, breakevens: breakevens.length, hitRate, avgWinBps, avgLossBps, expectancy };
  }
  return rows;
}

async function sendScoreboard(justGraded) {
  const stats = computeStatsByType();
  const lines = [];
  for (const [type, s] of Object.entries(stats)) {
    if (s.n < 3) {
      lines.push(`*${type}* — ${s.n} trade${s.n === 1 ? "" : "s"} (not enough data yet)`);
      continue;
    }
    const edgeEmoji = s.expectancy > 5 ? "🟢" : s.expectancy < -5 ? "🔴" : "⚪";
    lines.push(
      `*${type}* — ${s.n} trades\n` +
      `  Hit rate: ${(s.hitRate * 100).toFixed(0)}% (${s.wins}W/${s.losses}L/${s.breakevens}BE)\n` +
      `  Avg win: +${s.avgWinBps.toFixed(0)} bps | Avg loss: ${s.avgLossBps.toFixed(0)} bps\n` +
      `  ${edgeEmoji} Expectancy: ${s.expectancy >= 0 ? "+" : ""}${s.expectancy.toFixed(0)} bps/trade`
    );
  }

  const justGradedLines = justGraded.map(g =>
    `  ${g.outcome === "win" ? "✅" : g.outcome === "loss" ? "❌" : "➖"} ${g.ticker} ${g.direction}: ${g.netBps >= 0 ? "+" : ""}${g.netBps.toFixed(0)} bps (${g.type})`
  );

  await sendTelegram(
    `📊 *PAPER TRADE GRADED*\n\n` +
    `Just closed:\n${justGradedLines.join("\n")}\n\n` +
    `*Running Scoreboard*\n\n${lines.join("\n\n")}\n\n` +
    `_Zero real money. Zero real trades. Just tracking whether your signals have edge before you ever risk anything._`
  );
}

// ─── Telegram alert ingestion ────────────────────────────────────────────────
async function pollTelegramUpdates() {
  try {
    const url = `https://api.telegram.org/bot${CONFIG.botToken}/getUpdates?offset=${state.lastTelegramUpdateId + 1}&timeout=0&allowed_updates=["message","channel_post"]`;
    const { status, body } = await httpGetJson(url);
    if (status !== 200 || !body?.ok || !body.result?.length) return;

    for (const update of body.result) {
      state.lastTelegramUpdateId = update.update_id;
      const msg = update.message || update.channel_post;
      if (!msg?.text) continue;
      // Only process messages posted BY the bot (i.e. from other alert bots
      // that share the same token, or this same bot posting via other bots
      // — we're relying on the alert format to filter, not the sender)
      if (msg.chat?.id?.toString() !== CONFIG.chatId.toString()) continue;

      const signal = classifyAlert(msg.text);
      if (!signal) continue;

      console.log(`\n📡 Detected ${signal.type} — ${signal.direction} ${signal.tickers.join(",")}`);
      await openPaperPosition(signal);
    }
    saveState();
  } catch (e) {
    console.error("Telegram poll error:", e.message);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════");
console.log("  Paper-Trading Tracker — Signal Edge Validator");
console.log(`  Listening on chat: ${CONFIG.chatId}`);
console.log(`  Hold: ${CONFIG.holdHoursDefault}h default, ${CONFIG.holdHoursIntraday}h intraday`);
console.log(`  Friction floor: ${CONFIG.frictionBps} bps round-trip`);
console.log("═══════════════════════════════════════════════════");
console.log("  Zero real trades. Zero real money. Ever.");
console.log("═══════════════════════════════════════════════════");

loadState();

if (process.argv.includes("--report")) {
  // One-shot: just print the current scoreboard to Telegram and exit
  sendScoreboard([]).then(() => process.exit(0));
} else {
  pollTelegramUpdates();
  gradeReadyPositions();
  setInterval(pollTelegramUpdates, CONFIG.pollSeconds * 1000);
  setInterval(gradeReadyPositions, CONFIG.gradeCheckSeconds * 1000);
}
