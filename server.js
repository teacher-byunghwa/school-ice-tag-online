const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 20000,
  cors: { origin: true, credentials: false }
});

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;
const BROADCAST_RATE = 15;
const DT = 1 / TICK_RATE;
const MAP = { width: 1600, height: 900 };
const PLAYER_R = 16;
const SPEED_RUNNER = 220;
const SPEED_TAGGER = 235;
const RESCUE_DISTANCE = 42;
const TAG_DISTANCE = 32;
const FREEZE_COOLDOWN_MS = 900;
const MAX_PLAYERS = 100;

// Schoolyard obstacles. Buildings/trees/goalposts behave as simple axis-aligned colliders.
const obstacles = [
  { x: 70, y: 50, w: 460, h: 120, type: 'building', label: '본관' },
  { x: 1070, y: 50, w: 460, h: 120, type: 'building', label: '체육관' },
  { x: 610, y: 80, w: 380, h: 70, type: 'building', label: '급식실' },
  { x: 95, y: 690, w: 250, h: 120, type: 'garden', label: '화단' },
  { x: 1250, y: 690, w: 250, h: 120, type: 'garden', label: '놀이터' },
  { x: 490, y: 340, w: 60, h: 180, type: 'goal', label: '' },
  { x: 1050, y: 340, w: 60, h: 180, type: 'goal', label: '' },
  { x: 740, y: 650, w: 120, h: 55, type: 'bench', label: '벤치' },
  { x: 420, y: 205, w: 55, h: 55, type: 'tree', label: '' },
  { x: 1120, y: 210, w: 55, h: 55, type: 'tree', label: '' },
  { x: 350, y: 560, w: 55, h: 55, type: 'tree', label: '' },
  { x: 1190, y: 560, w: 55, h: 55, type: 'tree', label: '' }
];

const rooms = new Map();

