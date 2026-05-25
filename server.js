const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Game State ──────────────────────────────────────────────────────
let state = {
  phase: 'waiting',      // waiting | question | closed | reveal
  currentQ: -1,
  cluesShown: 0,
  answers: [],           // { name, answer, timestamp, won }
  scores: {},            // { name: points }
  players: {},           // { name: joined }
  winnerPicked: false,
};

const PTS = [20, 15, 10, 5];

function pts() {
  return PTS[Math.min(state.cluesShown, 3)];
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

function broadcastState() {
  broadcast({ type: 'state', state: publicState() });
}

function publicState() {
  return {
    phase: state.phase,
    currentQ: state.currentQ,
    cluesShown: state.cluesShown,
    answerCount: state.answers.length,
    winnerPicked: state.winnerPicked,
  };
}

// ── WebSocket ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = (msg.name || '').trim().slice(0, 30);
      if (!name) return;
      ws.playerName = name;
      ws.isHost = false;
      if (!state.scores[name]) state.scores[name] = 0;
      state.players[name] = true;
      ws.send(JSON.stringify({ type: 'joined', name, score: state.scores[name], state: publicState() }));
      broadcast({ type: 'playerCount', count: Object.keys(state.players).length });
    }

    if (msg.type === 'host_join') {
      ws.isHost = true;
      ws.send(JSON.stringify({ type: 'host_welcome', state: fullState() }));
    }

    if (msg.type === 'submit_answer') {
      if (state.phase !== 'question') return;
      const name = ws.playerName;
      if (!name) return;
      const already = state.answers.find(a => a.name === name);
      if (already) return;
      const entry = {
        name,
        answer: (msg.answer || '').trim().slice(0, 100),
        timestamp: Date.now(),
        won: false,
      };
      state.answers.push(entry);
      state.answers.sort((a, b) => a.timestamp - b.timestamp);
      broadcastToHosts({ type: 'answers_update', answers: state.answers });
      ws.send(JSON.stringify({ type: 'answer_received' }));
    }

    if (msg.type === 'host_start_q') {
      if (!ws.isHost) return;
      state.currentQ = msg.qIndex;
      state.cluesShown = 0;
      state.answers = [];
      state.phase = 'question';
      state.winnerPicked = false;
      broadcastState();
      broadcastToHosts({ type: 'answers_update', answers: [] });
    }

    if (msg.type === 'host_reveal_clue') {
      if (!ws.isHost) return;
      state.cluesShown = Math.min(state.cluesShown + 1, 3);
      broadcastState();
    }

    if (msg.type === 'host_close_answers') {
      if (!ws.isHost) return;
      state.phase = 'closed';
      broadcastState();
    }

    if (msg.type === 'host_pick_winner') {
      if (!ws.isHost) return;
      const winner = state.answers.find(a => a.name === msg.name);
      if (!winner) return;
      winner.won = true;
      const points = pts();
      state.scores[winner.name] = (state.scores[winner.name] || 0) + points;
      state.phase = 'reveal';
      state.winnerPicked = true;
      broadcastState();
      broadcastToHosts({ type: 'answers_update', answers: state.answers });
      broadcast({ type: 'scores_update', scores: state.scores });
      broadcast({ type: 'winner_announced', name: winner.name, points });
    }

    if (msg.type === 'host_no_winner') {
      if (!ws.isHost) return;
      state.phase = 'reveal';
      state.winnerPicked = true;
      broadcastState();
      broadcastToHosts({ type: 'answers_update', answers: state.answers });
    }

    if (msg.type === 'host_reset_scores') {
      if (!ws.isHost) return;
      state.scores = {};
      state.players = {};
      state.answers = [];
      state.phase = 'waiting';
      state.currentQ = -1;
      broadcastState();
      broadcast({ type: 'scores_update', scores: {} });
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (ws.playerName) {
      delete state.players[ws.playerName];
      broadcast({ type: 'playerCount', count: Object.keys(state.players).length });
    }
  });
});

function broadcastToHosts(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.isHost) c.send(str); });
}

function fullState() {
  return { ...publicState(), answers: state.answers, scores: state.scores, playerCount: Object.keys(state.players).length };
}

// ── Routes ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Nanay Trivia running on port ${PORT}`));
