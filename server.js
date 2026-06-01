const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const ROOT = process.cwd();
app.use(express.static(ROOT));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

// ── GAME STATE STORE ──────────────────────────────────────────────────────────
const rooms = {};

// ── CARD ENGINE ──────────────────────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RV = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = 0 | Math.random() * (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cardVal(c, trump) { return RV[c.r] + (c.s === trump ? 200 : 0); }
function trickWinner(played, led, trump) {
  let best = played[0], bv = 0;
  for (const p of played) {
    const v = cardVal(p.card, trump) + (p.card.s === led && p.card.s !== trump ? 100 : 0);
    if (v > bv) { bv = v; best = p; }
  }
  return best.playerIdx;
}
function cpuBid(hand, trump, soFar, total, isDealer, diff) {
  let e = 0;
  for (const c of hand) {
    let s = RV[c.r]; if (c.s === trump) s += 3;
    if (s >= 13) e += 0.85; else if (s >= 11) e += 0.5; else if (s >= 9) e += 0.25;
  }
  e = Math.round(e);
  if (diff === 'easy') e = Math.max(0, e + (0 | Math.random() * 3) - 1);
  const forb = isDealer ? total - soFar : -1;
  if (e === forb) e = e > 0 ? e - 1 : e + 1;
  return Math.max(0, Math.min(e, total));
}
function cpuPlay(hand, led, trump, trick, diff) {
  let ok = led ? hand.filter(c => c.s === led) : hand;
  if (!ok.length) ok = hand;
  if (diff === 'easy') return ok[0 | Math.random() * ok.length];
  ok = [...ok].sort((a, b) => cardVal(a, trump) - cardVal(b, trump));
  if (!trick.length) return ok[ok.length - 1];
  const bestC = trick.reduce((b, p) =>
    (cardVal(p.card, trump) + (p.card.s === led ? 100 : 0)) >
    (cardVal(b.card, trump) + (b.card.s === led ? 100 : 0)) ? p : b
  ).card;
  const win = ok.filter(c => cardVal(c, trump) > cardVal(bestC, trump));
  return win.length ? win[0] : ok[0];
}

// ── ROOM HELPERS ─────────────────────────────────────────────────────────────
function buildRounds(playerCount) {
  const max = Math.floor(52 / playerCount);
  const r = [];
  for (let i = 1; i <= max; i++) r.push(i);
  for (let i = max - 1; i >= 1; i--) r.push(i);
  return r;
}

function startRound(roomId) {
  const g = rooms[roomId];
  const n = g.rounds[g.roundIdx];
  const deck = shuffle(makeDeck());
  g.hands = g.players.map(() => []);
  for (let i = 0; i < n; i++) for (let p = 0; p < g.players.length; p++) g.hands[p].push(deck.pop());
  g.trump = deck.length ? deck[deck.length - 1].s : SUITS[0 | Math.random() * 4];
  g.bids = g.players.map(() => null);
  g.won = g.players.map(() => 0);
  g.trickPlayed = [];
  g.led = null;
  g.trickNum = 0;
  g.phase = 'bidding';
  g.currentPlayer = (g.dealerIdx + 1) % g.players.length;
  broadcastState(roomId);
  maybeAdvanceCpu(roomId);
}

function broadcastState(roomId) {
  const g = rooms[roomId];
  // Send each player their own hand, hide others
  g.players.forEach((p, i) => {
    if (!p.socketId) return;
    const state = buildClientState(roomId, i);
    io.to(p.socketId).emit('state', state);
  });
}