function randomId(n = 24) {
  return crypto.randomBytes(n).toString('hex');
}
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 1000; tries++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return randomId(3).toUpperCase();
}
function sanitizeName(v) {
  return String(v || '').trim().replace(/[<>]/g, '').slice(0, 12) || '학생';
}
function makeRoom(teacherSocketId, origin) {
  const code = makeCode();
  const token = randomId(16);
  const room = {
    code,
    teacherSocketId,
    teacherToken: token,
    state: 'waiting',
    createdAt: Date.now(),
    taggerCount: 3,
    durationSec: 240,
    endsAt: null,
    players: new Map(),
    traces: [],
    activity: [],
    origin
  };
  rooms.set(code, room);
  return room;
}
function spawnPoint(i, total) {
  // Spawn around lower half of field, away from buildings.
  const cols = 10;
  const row = Math.floor(i / cols);
  const col = i % cols;
  const jitterX = (Math.random() - 0.5) * 35;
  const jitterY = (Math.random() - 0.5) * 35;
  return {
    x: 250 + col * 115 + jitterX,
    y: 590 + (row % 2) * 90 + jitterY
  };
}
function circleRectCollision(x, y, r, o) {
  const cx = Math.max(o.x, Math.min(x, o.x + o.w));
  const cy = Math.max(o.y, Math.min(y, o.y + o.h));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy < r * r;
}
function isBlocked(x, y) {
  if (x < PLAYER_R || y < PLAYER_R || x > MAP.width - PLAYER_R || y > MAP.height - PLAYER_R) return true;
  return obstacles.some(o => circleRectCollision(x, y, PLAYER_R, o));
}
function pushActivity(room, text, kind = 'info') {
  room.activity.push({ id: randomId(4), text, kind, t: Date.now() });
  if (room.activity.length > 12) room.activity.shift();
}
function roomSummary(room) {
  const players = [...room.players.values()];
  const aliveRunners = players.filter(p => p.role === 'runner' && !p.eliminated).length;
  const aliveTaggers = players.filter(p => p.role === 'tagger' && !p.eliminated).length;
  return {
    code: room.code,
    state: room.state,
    taggerCount: room.taggerCount,
    durationSec: room.durationSec,
    endsAt: room.endsAt,
    playerCount: players.length,
    aliveRunners,
    aliveTaggers,
    maxPlayers: MAX_PLAYERS,
    activity: room.activity
  };
}
function publicState(room) {
  return {
    summary: roomSummary(room),
    map: MAP,
    obstacles,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      x: Math.round(p.x), y: Math.round(p.y),
      role: p.role,
      frozen: p.frozen,
      eliminated: p.eliminated
    })),
    traces: room.traces.slice(-120)
  };
}
function emitState(room) {
  io.to(room.code).emit('world', publicState(room));
  if (room.teacherSocketId) io.to(room.teacherSocketId).emit('teacherSummary', roomSummary(room));
}
function endGame(room, reason = 'time') {
  if (room.state !== 'playing') return;
  room.state = 'ended';
  room.endsAt = null;
  const runners = [...room.players.values()].filter(p => p.role === 'runner');
  const survivors = runners.filter(p => !p.eliminated);
  const winner = survivors.length > 0 ? 'runners' : 'taggers';
  pushActivity(room, winner === 'runners' ? `게임 종료! 도망팀 ${survivors.length}명이 살아남았습니다.` : '게임 종료! 술래팀이 모두 잡았습니다.', 'end');
  io.to(room.code).emit('gameEnded', { winner, survivors: survivors.length, reason });
  emitState(room);
}
function startGame(room) {
  const players = [...room.players.values()];
  if (players.length < 2) return { ok: false, error: '최소 2명이 필요합니다.' };
  const taggerCount = Math.min(Math.max(1, room.taggerCount), Math.max(1, players.length - 1));
  const shuffled = players.slice().sort(() => Math.random() - 0.5);
  const taggerIds = new Set(shuffled.slice(0, taggerCount).map(p => p.id));
  room.state = 'playing';
  room.endsAt = Date.now() + room.durationSec * 1000;
  room.traces = [];
  room.activity = [];
  players.forEach((p, idx) => {
    const s = spawnPoint(idx, players.length);
    p.x = s.x; p.y = s.y;
    p.role = taggerIds.has(p.id) ? 'tagger' : 'runner';
    p.frozen = false;
    p.eliminated = false;
    p.input = { up: false, down: false, left: false, right: false };
    p.lastFreezeAt = 0;
    io.to(p.socketId).emit('role', { role: p.role });
  });
  pushActivity(room, `게임 시작! 술래 ${taggerCount}명, 도망팀 ${players.length - taggerCount}명`, 'start');
  io.to(room.code).emit('gameStarted', { endsAt: room.endsAt, taggerCount });
  emitState(room);
  return { ok: true };
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/qr/:code', async (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).json({ error: 'room not found' });
  const joinUrl = `${req.protocol}://${req.get('host')}/?room=${encodeURIComponent(room.code)}`;
  try {
    const dataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 420, errorCorrectionLevel: 'M' });
    res.json({ dataUrl, joinUrl });
  } catch (e) {
    res.status(500).json({ error: 'qr failed' });
  }
});

