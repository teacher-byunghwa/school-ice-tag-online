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
  pingTimeout: 25000,
  cors: { origin: true, credentials: false }
});

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;
const BROADCAST_RATE = 15;
const DT = 1 / TICK_RATE;
const PLAYER_R = 18;
const SPEED_RUNNER = 235;
const SPEED_TAGGER = 248;
const SPEED_GHOST = 220;
const RESCUE_DISTANCE = 50;
const TAG_DISTANCE = 38;
const FREEZE_COOLDOWN_MS = 900;
const JUMP_DURATION_MS = 650;
const JUMP_COOLDOWN_MS = 950;
const BOOST_DURATION_MS = 10000;
const ITEM_LIFETIME_MS = 20000;
const TEAM_REVEAL_MS = 10000;
const MAX_PLAYERS = 100;

function randomId(n = 24) { return crypto.randomBytes(n).toString('hex'); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function sanitizeName(v) { return String(v || '').trim().replace(/[<>]/g, '').slice(0, 12) || '학생'; }
function validGender(v) { return v === 'female' ? 'female' : 'male'; }

function makeRoomWalls(x, y, w, h, doorSide = 'bottom') {
  const t = 20;
  const door = 110;
  const arr = [
    { x, y, w, h: t, type: 'wall' },
    { x, y: y + h - t, w, h: t, type: 'wall' },
    { x, y, w: t, h, type: 'wall' },
    { x: x + w - t, y, w: t, h, type: 'wall' }
  ];
  if (doorSide === 'bottom') {
    arr.splice(1, 1,
      { x, y: y + h - t, w: (w - door) / 2, h: t, type: 'wall' },
      { x: x + (w + door) / 2, y: y + h - t, w: (w - door) / 2, h: t, type: 'wall' }
    );
  } else if (doorSide === 'top') {
    arr.splice(0, 1,
      { x, y, w: (w - door) / 2, h: t, type: 'wall' },
      { x: x + (w + door) / 2, y, w: (w - door) / 2, h: t, type: 'wall' }
    );
  }
  return arr;
}

function makeFloor(level) {
  const width = 2200, height = 1400;
  const roomW = 600, roomH = 410;
  const xs = [80, 800, 1520];
  const topY = 70, bottomY = 920;
  const roomNames = {
    1: ['1-1 교실', '1-2 교실', '보건실', '1-3 교실', '로비', '교무실'],
    2: ['2-1 교실', '2-2 교실', '도서관', '2-3 교실', '창의활동실', '영어실'],
    3: ['3-1 교실', '3-2 교실', '과학실', '3-3 교실', '실험실', '준비실']
  }[level];

  const rooms = [];
  const obstacles = [];
  let idx = 0;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const x = xs[col], y = row === 0 ? topY : bottomY;
      const label = roomNames[idx++];
      // 1층 중앙 아래쪽은 출입 로비이므로 완전히 열린 공간으로 둡니다.
      const isLobby = level === 1 && label === '로비';
      rooms.push({ x, y, w: roomW, h: roomH, label, open: isLobby });
      if (!isLobby) obstacles.push(...makeRoomWalls(x, y, roomW, roomH, row === 0 ? 'bottom' : 'top'));

      if (!isLobby) {
        // 교실 안의 작은 책상/책장: 점프로 넘을 수 있습니다.
        obstacles.push({ x: x + 170, y: y + 145, w: 260, h: 50, type: 'desk', jumpable: true, label: '' });
        if (label.includes('도서관')) obstacles.push({ x: x + 70, y: y + 260, w: 460, h: 28, type: 'bookshelf', jumpable: false, label: '' });
      }
    }
  }

  const portals = [];
  if (level > 1) portals.push({ id: `down-${level}`, x: 90, y: 610, w: 170, h: 170, label: `⬇ ${level - 1}층`, targetZone: `floor${level - 1}`, targetX: 350, targetY: 695 });
  if (level < 3) portals.push({ id: `up-${level}`, x: 1940, y: 610, w: 170, h: 170, label: `⬆ ${level + 1}층`, targetZone: `floor${level + 1}`, targetX: 1850, targetY: 695 });
  if (level === 1) portals.push({ id: 'exit-school', x: 995, y: 1120, w: 210, h: 180, label: '🚪 운동장으로', targetZone: 'outdoor', targetX: 1800, targetY: 610 });

  return {
    id: `floor${level}`,
    label: `본관 ${level}층`,
    theme: 'indoor', width, height, level, rooms, obstacles, portals
  };
}

