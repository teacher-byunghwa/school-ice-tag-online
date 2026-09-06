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
socket.on('eliminated', ({by}) => { me.eliminated=true; me.frozen=false; input={up:false,down:false,left:false,right:false}; sendInput(); updateRoleBadge(); setStatus(`아웃! ${by ? by+'에게 잡혔습니다. ' : ''}이제 다른 친구들의 게임을 관전할 수 있어요.`, true); });
socket.on('gameStarted', () => { me.eliminated=false; me.frozen=false; setStatus('', false); updateRoleBadge(); });
socket.on('gameEnded', ({winner,survivors}) => {
  const msg = winner==='runners' ? `🎉 도망팀 승리! ${survivors}명 생존` : '🏆 술래팀 승리! 모두 잡았습니다.';
  if(mode==='player') setStatus(msg, true);
});
socket.on('teacherSummary', updateTeacherSummary);
socket.on('world', data => { world=data; if(mode==='teacher') updateTeacherSummary(data.summary); updateTopbar(); updateActivity(); });
function updateTeacherSummary(s){ if(!s) return; $('#teacherPlayers').textContent=s.playerCount; $('#teacherAlive').textContent=s.aliveRunners; $('#startGame').disabled=s.state==='playing'; $('#saveSettings').disabled=s.state!=='waiting'; }
function updateTopbar(){ if(!world) return; const s=world.summary; const left=s.endsAt?Math.max(0,Math.ceil((s.endsAt-Date.now())/1000)):s.durationSec; const txt=`방 ${s.code} · 접속 ${s.playerCount}/${s.maxPlayers} · 생존 ${s.aliveRunners} · ⏱ ${fmt(left)}`; $('#teacherTopbar').textContent=txt; $('#playerTopbar').textContent=txt; }
function updateActivity(){ if(mode!=='teacher'||!world) return; $('#activity').innerHTML=world.summary.activity.slice().reverse().map(a=>`<div class="${a.kind}">${escapeHtml(a.text)}</div>`).join(''); }
function fmt(sec){ return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`; }
function escapeHtml(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function pulseStatus(text,ms){ setStatus(text,true); setTimeout(()=>{ if(!me.eliminated) setStatus('',false); },ms); }

const keyMap={ArrowUp:'up',KeyW:'up',ArrowDown:'down',KeyS:'down',ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right'};
addEventListener('keydown',e=>{
  if(mode!=='player') return;
  if(keyMap[e.code]){ e.preventDefault(); input[keyMap[e.code]]=true; sendInput(); }
  if(e.code==='KeyI' && !e.repeat){ e.preventDefault(); doFreeze(); }
});
addEventListener('keyup',e=>{ if(mode!=='player') return; if(keyMap[e.code]){ e.preventDefault(); input[keyMap[e.code]]=false; sendInput(); } });
function sendInput(){ const s=JSON.stringify(input); if(s===lastInputSent)return; lastInputSent=s; socket.emit('input',input); }
function doFreeze(){ if(mode==='player' && me.role==='runner' && !me.frozen && !me.eliminated) socket.emit('freezeToggle'); }
$('#iceBtn').addEventListener('pointerdown', e=>{e.preventDefault();doFreeze();});
document.querySelectorAll('[data-key]').forEach(btn=>{
  const k=btn.dataset.key;
  const down=e=>{e.preventDefault();input[k]=true;sendInput();};
  const up=e=>{e.preventDefault();input[k]=false;sendInput();};
  btn.addEventListener('pointerdown',down); btn.addEventListener('pointerup',up); btn.addEventListener('pointercancel',up); btn.addEventListener('pointerleave',up);
});

function resizeCanvas(c){ const dpr=Math.min(devicePixelRatio||1,2); const rect=c.getBoundingClientRect(); const w=Math.max(1,Math.floor(rect.width*dpr)), h=Math.max(1,Math.floor(rect.height*dpr)); if(c.width!==w||c.height!==h){c.width=w;c.height=h;} return {w,h,dpr}; }
function drawWorld(canvas, isTeacher=false){
  const {w,h}=resizeCanvas(canvas), ctx=canvas.getContext('2d'); ctx.clearRect(0,0,w,h); if(!world){ctx.fillStyle='#7bc35f';ctx.fillRect(0,0,w,h);return;}
  const sx=w/world.map.width, sy=h/world.map.height; const s=Math.min(sx,sy); const ox=(w-world.map.width*s)/2, oy=(h-world.map.height*s)/2;
  ctx.save(); ctx.translate(ox,oy); ctx.scale(s,s); drawMap(ctx,world); drawTraces(ctx,world); drawPlayers(ctx,world,isTeacher); ctx.restore();
}
function drawMap(ctx,w){
  ctx.fillStyle='#75be59'; ctx.fillRect(0,0,w.map.width,w.map.height);
  // Running track and field
  ctx.fillStyle='#d77f58'; roundRect(ctx,145,245,1310,500,110,true);
  ctx.fillStyle='#79bd58'; roundRect(ctx,225,305,1150,380,85,true);
  ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=4;[165,185,205].forEach(m=>{roundRect(ctx,145+m-145,245+m-165,1310-(m-165)*2,500-(m-165)*2,100,false,true)});
  ctx.strokeStyle='rgba(255,255,255,.85)';ctx.lineWidth=3;ctx.strokeRect(520,355,560,280);ctx.beginPath();ctx.moveTo(800,355);ctx.lineTo(800,635);ctx.stroke();ctx.beginPath();ctx.arc(800,495,58,0,Math.PI*2);ctx.stroke();
  // paths
  ctx.fillStyle='#e9d4ad';ctx.fillRect(0,170,1600,62);ctx.fillRect(760,150,80,130);
  for(const o of w.obstacles){
    if(o.type==='building'){ctx.fillStyle='#d79a72';ctx.fillRect(o.x,o.y,o.w,o.h);ctx.fillStyle='#6ea6c6';for(let x=o.x+25;x<o.x+o.w-30;x+=70)ctx.fillRect(x,o.y+26,42,32);ctx.fillStyle='#fff8e8';ctx.font='700 24px sans-serif';ctx.textAlign='center';ctx.fillText(o.label,o.x+o.w/2,o.y+o.h-20)}
    else if(o.type==='tree'){ctx.fillStyle='#5d3d29';ctx.fillRect(o.x+22,o.y+28,12,35);ctx.fillStyle='#397e3d';ctx.beginPath();ctx.arc(o.x+27,o.y+25,30,0,Math.PI*2);ctx.fill()}
    else if(o.type==='garden'){ctx.fillStyle='#b78657';ctx.fillRect(o.x,o.y,o.w,o.h);ctx.fillStyle='#5c9d43';ctx.fillRect(o.x+8,o.y+8,o.w-16,o.h-16);ctx.fillStyle='#fff';ctx.font='700 18px sans-serif';ctx.textAlign='center';ctx.fillText(o.label,o.x+o.w/2,o.y+o.h/2+6)}
    else {ctx.fillStyle=o.type==='goal'?'#f3f4f5':'#c49869';ctx.fillRect(o.x,o.y,o.w,o.h)}
  }
  ctx.fillStyle='rgba(9,33,50,.7)';ctx.font='900 26px sans-serif';ctx.textAlign='left';ctx.fillText('우리 학교 운동장',30,875);
}
function drawTraces(ctx,w){for(const t of w.traces){ctx.save();ctx.translate(t.x,t.y);ctx.fillStyle='rgba(45,52,63,.65)';ctx.beginPath();ctx.ellipse(0,8,25,12,0,0,Math.PI*2);ctx.fill();ctx.font='28px sans-serif';ctx.textAlign='center';ctx.fillText('💀',0,4);ctx.font='700 11px sans-serif';ctx.fillStyle='#26323e';ctx.fillText(t.name,0,30);ctx.restore();}}
function drawPlayers(ctx,w,isTeacher){
  for(const p of w.players){ if(p.eliminated) continue; const isMe=p.id===me.id; ctx.save();ctx.translate(p.x,p.y);
    if(p.frozen){ctx.shadowColor='#8ee7ff';ctx.shadowBlur=18;ctx.fillStyle='#bfefff';ctx.strokeStyle='#fff';ctx.lineWidth=4;ctx.beginPath();ctx.arc(0,0,22,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.font='18px sans-serif';ctx.textAlign='center';ctx.fillText('❄️',0,6)}
    else {ctx.shadowColor='rgba(0,0,0,.22)';ctx.shadowBlur=8;ctx.fillStyle=p.role==='tagger'?'#ff5b61':'#3f8fff';ctx.strokeStyle=isMe?'#ffe15a':'#fff';ctx.lineWidth=isMe?5:3;ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle='#222';ctx.beginPath();ctx.arc(-6,-3,2.2,0,Math.PI*2);ctx.arc(6,-3,2.2,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#222';ctx.lineWidth=1.6;ctx.beginPath();ctx.arc(0,2,6,.15*Math.PI,.85*Math.PI);ctx.stroke();}
    ctx.font='700 12px sans-serif';ctx.textAlign='center';ctx.lineWidth=4;ctx.strokeStyle='rgba(255,255,255,.95)';ctx.strokeText(p.name,0,-28);ctx.fillStyle='#152232';ctx.fillText(p.name,0,-28); if(p.role==='tagger'){ctx.font='15px sans-serif';ctx.fillText('👹',0,-43)} ctx.restore(); }
}
function roundRect(ctx,x,y,w,h,r,fill=false,stroke=false){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill)ctx.fill();if(stroke)ctx.stroke();}
function frame(){ if(mode==='teacher') drawWorld($('#teacherCanvas'),true); if(mode==='player') drawWorld($('#playerCanvas'),false); updateTopbar(); requestAnimationFrame(frame); } requestAnimationFrame(frame);
