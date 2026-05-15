const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ============ STATE ============
//
// State shape:
//   bibs:    { "12": "Alice Smith" }
//   races:   { r100: { heats: { "1": Heat, "2": Heat, ... } }, r400: { ... } }
//   longJump: { "12": [ {feet, inches, totalInches} ] }
//
// Heat: { num, lineup: [bib...], startTime: ms|null, results: [{bib, ms}] }
//
let state = {
  bibs: {},
  races: {
    r100: { heats: {} },
    r400: { heats: {} }
  },
  longJump: {}
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      state = JSON.parse(raw);
    }
  } catch (e) {
    console.error("Failed to load state:", e);
  }
  // Normalize shape and migrate from old single-lineup format
  state.bibs = state.bibs || {};
  state.races = state.races || {};
  state.longJump = state.longJump || {};
  ["r100", "r400"].forEach(k => {
    const r = state.races[k] || (state.races[k] = {});
    if (!r.heats) {
      // Old shape: race had lineup/startTime/results directly. Wrap into Heat #1.
      const hasOld = r.lineup || r.results || r.startTime;
      r.heats = hasOld
        ? { "1": { num: 1, lineup: r.lineup || [], startTime: r.startTime || null, results: r.results || [] } }
        : {};
      delete r.lineup; delete r.startTime; delete r.results;
    }
  });
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), err => {
      if (err) console.error("Save failed:", err);
    });
  }, 50);
}

function broadcast() {
  io.emit("state", { state, serverNow: Date.now() });
}

loadState();