const outdoorObstacles = [
  { x: 900, y: 70, w: 1800, h: 420, type: 'building', label: '본관 · 1~3층' },
  { x: 90, y: 320, w: 450, h: 700, type: 'building', label: '체육관' },
  { x: 3060, y: 320, w: 450, h: 700, type: 'building', label: '급식실' },
  { x: 120, y: 1640, w: 430, h: 360, type: 'garden', label: '생태 화단' },
  { x: 1320, y: 1900, w: 350, h: 70, type: 'bench', jumpable: true, label: '벤치' },
  { x: 1920, y: 1900, w: 350, h: 70, type: 'bench', jumpable: true, label: '벤치' },
  // 축구 골대는 점프로 넘을 수 있습니다.
  { x: 750, y: 955, w: 34, h: 260, type: 'goal', jumpable: true, label: '' },
  { x: 2815, y: 955, w: 34, h: 260, type: 'goal', jumpable: true, label: '' },
  // 놀이터 내부는 걸어다닐 수 있고, 둘레의 낮은 울타리만 점프로 넘습니다.
  { x: 2860, y: 1510, w: 620, h: 18, type: 'playgroundFence', jumpable: true, label: '' },
  { x: 2860, y: 2040, w: 620, h: 18, type: 'playgroundFence', jumpable: true, label: '' },
  { x: 2860, y: 1510, w: 18, h: 548, type: 'playgroundFence', jumpable: true, label: '' },
  { x: 3462, y: 1510, w: 18, h: 548, type: 'playgroundFence', jumpable: true, label: '' },
  { x: 3090, y: 1670, w: 160, h: 50, type: 'playEquipment', jumpable: true, label: '' },
  { x: 3260, y: 1830, w: 120, h: 45, type: 'playEquipment', jumpable: true, label: '' },
  // 나무
  ...[
    [670,260],[760,1630],[610,1880],[2810,270],[2940,1220],[620,1220],[2800,1880],[520,1150],[3030,1120],
    [700,560],[2880,560],[1050,540],[2480,540]
  ].map(([x,y]) => ({ x, y, w: 72, h: 72, type: 'tree', label: '' }))
];

const ZONES = {
  outdoor: {
    id: 'outdoor', label: '운동장', theme: 'outdoor', width: 3600, height: 2200,
    obstacles: outdoorObstacles,
    portals: [
      { id: 'enter-school', x: 1690, y: 500, w: 220, h: 120, label: '🚪 본관 들어가기', targetZone: 'floor1', targetX: 1100, targetY: 1040 }
    ],
    areas: [
      { x: 2860, y: 1510, w: 620, h: 548, type: 'playground', label: '놀이터' }
    ]
  },
  floor1: makeFloor(1), floor2: makeFloor(2), floor3: makeFloor(3)
};

function clientMapConfig() {
  const zones = {};
  for (const [id, z] of Object.entries(ZONES)) {
    zones[id] = {
      id, label: z.label, theme: z.theme, width: z.width, height: z.height, level: z.level || 0,
      rooms: z.rooms || [], areas: z.areas || [], obstacles: z.obstacles || [],
      portals: (z.portals || []).map(({ targetZone, targetX, targetY, ...visible }) => visible)
    };
  }
  return { zones, order: ['outdoor','floor1','floor2','floor3'] };
}
const MAP_CONFIG = clientMapConfig();

function zoneLabel(zoneId){ return ZONES[zoneId]?.label || zoneId; }
function describeLocation(zoneId, x, y){
  const z = ZONES[zoneId]; if(!z) return zoneId;
  if(zoneId === 'outdoor'){
    if((z.areas||[]).some(a=>a.type==='playground'&&rectContainsPoint(a,x,y))) return '운동장 놀이터';
    const named = (z.obstacles||[]).find(o=>o.label && rectContainsPoint(o,x,y,18));
    if(named) return `운동장 ${named.label}`;
    if(y < 700) return '운동장 본관 앞';
    if(y > 1640) return '운동장 아래쪽';
    if(x < 850) return '운동장 왼쪽';
    if(x > 2750) return '운동장 오른쪽';
    return '운동장 중앙';
  }
  const room = (z.rooms||[]).find(r=>rectContainsPoint(r,x,y));
  if(room) return `${z.label} ${room.label}`;
  if(x < 500) return `${z.label} 왼쪽 복도`;
  if(x > z.width - 500) return `${z.label} 오른쪽 복도`;
  return `${z.label} 중앙 복도`;
}
function emitAnnouncement(room, text, kind='system'){ io.to(room.code).emit('announcement',{text,kind,popup:false}); }
function emitToTeam(room, role, text, kind='help', exceptId=null){ for(const p of room.players.values()){ if(p.socketId && p.role===role && !p.eliminated && p.id!==exceptId) io.to(p.socketId).emit('announcement',{text,kind,popup:false}); } }

const rooms = new Map();
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 1000; tries++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return randomId(3).toUpperCase();
}