function buildClientState(roomId, playerIdx) {
  const g = rooms[roomId];
  return {
    roomId,
    phase: g.phase,
    roundIdx: g.roundIdx,
    totalRounds: g.rounds.length,
    cardsThisRound: g.rounds[g.roundIdx],
    trump: g.trump,
    players: g.players.map((p, i) => ({
      name: p.name,
      isCpu: p.isCpu,
      score: p.score,
      bid: g.bids[i],
      won: g.won[i],
      isDealer: i === g.dealerIdx,
      isCurrentPlayer: i === g.currentPlayer,
      cardCount: g.hands[i] ? g.hands[i].length : 0,
    })),
    myIndex: playerIdx,
    myHand: g.hands[playerIdx] || [],
    bids: g.bids,
    trickPlayed: g.trickPlayed,
    led: g.led,
    currentPlayer: g.currentPlayer,
    roundResults: g.roundResults || null,
  };
}

function maybeAdvanceCpu(roomId) {
  const g = rooms[roomId];
  if (!g) return;
  const cur = g.players[g.currentPlayer];
  if (!cur || !cur.isCpu) return;
  setTimeout(() => {
    if (!rooms[roomId]) return;
    if (g.phase === 'bidding') {
      const n = g.rounds[g.roundIdx];
      const soFar = g.bids.filter(b => b !== null).reduce((a, b) => a + b, 0);
      const bid = cpuBid(g.hands[g.currentPlayer], g.trump, soFar, n, g.currentPlayer === g.dealerIdx, g.diff);
      applyBid(roomId, g.currentPlayer, bid);
    } else if (g.phase === 'playing') {
      const card = cpuPlay(g.hands[g.currentPlayer], g.led, g.trump, g.trickPlayed, g.diff);
      applyPlay(roomId, g.currentPlayer, card);
    }
  }, 900);
}

function applyBid(roomId, playerIdx, bid) {
  const g = rooms[roomId];
  if (!g || g.phase !== 'bidding' || g.currentPlayer !== playerIdx) return;
  g.bids[playerIdx] = bid;
  if (playerIdx === g.dealerIdx) {
    g.phase = 'playing';
    g.currentPlayer = (g.dealerIdx + 1) % g.players.length;
  } else {
    g.currentPlayer = (playerIdx + 1) % g.players.length;
  }
  broadcastState(roomId);
  maybeAdvanceCpu(roomId);
}

function applyPlay(roomId, playerIdx, card) {
  const g = rooms[roomId];
  if (!g || g.phase !== 'playing' || g.currentPlayer !== playerIdx) return;
  const hand = g.hands[playerIdx];
  const idx = hand.findIndex(c => c.r === card.r && c.s === card.s);
  if (idx === -1) return;
  hand.splice(idx, 1);
  if (!g.trickPlayed.length) g.led = card.s;
  g.trickPlayed.push({ playerIdx, card });
  if (g.trickPlayed.length === g.players.length) {
    broadcastState(roomId);
    setTimeout(() => resolveTrick(roomId), 1200);
  } else {
    g.currentPlayer = (playerIdx + 1) % g.players.length;
    broadcastState(roomId);
    maybeAdvanceCpu(roomId);
  }
}

function resolveTrick(roomId) {
  const g = rooms[roomId];
  if (!g) return;
  const winner = trickWinner(g.trickPlayed, g.led, g.trump);
  g.won[winner]++;
  g.trickPlayed = [];
  g.led = null;
  g.trickNum++;
  g.currentPlayer = winner;
  if (g.trickNum >= g.rounds[g.roundIdx]) {
    endRound(roomId);
  } else {
    broadcastState(roomId);
    maybeAdvanceCpu(roomId);
  }
}

function endRound(roomId) {
  const g = rooms[roomId];
  g.roundResults = g.players.map((p, i) => {
    const hit = g.bids[i] === g.won[i];
    const pts = hit ? 10 + g.won[i] : 0;
    if (hit) p.score += pts;
    return { name: p.name, bid: g.bids[i], won: g.won[i], pts, hit };
  });
  g.roundIdx++;
  if (g.roundIdx >= g.rounds.length) {
    g.phase = 'gameover';
  } else {
    g.phase = 'roundover';
  }
  broadcastState(roomId);
}

