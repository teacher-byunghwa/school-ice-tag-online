const socket = io({ transports: ['websocket', 'polling'] });
const screens = [...document.querySelectorAll('.screen')];
const $ = s => document.querySelector(s);
let mode = 'home';
let roomCode = null;
let teacherToken = null;
let me = { id: null, role: 'runner', frozen: false, eliminated: false };
let world = null;
let input = { up:false,down:false,left:false,right:false };
let lastInputSent = '';
const renderPositions = new Map();

function show(id){ screens.forEach(s => s.classList.toggle('active', s.id === id)); mode = id; }
function cleanCode(v){ return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5); }

document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => show(b.dataset.back));
$('#studentJoinOpen').onclick = () => show('join');

$('#teacherCreate').onclick = () => {
  socket.emit('createRoom', { origin: location.origin }, async (res) => {
    if (!res?.ok) return alert(res?.error || '방 생성 실패');
    roomCode = res.roomCode; teacherToken = res.teacherToken;
    sessionStorage.setItem('iceTeacher', JSON.stringify({ roomCode, teacherToken }));
    $('#roomCodeText').textContent = roomCode;
    show('teacher');
    updateTeacherSummary(res.summary);
    try {
      const qr = await fetch(`/api/qr/${roomCode}`).then(r => r.json());
      $('#qrImage').src = qr.dataUrl; $('#joinUrl').textContent = qr.joinUrl;
    } catch(e) {}
  });
};

$('#saveSettings').onclick = () => {
  socket.emit('teacherSettings', {
    roomCode, token: teacherToken,
    taggerCount: Number($('#taggerCount').value),
    durationSec: Number($('#durationSec').value)
  }, res => {
    $('#teacherMessage').textContent = res?.ok ? '설정이 저장되었습니다.' : (res?.error || '저장 실패');
  });
};
$('#startGame').onclick = () => {
  socket.emit('teacherSettings', { roomCode, token: teacherToken, taggerCount:Number($('#taggerCount').value), durationSec:Number($('#durationSec').value) }, () => {
    socket.emit('startGame', { roomCode, token: teacherToken }, res => {
      $('#teacherMessage').textContent = res?.ok ? '게임이 시작되었습니다.' : (res?.error || '시작 실패');
    });
  });
};
$('#resetGame').onclick = () => socket.emit('resetGame', { roomCode, token: teacherToken }, res => {
  $('#teacherMessage').textContent = res?.ok ? '대기실로 초기화했습니다.' : (res?.error || '초기화 실패');
});

$('#joinCode').oninput = e => e.target.value = cleanCode(e.target.value);
$('#joinBtn').onclick = joinStudent;
$('#nickname').addEventListener('keydown', e => { if(e.key === 'Enter') joinStudent(); });
function joinStudent(){
  const code = cleanCode($('#joinCode').value);
  const nickname = $('#nickname').value.trim();
  $('#joinError').textContent = '';
  if(code.length < 5) return $('#joinError').textContent = '5자리 방 코드를 입력하세요.';
  if(!nickname) return $('#joinError').textContent = '닉네임을 입력하세요.';
  socket.emit('joinRoom', { roomCode: code, nickname }, res => {
    if(!res?.ok) return $('#joinError').textContent = res?.error || '입장 실패';
    roomCode = code; me.id = res.playerId; show('player');
    setStatus('교사가 게임을 시작할 때까지 기다려 주세요.', true);
  });
}

const params = new URLSearchParams(location.search);
if(params.get('room')) { $('#joinCode').value = cleanCode(params.get('room')); show('join'); setTimeout(()=>$('#nickname').focus(),100); }