function makeRoom(teacherSocketId, origin) {
  const code = makeCode();
  const room = {
    code,
    teacherSocketId,
    teacherToken: randomId(16),
    state: 'waiting',
    createdAt: Date.now(),
    taggerCount: 3,
    durationSec: 240,
    startedAt: null,
    actionStartsAt: null,
    endsAt: null,
    nextItemDropAt: null,
    roundNumber: 0,
    players: new Map(),
    traces: [],
    items: [],
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
function isBlocked(zoneId, x, y, radius = PLAYER_R, jumping = false) {
  const zone = ZONES[zoneId];
  if (!zone) return true;
  if (x < radius || y < radius || x > zone.width - radius || y > zone.height - radius) return true;
  return zone.obstacles.some(o => !(jumping && o.jumpable) && circleRectCollision(x, y, radius, o));
}
function rectContainsPoint(r, x, y, margin = 0) {
  return x >= r.x - margin && x <= r.x + r.w + margin && y >= r.y - margin && y <= r.y + r.h + margin;
}

function spawnPoint(i) {
  // 대기실에서는 친구들이 운동장 중앙에 함께 모여 있도록 합니다.
  const cols = 14, rows = 8;
  const index = i % (cols * rows);
  const row = Math.floor(index / cols), col = index % cols;
  const baseX = 980 + col * 120;
  const baseY = 790 + row * 105;
  const candidates = [[baseX,baseY],[baseX+30,baseY+24],[baseX-30,baseY-24],[baseX+42,baseY-30],[baseX-42,baseY+30]];
  for (const [x,y] of candidates) if (!isBlocked('outdoor', x, y, PLAYER_R + 10, false)) return { zone: 'outdoor', x, y };
  for (let y = 720; y <= 1600; y += 60) for (let x = 850; x <= 2750; x += 70) if (!isBlocked('outdoor',x,y,PLAYER_R+10,false)) return { zone:'outdoor',x,y };
  return { zone:'outdoor', x:1800, y:1200 };
}

function buildTeamStartPoints(role) {
  // 게임 시작 시 두 팀을 운동장 좌우 끝으로 크게 벌립니다.
  // 술래: 운동장 서쪽 / 도망팀: 운동장 동쪽
  const isTagger = role === 'tagger';
  const xMin = isTagger ? 610 : 2480;
  const xMax = isTagger ? 1110 : 3010;
  const yMin = 720, yMax = 1600;
  const xStep = 68, yStep = 78;
  const pts = [];
  for (let row = 0, y = yMin; y <= yMax; row++, y += yStep) {
    // 홀수 줄을 반 칸 밀어서 서로 겹쳐 보이지 않게 배치합니다.
    const offset = row % 2 ? Math.floor(xStep / 2) : 0;
    for (let x = xMin + offset; x <= xMax; x += xStep) {
      if (!isBlocked('outdoor', x, y, PLAYER_R + 12, false)) pts.push({ zone:'outdoor', x, y });
    }
  }
  return pts;
}

const TAGGER_START_POINTS = buildTeamStartPoints('tagger');
const RUNNER_START_POINTS = buildTeamStartPoints('runner');

function teamStartPoint(role, index) {
  const points = role === 'tagger' ? TAGGER_START_POINTS : RUNNER_START_POINTS;
  if (points.length) return points[index % points.length];
  // 예외 상황에서도 두 팀이 서로 반대편에서 시작하도록 안전한 기본점을 둡니다.
  return role === 'tagger'
    ? { zone:'outdoor', x:720, y:820 }
    : { zone:'outdoor', x:2880, y:820 };
}

function pushActivity(room, text, kind = 'info') {
  room.activity.push({ id: randomId(4), text, kind, t: Date.now() });
  if (room.activity.length > 14) room.activity.shift();
}
function zoneCounts(players) {
  const out = { outdoor:0, floor1:0, floor2:0, floor3:0 };
  for (const p of players) if (!p.eliminated && out[p.zone] !== undefined) out[p.zone]++;
  return out;
}
function roomSummary(room) {
  const players = [...room.players.values()];
  const aliveRunners = players.filter(p => p.role === 'runner' && !p.eliminated).length;
  const aliveTaggers = players.filter(p => p.role === 'tagger' && !p.eliminated).length;
  const frozenRunners = players.filter(p => p.role === 'runner' && !p.eliminated && p.frozen).length;
  const activeRunners = players.filter(p => p.role === 'runner' && !p.eliminated && !p.frozen).length;
  const eliminatedRunners = players.filter(p => p.role === 'runner' && p.eliminated).length;
  const connectedCount = players.filter(p => p.connected).length;
  const scoreboard = players
    .map(p => ({ id:p.id, name:p.name, points:p.points||0, connected:!!p.connected }))
    .sort((a,b) => (b.points-a.points) || a.name.localeCompare(b.name,'ko'));
  return {
    code: room.code, state: room.state, taggerCount: room.taggerCount, durationSec: room.durationSec,
    startedAt: room.startedAt, actionStartsAt: room.actionStartsAt, endsAt: room.endsAt, roundNumber: room.roundNumber||0,
    playerCount: players.length, connectedCount,
    aliveRunners, activeRunners, aliveTaggers, frozenRunners, eliminatedRunners, maxPlayers: MAX_PLAYERS, activity: room.activity,
    zoneCounts: zoneCounts(players), scoreboard,
    teamTaggers: players.filter(p=>p.role==='tagger').map(p=>p.name),
    teamRunners: players.filter(p=>p.role==='runner').map(p=>p.name)
  };
}
function playerPublic(p) {
  return {
    id: p.id, name: p.name, gender: p.gender, zone: p.zone,
    x: Math.round(p.x), y: Math.round(p.y), role: p.role, frozen: p.frozen, eliminated: p.eliminated,
    connected: p.connected, moving: !!p.moving, facing: p.facing || 'down',
    jumpStartedAt: p.jumpStartedAt || 0, jumpEndsAt: p.jumpEndsAt || 0,
    boostCharges: p.boostCharges || 0, boostUntil: p.boostUntil || 0, points: p.points || 0
  };
}
function publicState(room) {
  return {
    serverNow: Date.now(),
    summary: roomSummary(room),
    players: [...room.players.values()].map(playerPublic),
    traces: room.traces.slice(-180),
    items: room.items
  };
}
function emitState(room) {
  io.to(room.code).emit('world', publicState(room));
  if (room.teacherSocketId) io.to(room.teacherSocketId).emit('teacherSummary', roomSummary(room));
}
function emitToPlayer(p, event, data) { if (p?.socketId) io.to(p.socketId).emit(event, data); }

function resetPlayer(p, idx) {
  const s = spawnPoint(idx);
  Object.assign(p, {
    zone: s.zone, x: s.x, y: s.y,
    role: 'runner', frozen: false, eliminated: false,
    input: { up:false,down:false,left:false,right:false }, moving: false, facing: 'down',
    lastFreezeAt: 0, jumpStartedAt: 0, jumpEndsAt: 0, jumpCooldownUntil: 0,
    boostCharges: 0, boostUntil: 0, portalCooldownUntil: 0
  });
}

function startGame(room) {
  if (room.state === 'playing') return { ok:false, error:'이미 게임이 진행 중입니다.' };
  const players = [...room.players.values()];
  if (players.length < 2) return { ok:false, error:'최소 2명이 필요합니다.' };
  const taggerCount = Math.min(Math.max(1, room.taggerCount), Math.max(1, players.length - 1));
  const shuffled = players.slice().sort(() => Math.random() - 0.5);
  const taggerIds = new Set(shuffled.slice(0, taggerCount).map(p => p.id));
  const now = Date.now();
  room.roundNumber = (room.roundNumber || 0) + 1;
  room.state = 'playing';
  room.startedAt = now;
  room.actionStartsAt = now + TEAM_REVEAL_MS;
  room.endsAt = room.actionStartsAt + room.durationSec * 1000;
  room.nextItemDropAt = room.actionStartsAt + Math.floor(room.durationSec * 1000 / 2);
  room.traces = []; room.items = []; room.activity = [];
  let taggerStartIndex = 0;
  let runnerStartIndex = 0;
  players.forEach((p, idx) => {
    resetPlayer(p, idx);
    p.role = taggerIds.has(p.id) ? 'tagger' : 'runner';
    const start = teamStartPoint(p.role, p.role === 'tagger' ? taggerStartIndex++ : runnerStartIndex++);
    p.zone = start.zone;
    p.x = start.x;
    p.y = start.y;
    p.facing = p.role === 'tagger' ? 'right' : 'left';
    emitToPlayer(p, 'role', { role:p.role });
  });
  const taggers = players.filter(p=>p.role==='tagger').map(p=>p.name);
  const runners = players.filter(p=>p.role==='runner').map(p=>p.name);
  const runnerCount = runners.length;
  pushActivity(room, `제 ${room.roundNumber}게임 시작 준비! 술래 ${taggerCount}명, 도망팀 ${runnerCount}명`, 'start');
  io.to(room.code).emit('gameStarted', {
    endsAt:room.endsAt,
    actionStartsAt:room.actionStartsAt,
    revealUntil:room.actionStartsAt,
    roundNumber:room.roundNumber,
    taggerCount,
    runnerCount,
    taggers,
    runners
  });
  emitState(room);
  return { ok:true };
}

function endGame(room, reason = 'time') {
  if (room.state !== 'playing') return;
  room.state = 'ended'; room.endsAt = null; room.nextItemDropAt = null; room.actionStartsAt = null;
  const allPlayers = [...room.players.values()];
  const runners = allPlayers.filter(p => p.role === 'runner');
  const survivors = runners.filter(p => !p.eliminated);
  const frozenSurvivors = survivors.filter(p => p.frozen).length;
  const taggerWin = reason === 'all-runners-out' || reason === 'all-runners-frozen';
  const winner = taggerWin ? 'taggers' : (survivors.length > 0 ? 'runners' : 'taggers');
  const winningRole = winner === 'runners' ? 'runner' : 'tagger';
  const winners = allPlayers.filter(p => p.role === winningRole);
  winners.forEach(p => { p.points = (p.points || 0) + 1; });
  let message;
  if(reason === 'all-runners-frozen') message = `게임 종료! 살아남은 도망팀 ${frozenSurvivors}명이 모두 얼었습니다.`;
  else if(winner === 'runners') message = `게임 종료! 도망팀 ${survivors.length}명이 살아남았습니다.`;
  else message = '게임 종료! 술래팀이 도망팀을 모두 잡았습니다.';
  pushActivity(room, message, 'end');
  pushActivity(room, `⭐ ${winner === 'runners' ? '도망팀' : '술래팀'} 승리! 승리팀 전원에게 1포인트가 지급되었습니다.`, 'score');
  io.to(room.code).emit('gameEnded', {
    winner,
    survivors:survivors.length,
    frozenSurvivors,
    reason,
    roundNumber:room.roundNumber||1,
    winnerNames:winners.map(p=>p.name),
    scoreboard:roomSummary(room).scoreboard
  });
  emitState(room);
}

function randomOpenPoint(zoneId) {
  const z = ZONES[zoneId];
  for (let tries = 0; tries < 180; tries++) {
    let x, y;
    if (zoneId === 'outdoor') {
      x = 650 + Math.random() * 2250;
      y = 650 + Math.random() * 1250;
    } else {
      x = 70 + Math.random() * (z.width - 140);
      y = 70 + Math.random() * (z.height - 140);
    }
    if (isBlocked(zoneId, x, y, 28, false)) continue;
    if ((z.portals || []).some(p => rectContainsPoint(p, x, y, 55))) continue;
    return { x:Math.round(x), y:Math.round(y) };
  }
  return zoneId === 'outdoor' ? {x:1800,y:1450} : {x:1100,y:700};
}

function spawnItemBatch(room) {
  const activePlayers = [...room.players.values()].filter(p => !p.eliminated);
  if (!activePlayers.length) return;
  const occupied = [...new Set(activePlayers.map(p => p.zone))];
  const count = clamp(Math.ceil(activePlayers.length / 8), 4, 12);
  const newItems = [];
  const zoneQueue = occupied.slice();
  while (zoneQueue.length < count) zoneQueue.push(occupied[Math.floor(Math.random() * occupied.length)] || 'outdoor');
  for (let i = 0; i < count; i++) {
    const zone = zoneQueue[i % zoneQueue.length];
    const pos = randomOpenPoint(zone);
    const droppedAt = Date.now();
    const item = { id:randomId(5), zone, x:pos.x, y:pos.y, type:'bung-eoppang', droppedAt, expiresAt:droppedAt + ITEM_LIFETIME_MS };
    room.items.push(item); newItems.push(item);
  }
  if (room.items.length > 50) room.items.splice(0, room.items.length - 50);
  pushActivity(room, `🐟 붕어빵 아이템 ${newItems.length}개가 나타났습니다! 20초 동안 먹을 수 있습니다.`, 'item');
  io.to(room.code).emit('itemsDropped', { count:newItems.length, lifetimeSec:20 });
}

function applyPortal(p, now) {
  if (now < (p.portalCooldownUntil || 0)) return;
  const z = ZONES[p.zone];
  const portal = (z.portals || []).find(pt => rectContainsPoint(pt, p.x, p.y, 0));
  if (!portal) return;
  p.zone = portal.targetZone; p.x = portal.targetX; p.y = portal.targetY;
  p.portalCooldownUntil = now + 1100;
  p.input = {up:false,down:false,left:false,right:false}; p.moving = false;
  emitToPlayer(p, 'zoneChanged', { zone:p.zone, label:ZONES[p.zone].label });
}

app.get('/join/:code', (req,res) => {
  res.set('Cache-Control','no-store');
  res.sendFile(path.join(__dirname,'public','index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { etag:true, maxAge:0 }));
app.get('/health', (_req,res) => res.json({ ok:true, rooms:rooms.size, version:'10.0' }));
app.get('/api/qr/:code', async (req,res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).json({error:'room not found'});
  res.set('Cache-Control','no-store');
  const base = String(room.origin || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  // path와 query에 방 코드를 모두 넣어 모바일 QR 브라우저/리다이렉트에서도 학생 입장을 안정적으로 복구합니다.
  const joinUrl = `${base}/join/${encodeURIComponent(room.code)}?room=${encodeURIComponent(room.code)}`;
  try {
    const dataUrl = await QRCode.toDataURL(joinUrl, { margin:1, width:420, errorCorrectionLevel:'M' });
    res.json({dataUrl,joinUrl});
  } catch (_) { res.status(500).json({error:'qr failed'}); }
});

io.on('connection', socket => {
  socket.on('createRoom', ({origin} = {}, cb = () => {}) => {
    const room = makeRoom(socket.id, origin || '');
    socket.join(room.code); socket.data.teacher = {roomCode:room.code, token:room.teacherToken};
    cb({ok:true, roomCode:room.code, teacherToken:room.teacherToken, summary:roomSummary(room), mapConfig:MAP_CONFIG});
  });

  socket.on('teacherResume', ({roomCode,token} = {}, cb = () => {}) => {
    const room = rooms.get(String(roomCode || '').toUpperCase());
    if (!room || room.teacherToken !== token) return cb({ok:false,error:'교사 인증에 실패했습니다.'});
    room.teacherSocketId = socket.id; socket.join(room.code); socket.data.teacher = {roomCode:room.code,token};
    cb({ok:true,summary:roomSummary(room),mapConfig:MAP_CONFIG}); emitState(room);
  });

  socket.on('teacherSettings', ({roomCode,token,taggerCount,durationSec} = {}, cb = () => {}) => {
    const room = rooms.get(String(roomCode || '').toUpperCase());
    if (!room || room.teacherToken !== token) return cb({ok:false,error:'교사 인증 실패'});
    if (room.state !== 'waiting') return cb({ok:false,error:'대기실에서만 설정할 수 있습니다.'});
    room.taggerCount = clamp(Number(taggerCount) || 1, 1, 20);
    room.durationSec = clamp(Number(durationSec) || 240, 60, 900);
    pushActivity(room, `교사 설정: 술래 ${room.taggerCount}명 / ${Math.round(room.durationSec/60)}분`, 'info');
    cb({ok:true,summary:roomSummary(room)}); emitState(room);
  });

  socket.on('startGame', ({roomCode,token} = {}, cb = () => {}) => {
    const room = rooms.get(String(roomCode || '').toUpperCase());
    if (!room || room.teacherToken !== token) return cb({ok:false,error:'교사 인증 실패'});
    cb(startGame(room));
  });

  socket.on('resetGame', ({roomCode,token} = {}, cb = () => {}) => {
    const room = rooms.get(String(roomCode || '').toUpperCase());
    if (!room || room.teacherToken !== token) return cb({ok:false,error:'교사 인증 실패'});
    room.state='waiting'; room.startedAt=null; room.actionStartsAt=null; room.endsAt=null; room.nextItemDropAt=null; room.traces=[]; room.items=[]; room.activity=[];
    [...room.players.values()].forEach((p,idx) => { resetPlayer(p,idx); emitToPlayer(p,'role',{role:'runner'}); });
    pushActivity(room,'새 게임 대기실로 돌아왔습니다.','info'); cb({ok:true}); emitState(room);
  });

  socket.on('joinRoom', ({roomCode,nickname,gender} = {}, cb = () => {}) => {
    const code = String(roomCode || '').toUpperCase(); const room = rooms.get(code);
    if (!room) return cb({ok:false,error:'방을 찾을 수 없습니다.'});
    if (room.state !== 'waiting') return cb({ok:false,error:'이미 게임이 시작되었습니다.'});
    if (room.players.size >= MAX_PLAYERS) return cb({ok:false,error:'방 정원이 찼습니다.'});
    const idx = room.players.size; const s = spawnPoint(idx);
    const player = {
      id:randomId(8), resumeToken:randomId(16), socketId:socket.id, connected:true, disconnectedAt:null,
      name:sanitizeName(nickname), gender:validGender(gender), zone:s.zone, x:s.x, y:s.y,
      role:'runner', frozen:false, eliminated:false, input:{up:false,down:false,left:false,right:false}, moving:false, facing:'down',
      lastFreezeAt:0, jumpStartedAt:0, jumpEndsAt:0, jumpCooldownUntil:0, boostCharges:0, boostUntil:0, portalCooldownUntil:0, points:0
    };
    room.players.set(player.id,player); socket.join(code); socket.data.player={roomCode:code,playerId:player.id};
    pushActivity(room,`${player.name}님이 입장했습니다.`,'join');
    cb({ok:true,playerId:player.id,playerToken:player.resumeToken,player:playerPublic(player),summary:roomSummary(room),mapConfig:MAP_CONFIG,state:publicState(room)});
    emitState(room);
  });

  // 화면 꺼짐/브라우저 재접속 후에도 같은 캐릭터를 되찾습니다.
  socket.on('playerResume', ({roomCode,playerToken} = {}, cb = () => {}) => {
    const code = String(roomCode || '').toUpperCase(); const room = rooms.get(code);
    if (!room) return cb({ok:false,error:'게임방이 종료되었거나 서버가 재시작되었습니다.'});
    const p = [...room.players.values()].find(x => x.resumeToken === playerToken);
    if (!p) return cb({ok:false,error:'기존 캐릭터를 찾지 못했습니다.'});
    p.socketId=socket.id; p.connected=true; p.disconnectedAt=null; p.input={up:false,down:false,left:false,right:false}; p.moving=false;
    socket.join(code); socket.data.player={roomCode:code,playerId:p.id};
    cb({ok:true,playerId:p.id,player:playerPublic(p),summary:roomSummary(room),mapConfig:MAP_CONFIG,state:publicState(room)});
    emitState(room);
  });

  socket.on('input', data => {
    const pd=socket.data.player; if(!pd)return; const room=rooms.get(pd.roomCode); if(!room)return;
    const p=room.players.get(pd.playerId); if(!p||p.frozen)return;
    if(room.state!=='playing' && !(room.state==='ended' && p.eliminated)) return;
    if(room.state==='playing' && room.actionStartsAt && Date.now() < room.actionStartsAt) return;
    p.input={up:!!data?.up,down:!!data?.down,left:!!data?.left,right:!!data?.right};
    p.moving=p.input.up||p.input.down||p.input.left||p.input.right;
    if(p.input.left&&!p.input.right)p.facing='left'; else if(p.input.right&&!p.input.left)p.facing='right'; else if(p.input.up&&!p.input.down)p.facing='up'; else if(p.input.down&&!p.input.up)p.facing='down';
  });

  socket.on('freezeToggle', () => {
    const pd=socket.data.player; if(!pd)return; const room=rooms.get(pd.roomCode); if(!room||room.state!=='playing')return;
    if(room.actionStartsAt && Date.now() < room.actionStartsAt) return;
    const p=room.players.get(pd.playerId); if(!p||p.eliminated||p.role!=='runner')return;
    const now=Date.now(); if(now-p.lastFreezeAt<FREEZE_COOLDOWN_MS)return; p.lastFreezeAt=now;
    if(!p.frozen){ p.frozen=true;p.moving=false;p.input={up:false,down:false,left:false,right:false};pushActivity(room,`${p.name}님이 얼음!`,'freeze');emitToPlayer(p,'frozen',{frozen:true});emitAnnouncement(room,`❄️ ${p.name}님이 얼음이 되었습니다.`, 'freeze'); }
  });

  socket.on('jump', () => {
    const pd=socket.data.player; if(!pd)return; const room=rooms.get(pd.roomCode); if(!room)return;
    const p=room.players.get(pd.playerId); if(!p||p.frozen)return;
    if(room.state!=='playing' && !(room.state==='ended' && p.eliminated)) return;
    if(room.state==='playing' && room.actionStartsAt && Date.now() < room.actionStartsAt) return; const now=Date.now(); if(now<(p.jumpCooldownUntil||0))return;
    p.jumpStartedAt=now; p.jumpEndsAt=now+JUMP_DURATION_MS; p.jumpCooldownUntil=now+JUMP_COOLDOWN_MS; emitToPlayer(p,'jumped',{endsAt:p.jumpEndsAt});
  });

  socket.on('useBoost', () => {
    const pd=socket.data.player; if(!pd)return; const room=rooms.get(pd.roomCode); if(!room||room.state!=='playing')return;
    if(room.actionStartsAt && Date.now() < room.actionStartsAt) return;
    const p=room.players.get(pd.playerId); if(!p||p.eliminated||p.frozen||p.boostCharges<=0)return; const now=Date.now();
    if(now<(p.boostUntil||0))return;
    p.boostCharges--; p.boostUntil=now+BOOST_DURATION_MS; emitToPlayer(p,'boostState',{charges:p.boostCharges,boostUntil:p.boostUntil});
    pushActivity(room,`⚡ ${p.name}님이 10초 부스터를 사용했습니다!`,'boost');
  });

  socket.on('requestHelp', () => {
    const pd=socket.data.player; if(!pd) return; const room=rooms.get(pd.roomCode); if(!room||room.state!=='playing') return;
    if(room.actionStartsAt && Date.now() < room.actionStartsAt) return;
    const p=room.players.get(pd.playerId); if(!p||p.eliminated||p.role!=='runner'||!p.frozen) return;
    const loc=describeLocation(p.zone,p.x,p.y);
    const text=`🆘 ${p.name}님이 ${loc}에서 살려달라고 외치고 있어요!`;
    pushActivity(room, text, 'help');
    emitToTeam(room,'runner',text,'help',p.id);
    emitToPlayer(p,'announcement',{text:`🆘 같은 팀에게 위치를 알렸어요! ${loc}`,kind:'help',popup:false});
    emitState(room);
  });

  socket.on('disconnect', () => {
    const pd=socket.data.player;
    if(pd){ const room=rooms.get(pd.roomCode); const p=room?.players.get(pd.playerId); if(p){ p.connected=false;p.disconnectedAt=Date.now();p.socketId=null;p.input={up:false,down:false,left:false,right:false};p.moving=false;pushActivity(room,`${p.name}님 연결이 잠시 끊겼습니다. 복귀를 기다리는 중입니다.`,'leave');emitState(room); } }
    const td=socket.data.teacher; if(td){ const room=rooms.get(td.roomCode); if(room&&room.teacherSocketId===socket.id)room.teacherSocketId=null; }
  });
});

let broadcastCounter=0;
setInterval(() => {
  const now=Date.now();
  for(const room of rooms.values()){
    // 붕어빵은 등장 후 정확히 20초가 지나면 게임 상태와 관계없이 사라집니다.
    if(room.items.length) room.items = room.items.filter(item => !item.expiresAt || item.expiresAt > now);
    if(room.state==='ended'){
      const ghosts=[...room.players.values()].filter(p=>p.eliminated);
      for(const p of ghosts){
        const i=p.input||{};let dx=(i.right?1:0)-(i.left?1:0),dy=(i.down?1:0)-(i.up?1:0);
        if(dx||dy){
          p.moving=true;const len=Math.hypot(dx,dy)||1;dx/=len;dy/=len;
          const jumping=now<(p.jumpEndsAt||0);const nx=p.x+dx*SPEED_GHOST*DT,ny=p.y+dy*SPEED_GHOST*DT;
          if(!isBlocked(p.zone,nx,p.y,PLAYER_R,jumping))p.x=nx;
          if(!isBlocked(p.zone,p.x,ny,PLAYER_R,jumping))p.y=ny;
        }else p.moving=false;
        applyPortal(p,now);
      }
      continue;
    }
    if(room.state!=='playing')continue;
    if(room.actionStartsAt && now < room.actionStartsAt){ continue; }
    if(room.endsAt&&now>=room.endsAt){endGame(room,'time');continue;}
    if(room.nextItemDropAt&&now>=room.nextItemDropAt){ spawnItemBatch(room); room.nextItemDropAt=null; }

    const players=[...room.players.values()];
    for(const p of players){
      if(p.frozen){p.moving=false;continue;}
      const i=p.input||{};let dx=(i.right?1:0)-(i.left?1:0),dy=(i.down?1:0)-(i.up?1:0);
      if(dx||dy){
        p.moving=true;const len=Math.hypot(dx,dy)||1;dx/=len;dy/=len;
        const jumping=now<(p.jumpEndsAt||0); const boosted=now<(p.boostUntil||0);
        let speed=p.eliminated?SPEED_GHOST:(p.role==='tagger'?SPEED_TAGGER:SPEED_RUNNER); if(boosted&&!p.eliminated)speed*=2;
        const nx=p.x+dx*speed*DT, ny=p.y+dy*speed*DT;
        if(!isBlocked(p.zone,nx,p.y,PLAYER_R,jumping))p.x=nx;
        if(!isBlocked(p.zone,p.x,ny,PLAYER_R,jumping))p.y=ny;
      }else p.moving=false;
      applyPortal(p,now);
    }

    // 붕어빵 줍기: 술래와 도망팀 모두 사용합니다.
    for(const p of players.filter(x=>!x.eliminated)){
      for(let k=room.items.length-1;k>=0;k--){const item=room.items[k];if(item.zone!==p.zone)continue;if(Math.hypot(item.x-p.x,item.y-p.y)<=42){room.items.splice(k,1);p.boostCharges++;emitToPlayer(p,'itemCollected',{charges:p.boostCharges});pushActivity(room,`🐟 ${p.name}님이 붕어빵을 먹었습니다!`,'item');}}
    }

    const runners=players.filter(p=>p.role==='runner'&&!p.eliminated);
    const activeRunners=runners.filter(p=>!p.frozen), frozenRunners=runners.filter(p=>p.frozen);
    for(const a of activeRunners){for(const f of frozenRunners){if(!f.frozen||a.id===f.id||a.zone!==f.zone)continue;if(Math.hypot(a.x-f.x,a.y-f.y)<=RESCUE_DISTANCE){f.frozen=false;pushActivity(room,`${a.name}님이 ${f.name}님을 구출했습니다!`,'rescue');emitToPlayer(f,'frozen',{frozen:false});emitAnnouncement(room,`🟢 ${a.name}님이 ${f.name}님을 구출했습니다!`, 'rescue');}}}

    const taggers=players.filter(p=>p.role==='tagger'&&!p.eliminated);
    for(const t of taggers){for(const r of runners){if(r.eliminated||r.frozen||t.zone!==r.zone)continue;if(Math.hypot(t.x-r.x,t.y-r.y)<=TAG_DISTANCE){r.eliminated=true;r.moving=false;r.input={up:false,down:false,left:false,right:false};room.traces.push({id:randomId(4),zone:r.zone,x:Math.round(r.x),y:Math.round(r.y),name:r.name,gender:r.gender,at:now});pushActivity(room,`${r.name}님이 아웃되어 유령이 되었습니다.`,'out');emitToPlayer(r,'eliminated',{by:t.name});emitAnnouncement(room,`💥 ${r.name}님이 잡혀 유령이 되었습니다.`, 'out');}}}
    const survivingRunners=runners.filter(p=>!p.eliminated);
    if(survivingRunners.length===0) endGame(room,'all-runners-out');
    else if(survivingRunners.every(p=>p.frozen)) endGame(room,'all-runners-frozen');
  }
  broadcastCounter++;
  if(broadcastCounter>=Math.max(1,Math.round(TICK_RATE/BROADCAST_RATE))){broadcastCounter=0;for(const room of rooms.values())if(room.state==='playing'||room.state==='waiting'||room.state==='ended')emitState(room);}
},1000/TICK_RATE);

server.listen(PORT,()=>console.log(`School Ice Tag V10 listening on ${PORT}`));