// ── SOCKET EVENTS ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Create a new room
  socket.on('createRoom', ({ name, cpuCount, diff }) => {
    const roomId = uuidv4().slice(0, 6).toUpperCase();
    const players = [{ name, socketId: socket.id, isCpu: false, score: 0 }];
    const cpuNames = ['Ada', 'Bex', 'Cy', 'Dev', 'Eve'].slice(0, cpuCount || 0);
    for (const n of cpuNames) players.push({ name: n, socketId: null, isCpu: true, score: 0 });
    rooms[roomId] = {
      players, diff: diff || 'medium',
      rounds: null, roundIdx: 0, dealerIdx: 0,
      hands: [], bids: [], won: [],
      trickPlayed: [], led: null, trump: null,
      trickNum: 0, phase: 'lobby',
      hostSocketId: socket.id,
    };
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, playerIdx: 0 });
    broadcastLobby(roomId);
  });

  // Join existing room
  socket.on('joinRoom', ({ roomId, name }) => {
    const g = rooms[roomId];
    if (!g) { socket.emit('error', 'Room not found.'); return; }
    if (g.phase !== 'lobby') { socket.emit('error', 'Game already started.'); return; }
    if (g.players.filter(p => !p.isCpu).length >= 6) { socket.emit('error', 'Room is full.'); return; }
    const playerIdx = g.players.length;
    g.players.push({ name, socketId: socket.id, isCpu: false, score: 0 });
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, playerIdx });
    broadcastLobby(roomId);
  });

  // Rejoin after disconnect
  socket.on('rejoin', ({ roomId, playerIdx }) => {
    const g = rooms[roomId];
    if (!g || !g.players[playerIdx]) { socket.emit('error', 'Room not found.'); return; }
    g.players[playerIdx].socketId = socket.id;
    socket.join(roomId);
    if (g.phase === 'lobby') broadcastLobby(roomId);
    else socket.emit('state', buildClientState(roomId, playerIdx));
  });

  // Host starts the game
  socket.on('startGame', ({ roomId }) => {
    const g = rooms[roomId];
    if (!g || socket.id !== g.hostSocketId) return;
    if (g.players.length < 2) { socket.emit('error', 'Need at least 2 players.'); return; }
    g.rounds = buildRounds(g.players.length);
    g.phase = 'playing_rounds';
    startRound(roomId);
  });

  // Player bids
  socket.on('bid', ({ roomId, playerIdx, bid }) => {
    const g = rooms[roomId];
    if (!g) return;
    if (g.players[playerIdx]?.socketId !== socket.id) return;
    applyBid(roomId, playerIdx, bid);
  });

  // Player plays a card
  socket.on('playCard', ({ roomId, playerIdx, card }) => {
    const g = rooms[roomId];
    if (!g) return;
    if (g.players[playerIdx]?.socketId !== socket.id) return;
    applyPlay(roomId, playerIdx, card);
  });

  // Next round
  socket.on('nextRound', ({ roomId }) => {
    const g = rooms[roomId];
    if (!g || g.phase !== 'roundover') return;
    g.roundResults = null;
    g.dealerIdx = (g.dealerIdx + 1) % g.players.length;
    startRound(roomId);
  });

  // Chat message
  socket.on('chat', ({ roomId, name, text }) => {
    io.to(roomId).emit('chat', { name, text, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const g = rooms[roomId];
      const p = g.players.find(p => p.socketId === socket.id);
      if (p) {
        p.socketId = null;
        broadcastLobby(roomId);
      }
    }
  });
});

function broadcastLobby(roomId) {
  const g = rooms[roomId];
  io.to(roomId).emit('lobby', {
    roomId,
    players: g.players.map(p => ({ name: p.name, isCpu: p.isCpu, online: !!p.socketId || p.isCpu })),
    hostSocketId: g.hostSocketId,
    phase: g.phase,
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Judgment running on port ${PORT}`));