function nextHeatNum(race) {
  const nums = Object.keys(state.races[race].heats).map(Number);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

// ============ SOCKETS ============
io.on("connection", socket => {
  socket.emit("state", { state, serverNow: Date.now() });

  // ----- Bibs -----
  socket.on("bib:set", ({ num, name }) => {
    num = String(num).trim();
    name = String(name || "").trim();
    if (!num || !name) return;
    state.bibs[num] = name;
    save(); broadcast();
  });

  socket.on("bib:remove", ({ num }) => {
    num = String(num);
    delete state.bibs[num];
    ["r100", "r400"].forEach(k => {
      Object.values(state.races[k].heats).forEach(h => {
        h.lineup = h.lineup.filter(b => b !== num);
        h.results = h.results.filter(r => r.bib !== num);
      });
    });
    delete state.longJump[num];
    save(); broadcast();
  });

  // ----- Heats -----
  socket.on("heat:add", ({ race }) => {
    if (!state.races[race]) return;
    const num = nextHeatNum(race);
    state.races[race].heats[String(num)] = { num, lineup: [], startTime: null, results: [] };
    save(); broadcast();
  });

  socket.on("heat:delete", ({ race, heat }) => {
    if (!state.races[race]) return;
    delete state.races[race].heats[String(heat)];
    save(); broadcast();
  });

  socket.on("heat:checkin", ({ race, heat, bib }) => {
    if (!state.races[race]) return;
    const h = state.races[race].heats[String(heat)];
    if (!h) return;
    if (h.startTime) return; // can't change lineup once running
    bib = String(bib).trim();
    if (!bib) return;
    if (!h.lineup.includes(bib)) h.lineup.push(bib);
    save(); broadcast();
  });

  socket.on("heat:checkin:remove", ({ race, heat, bib }) => {
    if (!state.races[race]) return;
    const h = state.races[race].heats[String(heat)];
    if (!h) return;
    if (h.startTime) return;
    bib = String(bib);
    h.lineup = h.lineup.filter(b => b !== bib);
    save(); broadcast();
  });

  socket.on("heat:start", ({ race, heat }) => {
    if (!state.races[race]) return;
    const h = state.races[race].heats[String(heat)];
    if (!h || h.startTime || h.lineup.length === 0) return;
    h.startTime = Date.now();
    h.results = [];
    save(); broadcast();
  });

  socket.on("heat:stop", ({ race, heat }) => {
    if (!state.races[race]) return;
    const h = state.races[race].heats[String(heat)];
    if (!h) return;
    h.startTime = null;
    save(); broadcast();
  });

  socket.on("heat:finish", ({ race, heat, bib }) => {
    if (!state.races[race]) return;
    const h = state.races[race].heats[String(heat)];
    if (!h || !h.startTime) return;
    bib = String(bib);
    if (!h.lineup.includes(bib)) return;
    if (h.results.find(r => r.bib === bib)) return;
    h.results.push({ bib, ms: Date.now() - h.startTime });
    save(); broadcast();
  });

  // ----- Long Jump -----
  socket.on("lj:record", ({ bib, feet, inches }) => {
    bib = String(bib).trim();
    feet = Number(feet) || 0;
    inches = Number(inches) || 0;
    if (!bib) return;
    if (inches < 0 || inches >= 12) return;
    if (feet === 0 && inches === 0) return;
    const totalInches = feet * 12 + inches;
    if (!state.longJump[bib]) state.longJump[bib] = [];
    state.longJump[bib].push({ feet, inches, totalInches });
    save(); broadcast();
  });

  socket.on("lj:remove", ({ bib, idx }) => {
    bib = String(bib);
    if (!state.longJump[bib]) return;
    state.longJump[bib].splice(idx, 1);
    if (state.longJump[bib].length === 0) delete state.longJump[bib];
    save(); broadcast();
  });

  socket.on("reset:all", () => {
    state = {
      bibs: {},
      races: { r100: { heats: {} }, r400: { heats: {} } },
      longJump: {}
    };
    save(); broadcast();
  });
});

// ============ EXPORTS ============
function formatMs(ms) {
  if (ms == null) return "—";
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  if (min > 0) return `${min}:${sec.toFixed(2).padStart(5, "0")}`;
  return sec.toFixed(2);
}
function formatDist(j) { return `${j.feet}' ${j.inches}"`; }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function bestByBib(race) {
  // Across all heats, take each bib's fastest time.
  const best = new Map();
  Object.values(state.races[race].heats).forEach(h => {
    h.results.forEach(r => {
      const prev = best.get(r.bib);
      if (!prev || r.ms < prev.ms) best.set(r.bib, { bib: r.bib, ms: r.ms, heat: h.num });
    });
  });
  return [...best.values()].sort((a, b) => a.ms - b.ms);
}

function buildResultsHtml() {
  const date = new Date().toLocaleString();

  function raceSection(key, title) {
    const sorted = bestByBib(key);
    if (sorted.length === 0) return `<h2>${title}</h2><p class="empty">No results.</p>`;
    let html = `<h2>${title}</h2><table><thead><tr><th>Place</th><th>Bib</th><th>Name</th><th>Best Time</th><th>Heat</th></tr></thead><tbody>`;
    sorted.forEach((r, i) => {
      const cls = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
      html += `<tr><td class="place ${cls}">${i + 1}</td><td>${esc(r.bib)}</td><td>${esc(state.bibs[r.bib] || "")}</td><td class="time">${formatMs(r.ms)}</td><td>${r.heat}</td></tr>`;
    });
    html += `</tbody></table>`;
    return html;
  }

  const jumpers = Object.entries(state.longJump).map(([bib, jumps]) => ({
    bib, jumps,
    best: jumps.reduce((m, j) => j.totalInches > m.totalInches ? j : m, jumps[0])
  }));
  jumpers.sort((a, b) => b.best.totalInches - a.best.totalInches);

  let ljHtml = `<h2>Long Jump</h2>`;
  if (jumpers.length === 0) {
    ljHtml += `<p class="empty">No jumps recorded.</p>`;
  } else {
    ljHtml += `<table><thead><tr><th>Place</th><th>Bib</th><th>Name</th><th>Best</th><th>All Jumps</th></tr></thead><tbody>`;
    jumpers.forEach((j, i) => {
      const cls = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
      ljHtml += `<tr><td class="place ${cls}">${i + 1}</td><td>${esc(j.bib)}</td><td>${esc(state.bibs[j.bib] || "")}</td><td class="time">${formatDist(j.best)}</td><td>${j.jumps.map(formatDist).join(", ")}</td></tr>`;
    });
    ljHtml += `</tbody></table>`;
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>QuickTiming Results</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 24px auto; padding: 16px; color: #111; }
  h1 { border-bottom: 3px solid #10b981; padding-bottom: 8px; }
  h2 { margin-top: 32px; color: #1f2937; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #e5e7eb; }
  th { background: #f9fafb; }
  .place { font-weight: bold; text-align: center; width: 60px; }
  .place.gold { background: #fde047; }
  .place.silver { background: #e5e7eb; }
  .place.bronze { background: #fdba74; }
  .time { font-family: "Courier New", monospace; font-weight: bold; }
  .empty { color: #6b7280; font-style: italic; }
  .meta { color: #6b7280; font-size: 14px; }
  @media print { body { margin: 0; } }
</style></head><body>
<h1>QuickTiming — Meet Results</h1>
<p class="meta">Generated ${esc(date)}</p>
${raceSection("r100", "100 Meter Dash")}
${raceSection("r400", "400 Meter Dash")}
${ljHtml}
</body></html>`;
}

app.get("/export.html", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(buildResultsHtml());
});

app.get("/export/download", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="quicktiming-${new Date().toISOString().slice(0, 10)}.html"`);
  res.send(buildResultsHtml());
});

server.listen(PORT, () => {
  console.log(`QuickTiming server running at http://localhost:${PORT}`);
});