const resume = sessionStorage.getItem('iceTeacher');
if(resume && !params.get('room')) {
  try {
    const r = JSON.parse(resume);
    socket.on('connect', () => {
      if (mode !== 'home') return;
      socket.emit('teacherResume', { roomCode:r.roomCode, token:r.teacherToken }, async res => {
        if(!res?.ok) return;
        roomCode=r.roomCode; teacherToken=r.teacherToken; $('#roomCodeText').textContent=roomCode; show('teacher'); updateTeacherSummary(res.summary);
        try { const qr = await fetch(`/api/qr/${roomCode}`).then(x=>x.json()); $('#qrImage').src=qr.dataUrl; $('#joinUrl').textContent=qr.joinUrl; } catch(e){}
      });
    });
  } catch(e){}
}

function setStatus(text, showIt){ const el=$('#statusOverlay'); el.textContent=text; el.classList.toggle('hidden', !showIt); }
function updateRoleBadge(){
  const b=$('#roleBadge');
  if(me.eliminated){ b.textContent='👻 관전 중'; b.style.background='rgba(50,50,60,.85)'; return; }
  if(me.role==='tagger'){ b.textContent='🔴 술래'; b.style.background='rgba(180,24,32,.88)'; }
  else if(me.frozen){ b.textContent='❄️ 얼음'; b.style.background='rgba(37,132,190,.88)'; }
  else { b.textContent='🔵 도망팀'; b.style.background='rgba(24,103,180,.88)'; }
}