io.on('connection', socket => {
  socket.on('createRoom', ({ origin } = {}, cb = () => {}) => {
    const room = makeRoom(socket.id, origin || '');
    socket.join(room.code);
    socket.data.teacher = { roomCode: room.code, token: room.teacherToken };
    cb({ ok: true, roomCode: room.code, teacherToken: room.teacherToken, summary: roomSummary(room) });
  });

  socket.on('teacherResume', ({ roomCode, token } = {}, cb = () => {}) => {
    const room = rooms.get(String(roomCode || '').toUpperCase());
    if (!room || room.teacherToken !== token) return cb({ ok: false, error: '교사 인증에 실패했습니다.' });
    room.teacherSocketId = socket.id;
    socket.join(room.code);
    socket.data.teacher = { roomCode: room.code, token };
    cb({ ok: true, summary: roomSummary(room) });
    emitState(room);
  });

  socket.on('teacherSettings', ({ roomCode, token, taggerCount, durationSec } = {}, cb = () => {}) => {
    const room = rooms.get(String(roomCode || '').toUpperCase());
    if (!room || room.teacherToken !== token) return cb({ ok: false, error: '교사 인증 실패' });
    if (room.state !== 'waiting') return cb({ ok: false, error: '대기실에서만 설정할 수 있습니다.' });
    room.taggerCount = Math.max(1, Math.min(20, Number(taggerCount) || 1));
    room.durationSec = Math.max(60, Math.min(900, Number(durationSec) || 240));
    pushActivity(room, `교사 설정: 술래 ${room.taggerCount}명 / ${Math.round(room.durationSec / 60)}분`, 'info');
    cb({ ok: true, summary: roomSummary(room) });
    emitState(room);
  });

  socket.on('startGame', ({ roomCode, token } = {}, cb = () => {}) => {
    const room = rooms.get(String(roomCode || '').toUpperCase());
    if (!room || room.teacherToken !== token) return cb({ ok: false, error: '교사 인증 실패' });
    cb(startGame(room));
  });

  socket.on('resetGame', ({ roomCode, token } = {}, cb = () => {}) => {
    const room = rooms.get(String(roomCode || '').toUpperCase());
    if (!room || room.teacherToken !== token) return cb({ ok: false, error: '교사 인증 실패' });
    room.state = 'waiting'; room.endsAt = null; room.traces = []; room.activity = [];
    [...room.players.values()].forEach((p, idx) => {
      const s = spawnPoint(idx, room.players.size);
      Object.assign(p, { x: s.x, y: s.y, role: 'runner', frozen: false, eliminated: false, input: { up:false,down:false,left:false,right:false } });
      io.to(p.socketId).emit('role', { role: 'runner' });
    });
    pushActivity(room, '새 게임 대기실로 돌아왔습니다.', 'info');
    cb({ ok: true }); emitState(room);
  });

  socket.on('joinRoom', ({ roomCode, nickname } = {}, cb = () => {}) => {
    const code = String(roomCode || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: '방을 찾을 수 없습니다.' });
    if (room.state !== 'waiting') return cb({ ok: false, error: '이미 게임이 시작되었습니다.' });
    if (room.players.size >= MAX_PLAYERS) return cb({ ok: false, error: '방 정원이 찼습니다.' });
    if (room.players.has(socket.id)) return cb({ ok: true, playerId: socket.id });
    const idx = room.players.size;
    const s = spawnPoint(idx, room.players.size + 1);
    const player = {
      id: socket.id,
      socketId: socket.id,
      name: sanitizeName(nickname),
      x: s.x, y: s.y,
      role: 'runner', frozen: false, eliminated: false,
      input: { up: false, down: false, left: false, right: false },
      lastFreezeAt: 0
    };
    room.players.set(player.id, player);
    socket.join(code);
    socket.data.player = { roomCode: code, playerId: player.id };
    pushActivity(room, `${player.name}님이 입장했습니다.`, 'join');
    cb({ ok: true, playerId: player.id, map: MAP, obstacles, summary: roomSummary(room) });
    emitState(room);
  });

  socket.on('input', input => {
    const pd = socket.data.player;
    if (!pd) return;
    const room = rooms.get(pd.roomCode);
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(pd.playerId);
    if (!p || p.eliminated || p.frozen) return;
    p.input = {
      up: !!input?.up,
      down: !!input?.down,
      left: !!input?.left,
      right: !!input?.right
    };
  });

  socket.on('freezeToggle', () => {
    const pd = socket.data.player;
    if (!pd) return;
    const room = rooms.get(pd.roomCode);
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(pd.playerId);
    if (!p || p.eliminated || p.role !== 'runner') return;
    const now = Date.now();
    if (now - p.lastFreezeAt < FREEZE_COOLDOWN_MS) return;
    p.lastFreezeAt = now;
    if (!p.frozen) {
      p.frozen = true;
      p.input = { up:false,down:false,left:false,right:false };
      pushActivity(room, `${p.name}님이 얼음!`, 'freeze');
      io.to(p.socketId).emit('frozen', { frozen: true });
    }
  });

  socket.on('disconnect', () => {
    const pd = socket.data.player;
    if (pd) {
      const room = rooms.get(pd.roomCode);
      if (room) {
        const p = room.players.get(pd.playerId);
        if (p) {
          room.players.delete(pd.playerId);
          pushActivity(room, `${p.name}님이 나갔습니다.`, 'leave');
          if (room.state === 'playing') {
            const aliveRunners = [...room.players.values()].filter(x => x.role === 'runner' && !x.eliminated).length;
            if (aliveRunners === 0) endGame(room, 'all-runners-out');
          }
          emitState(room);
        }
      }
    }
    const td = socket.data.teacher;
    if (td) {
      const room = rooms.get(td.roomCode);
      if (room && room.teacherSocketId === socket.id) room.teacherSocketId = null;
    }
  });
});

