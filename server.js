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

// V2: 훨씬 넓어진 학교 운동장. 학생 화면은 자기 캐릭터를 따라가는 카메라를 사용합니다.
const MAP = { width: 2400, height: 1400 };
const PLAYER_R = 18;
const SPEED_RUNNER = 235;
const SPEED_TAGGER = 248;
const RESCUE_DISTANCE = 48;
const TAG_DISTANCE = 36;
const FREEZE_COOLDOWN_MS = 900;
const MAX_PLAYERS = 100;

// 학교 운동장 주변의 실제 충돌 오브젝트. 중앙 운동장은 넓게 비워 50~100명 이동 공간을 확보했습니다.
const obstacles = [
  { x: 270, y: 55, w: 1860, h: 180, type: 'building', label: '본관 · 교실동' },
  { x: 55, y: 330, w: 235, h: 390, type: 'building', label: '체육관' },
  { x: 2110, y: 330, w: 235, h: 390, type: 'building', label: '급식실' },
  { x: 80, y: 1090, w: 300, h: 190, type: 'garden', label: '화단' },
  { x: 2020, y: 1080, w: 300, h: 200, type: 'garden', label: '놀이터' },
  { x: 515, y: 540, w: 34, h: 210, type: 'goal', label: '' },
  { x: 1850, y: 540, w: 34, h: 210, type: 'goal', label: '' },
  { x: 1110, y: 1110, w: 180, h: 55, type: 'bench', label: '벤치' },
  { x: 430, y: 270, w: 64, h: 64, type: 'tree', label: '' },
  { x: 670, y: 275, w: 64, h: 64, type: 'tree', label: '' },
  { x: 1680, y: 275, w: 64, h: 64, type: 'tree', label: '' },
  { x: 1910, y: 270, w: 64, h: 64, type: 'tree', label: '' },
  { x: 420, y: 1030, w: 64, h: 64, type: 'tree', label: '' },
  { x: 1910, y: 1030, w: 64, h: 64, type: 'tree', label: '' }
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
function circleRectCollision(x, y, r, o) {
  const cx = Math.max(o.x, Math.min(x, o.x + o.w));
  const cy = Math.max(o.y, Math.min(y, o.y + o.h));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy < r * r;
}
function isBlocked(x, y, radius = PLAYER_R) {
  if (x < radius || y < radius || x > MAP.width - radius || y > MAP.height - radius) return true;
  return obstacles.some(o => circleRectCollision(x, y, radius, o));
}

// V1에서는 2번째 학생의 시작점이 나무 충돌 영역과 겹칠 수 있었습니다.
// V2에서는 최대 100개의 '검증된 빈 자리' 후보에서만 시작시켜 같은 문제가 재발하지 않도록 합니다.
function spawnPoint(i) {
  const cols = 13;
  const rows = 8; // 104 slots
  const index = i % (cols * rows);
  const row = Math.floor(index / cols);
  const col = index % cols;
  const baseX = 650 + col * 92;
  const baseY = 500 + row * 74;

  const candidates = [
    [baseX, baseY],
    [baseX + 24, baseY + 20],
    [baseX - 24, baseY - 20],
    [baseX + 36, baseY - 24],
    [baseX - 36, baseY + 24]
  ];

  for (const [x, y] of candidates) {
    if (!isBlocked(x, y, PLAYER_R + 10)) return { x, y };
  }

  // 방어적 fallback: 중앙 운동장을 격자로 훑어 반드시 빈 지점을 찾습니다.
  for (let y = 450; y <= 1030; y += 55) {
    for (let x = 610; x <= 1790; x += 70) {
      if (!isBlocked(x, y, PLAYER_R + 10)) return { x, y };
    }
  }
  return { x: 1200, y: 760 };
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
      eliminated: p.eliminated,
      moving: !!p.moving,
      facing: p.facing || 'down'
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
function resetPlayer(p, idx) {
  const s = spawnPoint(idx);
  Object.assign(p, {
    x: s.x, y: s.y,
    role: 'runner', frozen: false, eliminated: false,
    input: { up: false, down: false, left: false, right: false },
    moving: false,
    facing: 'down',
    lastFreezeAt: 0
  });
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
    resetPlayer(p, idx);
    p.role = taggerIds.has(p.id) ? 'tagger' : 'runner';
    io.to(p.socketId).emit('role', { role: p.role });
  });
  pushActivity(room, `게임 시작! 술래 ${taggerCount}명, 도망팀 ${players.length - taggerCount}명`, 'start');
  io.to(room.code).emit('gameStarted', { endsAt: room.endsAt, taggerCount });
  emitState(room);
  return { ok: true };
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, version: '2.0' }));
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
      resetPlayer(p, idx);
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
    const s = spawnPoint(idx);
    const player = {
      id: socket.id,
      socketId: socket.id,
      name: sanitizeName(nickname),
      x: s.x, y: s.y,
      role: 'runner', frozen: false, eliminated: false,
      input: { up: false, down: false, left: false, right: false },
      moving: false,
      facing: 'down',
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
    p.moving = p.input.up || p.input.down || p.input.left || p.input.right;
    // 마지막으로 누른 축을 기준으로 캐릭터가 바라보는 방향을 저장합니다.
    if (p.input.left && !p.input.right) p.facing = 'left';
    else if (p.input.right && !p.input.left) p.facing = 'right';
    else if (p.input.up && !p.input.down) p.facing = 'up';
    else if (p.input.down && !p.input.up) p.facing = 'down';
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
      p.moving = false;
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
      if (p.eliminated || p.frozen) {
        p.moving = false;
        continue;
      }
      const i = p.input || {};
      let dx = (i.right ? 1 : 0) - (i.left ? 1 : 0);
      let dy = (i.down ? 1 : 0) - (i.up ? 1 : 0);
      if (!dx && !dy) {
        p.moving = false;
        continue;
      }
      p.moving = true;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const speed = p.role === 'tagger' ? SPEED_TAGGER : SPEED_RUNNER;
      const nx = p.x + dx * speed * DT;
      const ny = p.y + dy * speed * DT;
      if (!isBlocked(nx, p.y)) p.x = nx;
      if (!isBlocked(p.x, ny)) p.y = ny;
    }

    // 같은 편이 얼어 있는 친구와 접촉하면 자동 구출.
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

    // 얼음 상태의 도망자는 안전. 일반 도망자에게 술래가 닿으면 아웃.
    const taggers = players.filter(p => p.role === 'tagger' && !p.eliminated);
    for (const t of taggers) {
      for (const r of runners) {
        if (r.eliminated || r.frozen) continue;
        if (Math.hypot(t.x - r.x, t.y - r.y) <= TAG_DISTANCE) {
          r.eliminated = true;
          r.moving = false;
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

// 6시간 동안 비어 있는 오래된 방 정리.
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.createdAt < cutoff && room.players.size === 0) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => console.log(`School Ice Tag V2 running on http://localhost:${PORT}`));