socket.on('role', ({role}) => { me.role=role; me.frozen=false; me.eliminated=false; updateRoleBadge(); });
socket.on('frozen', ({frozen}) => { me.frozen=frozen; updateRoleBadge(); if(frozen) pulseStatus('❄️ 얼음! 친구가 가까이 오면 풀립니다.', 800); else pulseStatus('🟢 구출되었습니다!', 700); });
socket.on('eliminated', ({by}) => { me.eliminated=true; me.frozen=false; input={up:false,down:false,left:false,right:false}; sendInput(true); updateRoleBadge(); setStatus(`아웃! ${by ? by+'에게 잡혔습니다. ' : ''}이제 다른 친구들의 게임을 관전할 수 있어요.`, true); });
socket.on('gameStarted', () => { me.eliminated=false; me.frozen=false; renderPositions.clear(); setStatus('', false); updateRoleBadge(); });
socket.on('gameEnded', ({winner,survivors}) => {
  const msg = winner==='runners' ? `🎉 도망팀 승리! ${survivors}명 생존` : '🏆 술래팀 승리! 모두 잡았습니다.';
  if(mode==='player') setStatus(msg, true);
});
socket.on('teacherSummary', updateTeacherSummary);
socket.on('world', data => {
  world=data;
  for(const p of data.players || []){
    const r = renderPositions.get(p.id);
    if(!r) renderPositions.set(p.id,{x:p.x,y:p.y});
  }
  if(mode==='teacher') updateTeacherSummary(data.summary);
  updateTopbar(); updateActivity();
});
function updateTeacherSummary(s){ if(!s) return; $('#teacherPlayers').textContent=s.playerCount; $('#teacherAlive').textContent=s.aliveRunners; $('#startGame').disabled=s.state==='playing'; $('#saveSettings').disabled=s.state!=='waiting'; }
function updateTopbar(){ if(!world) return; const s=world.summary; const left=s.endsAt?Math.max(0,Math.ceil((s.endsAt-Date.now())/1000)):s.durationSec; const txt=`방 ${s.code} · 접속 ${s.playerCount}/${s.maxPlayers} · 생존 ${s.aliveRunners} · ⏱ ${fmt(left)}`; $('#teacherTopbar').textContent=txt; $('#playerTopbar').textContent=txt; }
function updateActivity(){ if(mode!=='teacher'||!world) return; $('#activity').innerHTML=world.summary.activity.slice().reverse().map(a=>`<div class="${a.kind}">${escapeHtml(a.text)}</div>`).join(''); }
function fmt(sec){ return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`; }
function escapeHtml(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function pulseStatus(text,ms){ setStatus(text,true); setTimeout(()=>{ if(!me.eliminated) setStatus('',false); },ms); }

// Keyboard controls
const keyMap={ArrowUp:'up',KeyW:'up',ArrowDown:'down',KeyS:'down',ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right'};
addEventListener('keydown',e=>{
  if(mode!=='player') return;
  if(keyMap[e.code]){ e.preventDefault(); input[keyMap[e.code]]=true; sendInput(); }
  if(e.code==='KeyI' && !e.repeat){ e.preventDefault(); doFreeze(); }
});
addEventListener('keyup',e=>{ if(mode!=='player') return; if(keyMap[e.code]){ e.preventDefault(); input[keyMap[e.code]]=false; sendInput(); } });
function sendInput(force=false){ const s=JSON.stringify(input); if(!force && s===lastInputSent)return; lastInputSent=s; socket.emit('input',input); }
function doFreeze(){ if(mode==='player' && me.role==='runner' && !me.frozen && !me.eliminated) socket.emit('freezeToggle'); }

// Tablet / mobile controls
// Long-press copy/search/context menus are blocked, and pointer capture keeps a held direction stable.
const mobileControls = $('#mobileControls');
['contextmenu','selectstart','dragstart'].forEach(type => {
  mobileControls.addEventListener(type, e => e.preventDefault());
  $('#player').addEventListener(type, e => {
    if(e.target.closest?.('#mobileControls')) e.preventDefault();
  });
});
mobileControls.addEventListener('touchstart', e => e.preventDefault(), { passive:false });
mobileControls.addEventListener('touchmove', e => e.preventDefault(), { passive:false });

$('#iceBtn').addEventListener('pointerdown', e=>{
  e.preventDefault(); e.stopPropagation();
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch(_) {}
  doFreeze();
});

const pointerToKey = new Map();
function releasePointer(pointerId){
  const key = pointerToKey.get(pointerId);
  if(!key) return;
  pointerToKey.delete(pointerId);
  const stillHeld = [...pointerToKey.values()].includes(key);
  if(!stillHeld){ input[key]=false; sendInput(); }
}
document.querySelectorAll('[data-key]').forEach(btn=>{
  const k=btn.dataset.key;
  btn.addEventListener('pointerdown', e=>{
    e.preventDefault(); e.stopPropagation();
    try { btn.setPointerCapture(e.pointerId); } catch(_) {}
    pointerToKey.set(e.pointerId,k);
    input[k]=true;
    sendInput();
  });
  const up=e=>{ e.preventDefault(); e.stopPropagation(); releasePointer(e.pointerId); };
  btn.addEventListener('pointerup',up);
  btn.addEventListener('pointercancel',up);
  btn.addEventListener('lostpointercapture',e=>releasePointer(e.pointerId));
});

// If the browser/tab loses focus while a key is held, stop safely.
function clearAllInput(){
  pointerToKey.clear();
  input={up:false,down:false,left:false,right:false};
  sendInput(true);
}
addEventListener('blur', clearAllInput);
document.addEventListener('visibilitychange',()=>{ if(document.hidden) clearAllInput(); });

function resizeCanvas(c){
  const dpr=Math.min(devicePixelRatio||1,2);
  const rect=c.getBoundingClientRect();
  const w=Math.max(1,Math.floor(rect.width*dpr)), h=Math.max(1,Math.floor(rect.height*dpr));
  if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
  return {w,h,dpr};
}
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function drawWorld(canvas, isTeacher=false){
  const {w,h,dpr}=resizeCanvas(canvas), ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,w,h);
  if(!world){ctx.fillStyle='#78bf63';ctx.fillRect(0,0,w,h);return;}

  let s, ox, oy;
  if(isTeacher){
    s=Math.min(w/world.map.width,h/world.map.height);
    ox=(w-world.map.width*s)/2;
    oy=(h-world.map.height*s)/2;
  } else {
    // Tablet/phone player view: follow my character instead of shrinking the whole enlarged map.
    const cssW=w/dpr, cssH=h/dpr;
    const visibleWorldW = cssW < 650 ? 820 : 1050;
    const visibleWorldH = cssH < 520 ? 620 : 720;
    s=Math.min(w/visibleWorldW,h/visibleWorldH);
    const myPlayer=world.players.find(p=>p.id===me.id && !p.eliminated) || world.players.find(p=>!p.eliminated) || world.players[0];
    const rp=myPlayer ? (renderPositions.get(myPlayer.id)||myPlayer) : {x:world.map.width/2,y:world.map.height/2};
    ox=w/2-rp.x*s;
    oy=h/2-rp.y*s;
    if(world.map.width*s>w) ox=clamp(ox,w-world.map.width*s,0); else ox=(w-world.map.width*s)/2;
    if(world.map.height*s>h) oy=clamp(oy,h-world.map.height*s,0); else oy=(h-world.map.height*s)/2;
  }

  ctx.save();
  ctx.translate(ox,oy);
  ctx.scale(s,s);
  drawMap(ctx,world);
  drawTraces(ctx,world);
  drawPlayers(ctx,world,isTeacher);
  ctx.restore();
}

function drawMap(ctx,w){
  const W=w.map.width,H=w.map.height;
  // grass with subtle field stripes
  const grass=ctx.createLinearGradient(0,0,0,H);
  grass.addColorStop(0,'#91d176'); grass.addColorStop(1,'#5dac56');
  ctx.fillStyle=grass; ctx.fillRect(0,0,W,H);
  ctx.globalAlpha=.08;
  for(let x=0;x<W;x+=120){ctx.fillStyle=(x/120)%2===0?'#fff':'#184f31';ctx.fillRect(x,0,60,H);}
  ctx.globalAlpha=1;

  // paved school paths
  ctx.fillStyle='#e8d9bd'; ctx.fillRect(0,250,W,78); ctx.fillRect(1160,220,90,190);
  ctx.fillStyle='#c9b89c'; for(let x=0;x<W;x+=85) ctx.fillRect(x,316,54,4);

  // oversized oval running track
  ctx.save();
  ctx.shadowColor='rgba(36,49,36,.24)'; ctx.shadowBlur=18; ctx.shadowOffsetY=12;
  ctx.fillStyle='#ce775a'; roundRect(ctx,330,390,1740,760,190,true);
  ctx.shadowColor='transparent';
  ctx.fillStyle='#78bd5b'; roundRect(ctx,430,475,1540,590,145,true);
  ctx.restore();
  ctx.strokeStyle='rgba(255,255,255,.9)'; ctx.lineWidth=4;
  for(let m=0;m<4;m++) roundRect(ctx,350+m*22,410+m*22,1700-m*44,720-m*44,175-m*10,false,true);

  // football field
  ctx.strokeStyle='rgba(255,255,255,.88)';ctx.lineWidth=4;ctx.strokeRect(600,510,1200,510);
  ctx.beginPath();ctx.moveTo(1200,510);ctx.lineTo(1200,1020);ctx.stroke();
  ctx.beginPath();ctx.arc(1200,765,80,0,Math.PI*2);ctx.stroke();
  ctx.strokeRect(600,650,120,230);ctx.strokeRect(1680,650,120,230);

  // court area for school feel
  ctx.fillStyle='rgba(84,153,195,.62)';roundRect(ctx,2045,800,285,220,28,true);
  ctx.strokeStyle='rgba(255,255,255,.85)';ctx.lineWidth=4;ctx.strokeRect(2070,825,235,170);

  for(const o of w.obstacles){
    if(o.type==='building') drawBuilding3D(ctx,o);
    else if(o.type==='tree') drawTree3D(ctx,o);
    else if(o.type==='garden') drawGarden(ctx,o);
    else if(o.type==='goal') drawGoal(ctx,o);
    else drawBench(ctx,o);
  }

  // labels painted on ground
  ctx.save(); ctx.fillStyle='rgba(17,46,58,.72)';ctx.font='900 31px sans-serif';ctx.textAlign='left';ctx.fillText('우리 학교 운동장',38,H-34);ctx.restore();
}
function drawBuilding3D(ctx,o){
  const depth=28;
  ctx.save();
  ctx.shadowColor='rgba(20,39,48,.28)';ctx.shadowBlur=20;ctx.shadowOffsetY=16;
  ctx.fillStyle='#b46f52';ctx.fillRect(o.x,o.y,o.w,o.h);
  ctx.shadowColor='transparent';
  // right side / roof gives 2.5D depth
  ctx.fillStyle='#92523f';ctx.beginPath();ctx.moveTo(o.x+o.w,o.y);ctx.lineTo(o.x+o.w+depth,o.y-depth);ctx.lineTo(o.x+o.w+depth,o.y+o.h-depth);ctx.lineTo(o.x+o.w,o.y+o.h);ctx.closePath();ctx.fill();
  ctx.fillStyle='#e5bb8e';ctx.beginPath();ctx.moveTo(o.x,o.y);ctx.lineTo(o.x+depth,o.y-depth);ctx.lineTo(o.x+o.w+depth,o.y-depth);ctx.lineTo(o.x+o.w,o.y);ctx.closePath();ctx.fill();
  ctx.fillStyle='#d59b71';ctx.fillRect(o.x+12,o.y+12,o.w-24,o.h-24);
  const windowW=58, gap=27;
  for(let x=o.x+35;x<o.x+o.w-55;x+=windowW+gap){
    ctx.fillStyle='#75abc9';ctx.fillRect(x,o.y+36,windowW,48);
    ctx.fillStyle='rgba(225,246,255,.55)';ctx.fillRect(x+7,o.y+42,19,36);
    ctx.fillRect(x+32,o.y+42,18,36);
  }
  ctx.fillStyle='#f7efe3';ctx.font='900 26px sans-serif';ctx.textAlign='center';ctx.fillText(o.label,o.x+o.w/2,o.y+o.h-25);
  ctx.restore();
}
function drawTree3D(ctx,o){
  ctx.save();ctx.shadowColor='rgba(20,60,30,.25)';ctx.shadowBlur=12;ctx.shadowOffsetY=10;
  ctx.fillStyle='#6f4b30';ctx.fillRect(o.x+27,o.y+33,14,48);
  ctx.fillStyle='#3b8b48';ctx.beginPath();ctx.arc(o.x+31,o.y+27,36,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#5cab59';ctx.beginPath();ctx.arc(o.x+17,o.y+15,21,0,Math.PI*2);ctx.arc(o.x+47,o.y+15,22,0,Math.PI*2);ctx.fill();ctx.restore();
}
function drawGarden(ctx,o){
  ctx.save();ctx.shadowColor='rgba(0,0,0,.18)';ctx.shadowBlur=12;ctx.shadowOffsetY=9;
  ctx.fillStyle='#a9794f';roundRect(ctx,o.x,o.y,o.w,o.h,18,true);ctx.shadowColor='transparent';
  ctx.fillStyle='#65a650';roundRect(ctx,o.x+12,o.y+12,o.w-24,o.h-24,13,true);
  for(let y=o.y+35;y<o.y+o.h-20;y+=37){for(let x=o.x+35;x<o.x+o.w-20;x+=44){ctx.fillStyle=((x+y)/10)%2>1?'#ffd86d':'#f7a5c2';ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();}}
  ctx.fillStyle='#fff';ctx.font='900 21px sans-serif';ctx.textAlign='center';ctx.fillText(o.label,o.x+o.w/2,o.y+o.h/2+7);ctx.restore();
}
function drawGoal(ctx,o){
  ctx.save();ctx.strokeStyle='#f8fbff';ctx.lineWidth=8;ctx.shadowColor='rgba(0,0,0,.18)';ctx.shadowBlur=7;
  ctx.strokeRect(o.x,o.y,o.w,o.h);ctx.lineWidth=2;ctx.globalAlpha=.55;
  for(let y=o.y+18;y<o.y+o.h;y+=25){ctx.beginPath();ctx.moveTo(o.x,y);ctx.lineTo(o.x+o.w,y);ctx.stroke();}
  ctx.restore();
}
function drawBench(ctx,o){
  ctx.save();ctx.shadowColor='rgba(0,0,0,.22)';ctx.shadowBlur=8;ctx.shadowOffsetY=8;ctx.fillStyle='#9d744c';roundRect(ctx,o.x,o.y,o.w,o.h,10,true);ctx.shadowColor='transparent';ctx.fillStyle='#5c4431';ctx.fillRect(o.x+18,o.y+o.h-2,12,28);ctx.fillRect(o.x+o.w-30,o.y+o.h-2,12,28);ctx.restore();
}
function drawTraces(ctx,w){
  for(const t of w.traces){
    ctx.save();ctx.translate(t.x,t.y);ctx.rotate(-.08);
    ctx.fillStyle='rgba(45,52,63,.24)';ctx.beginPath();ctx.ellipse(0,10,38,17,0,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='rgba(70,76,84,.55)';ctx.lineWidth=7;ctx.lineCap='round';
    ctx.beginPath();ctx.moveTo(-18,4);ctx.lineTo(16,-4);ctx.moveTo(-10,1);ctx.lineTo(-24,-13);ctx.moveTo(8,-2);ctx.lineTo(22,12);ctx.stroke();
    ctx.font='25px sans-serif';ctx.textAlign='center';ctx.fillText('💀',0,-10);
    ctx.font='700 12px sans-serif';ctx.fillStyle='#26323e';ctx.fillText(t.name,0,32);ctx.restore();
  }
}
function idPhase(id){ let n=0; for(let i=0;i<String(id).length;i++) n=(n+String(id).charCodeAt(i)*(i+1))%1000; return n/1000*Math.PI*2; }
function drawPlayers(ctx,w,isTeacher){
  const now=performance.now();
  for(const p of w.players){
    if(p.eliminated) continue;
    const rp=renderPositions.get(p.id)||{x:p.x,y:p.y};
    // Smooth network updates for a more game-like walking motion.
    rp.x += (p.x-rp.x)*.34; rp.y += (p.y-rp.y)*.34;
    renderPositions.set(p.id,rp);
    const isMe=p.id===me.id;
    ctx.save();ctx.translate(rp.x,rp.y);
    drawCharacter(ctx,p,isMe,now);
    ctx.restore();
  }
}
function drawCharacter(ctx,p,isMe,now){
  const moving=!!p.moving && !p.frozen;
  const swing=moving ? Math.sin(now/95+idPhase(p.id))*7 : 0;
  const bob=moving ? Math.abs(Math.sin(now/95+idPhase(p.id)))*2.5 : 0;
  const facing=p.facing||'down';
  const flip=facing==='left'?-1:1;
  const shirt=p.role==='tagger'?'#e64d52':'#3d8cf3';
  const darkShirt=p.role==='tagger'?'#a92934':'#1c5fb4';
  const skin='#ffd2b0';

  // player shadow
  ctx.fillStyle='rgba(15,35,42,.23)';ctx.beginPath();ctx.ellipse(0,23,21,9,0,0,Math.PI*2);ctx.fill();
  if(isMe){ctx.strokeStyle='#ffe15a';ctx.lineWidth=4;ctx.beginPath();ctx.arc(0,0,30,0,Math.PI*2);ctx.stroke();}
  if(p.role==='tagger' && !p.frozen){ctx.strokeStyle='rgba(255,67,75,.38)';ctx.lineWidth=6;ctx.beginPath();ctx.arc(0,0,28+Math.sin(now/150)*2,0,Math.PI*2);ctx.stroke();}

  ctx.translate(0,-bob);
  ctx.scale(flip,1);
  ctx.lineCap='round';

  // legs
  ctx.strokeStyle='#27384c';ctx.lineWidth=8;
  ctx.beginPath();ctx.moveTo(-6,10);ctx.lineTo(-8+swing*.55,24);ctx.stroke();
  ctx.beginPath();ctx.moveTo(6,10);ctx.lineTo(8-swing*.55,24);ctx.stroke();
  ctx.strokeStyle='#f4f5f7';ctx.lineWidth=5;
  ctx.beginPath();ctx.moveTo(-11+swing*.55,26);ctx.lineTo(-4+swing*.55,26);ctx.stroke();
  ctx.beginPath();ctx.moveTo(5-swing*.55,26);ctx.lineTo(13-swing*.55,26);ctx.stroke();

  // arms behind body
  ctx.strokeStyle=skin;ctx.lineWidth=7;
  ctx.beginPath();ctx.moveTo(-11,-4);ctx.lineTo(-18-swing*.55,8);ctx.stroke();
  ctx.beginPath();ctx.moveTo(11,-4);ctx.lineTo(18+swing*.55,8);ctx.stroke();

  // torso / school-style uniform shirt
  ctx.fillStyle=shirt;roundRect(ctx,-14,-8,28,24,8,true);
  ctx.fillStyle=darkShirt;ctx.fillRect(-11,9,22,6);
  ctx.fillStyle='#fff';ctx.beginPath();ctx.moveTo(-5,-8);ctx.lineTo(0,-2);ctx.lineTo(5,-8);ctx.closePath();ctx.fill();

  // head and hair
  ctx.fillStyle=skin;ctx.beginPath();ctx.arc(0,-22,13,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#2d2928';ctx.beginPath();ctx.arc(0,-25,13.5,Math.PI,Math.PI*2);ctx.fill();
  ctx.beginPath();ctx.arc(-10,-20,5,0,Math.PI*2);ctx.arc(10,-20,5,0,Math.PI*2);ctx.fill();

  // face depending direction
  if(facing!=='up'){
    ctx.fillStyle='#242b31';
    const eyeShift=facing==='right'?3:(facing==='left'?-3:0);
    ctx.beginPath();ctx.arc(-4+eyeShift,-21,1.6,0,Math.PI*2);ctx.arc(4+eyeShift,-21,1.6,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='#a85b55';ctx.lineWidth=1.3;ctx.beginPath();ctx.arc(eyeShift,-17,4,.2*Math.PI,.8*Math.PI);ctx.stroke();
  }

  ctx.scale(flip,1); // labels should never be mirrored

  if(p.frozen){
    // translucent ice crystal around the human character
    ctx.save();ctx.globalAlpha=.74;ctx.fillStyle='#9be7ff';ctx.strokeStyle='#f4fdff';ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(0,-47);ctx.lineTo(27,-28);ctx.lineTo(30,15);ctx.lineTo(10,35);ctx.lineTo(-22,29);ctx.lineTo(-31,-8);ctx.lineTo(-20,-37);ctx.closePath();ctx.fill();ctx.stroke();
    ctx.globalAlpha=.95;ctx.font='19px sans-serif';ctx.textAlign='center';ctx.fillText('❄️',0,5);ctx.restore();
  }

  ctx.font='800 13px sans-serif';ctx.textAlign='center';ctx.lineWidth=5;ctx.strokeStyle='rgba(255,255,255,.95)';ctx.strokeText(p.name,0,-51);ctx.fillStyle='#142232';ctx.fillText(p.name,0,-51);
  if(p.role==='tagger'){ctx.font='17px sans-serif';ctx.fillText('👹',0,-66);}
}
function roundRect(ctx,x,y,w,h,r,fill=false,stroke=false){
  ctx.beginPath();
  if(ctx.roundRect) ctx.roundRect(x,y,w,h,r);
  else {ctx.rect(x,y,w,h);}
  if(fill)ctx.fill();if(stroke)ctx.stroke();
}
function frame(){
  if(mode==='teacher') drawWorld($('#teacherCanvas'),true);
  if(mode==='player') drawWorld($('#playerCanvas'),false);
  updateTopbar(); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