let broadcastCounter = 0;
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state !== 'playing') continue;
    if (room.endsAt && Date.now() >= room.endsAt) {
      endGame(room, 'time');
      continue;
    }
    const players = [...room.players.values()];
    for (const p of players) {
      if (p.eliminated || p.frozen) continue;
      const i = p.input || {};
      let dx = (i.right ? 1 : 0) - (i.left ? 1 : 0);
      let dy = (i.down ? 1 : 0) - (i.up ? 1 : 0);
      if (!dx && !dy) continue;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const speed = p.role === 'tagger' ? SPEED_TAGGER : SPEED_RUNNER;
      const nx = p.x + dx * speed * DT;
      const ny = p.y + dy * speed * DT;
      if (!isBlocked(nx, p.y)) p.x = nx;
      if (!isBlocked(p.x, ny)) p.y = ny;
    }

    // Runner rescue: any active runner touching a frozen teammate frees them.
    const runners = players.filter(p => p.role === 'runner' && !p.eliminated);
    const activeRunners = runners.filter(p => !p.frozen);
    const frozenRunners = runners.filter(p => p.frozen);
    for (const a of activeRunners) {
      for (const f of frozenRunners) {
        if (!f.frozen || a.id === f.id) continue;
        if (Math.hypot(a.x - f.x, a.y - f.y) <= RESCUE_DISTANCE) {
          f.frozen = false;
          pushActivity(room, `${a.name}님이 ${f.name}님을 구출했습니다!`, 'rescue');
          io.to(f.socketId).emit('frozen', { frozen: false });
        }
      }
    }

    // Tagging: frozen runners are safe, classic ice-tag rule.
    const taggers = players.filter(p => p.role === 'tagger' && !p.eliminated);
    for (const t of taggers) {
      for (const r of runners) {
        if (r.eliminated || r.frozen) continue;
        if (Math.hypot(t.x - r.x, t.y - r.y) <= TAG_DISTANCE) {
          r.eliminated = true;
          r.input = { up:false,down:false,left:false,right:false };
          room.traces.push({ id: randomId(4), x: Math.round(r.x), y: Math.round(r.y), name: r.name, at: Date.now() });
          pushActivity(room, `${r.name}님이 아웃되었습니다.`, 'out');
          io.to(r.socketId).emit('eliminated', { by: t.name });
        }
      }
    }

    const aliveRunners = runners.filter(p => !p.eliminated).length;
    if (aliveRunners === 0) endGame(room, 'all-runners-out');
  }
  broadcastCounter++;
  if (broadcastCounter >= Math.max(1, Math.round(TICK_RATE / BROADCAST_RATE))) {
    broadcastCounter = 0;
    for (const room of rooms.values()) if (room.state === 'playing') emitState(room);
  }
}, 1000 / TICK_RATE);

// Cleanup stale rooms after 6 hours.
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.createdAt < cutoff && room.players.size === 0) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => console.log(`School Ice Tag running on http://localhost:${PORT}`));
