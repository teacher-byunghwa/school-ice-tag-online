const socket = io({ transports:['websocket','polling'], reconnection:true, reconnectionAttempts:Infinity, reconnectionDelay:500, reconnectionDelayMax:2500 });
const screens = [...document.querySelectorAll('.screen')];
const $ = s => document.querySelector(s);
let mode = 'home';
let roomCode = null;
let teacherToken = null;
let mapConfig = null;
let world = null;
let serverOffset = 0;
let teacherViewZone = 'outdoor';
let me = { id:null, role:'runner', frozen:false, eliminated:false, gender:'male', zone:'outdoor', boostCharges:0, boostUntil:0 };
let input = { up:false,down:false,left:false,right:false };
let lastInputSent = '';
let pendingJoin = null;
let statusTimer = null;
const renderPositions = new Map();
const PLAYER_SESSION_KEY = 'iceTagPlayerV3';
const TEACHER_SESSION_KEY = 'iceTeacher';

function show(id){ screens.forEach(s=>s.classList.toggle('active',s.id===id)); mode=id; if(id==='player') requestWakeLock(); }
function cleanCode(v){ return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5); }
function escapeHtml(s){ return String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])); }
function fmt(sec){ sec=Math.max(0,Math.floor(sec)); return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`; }
function serverNow(){ return Date.now()+serverOffset; }

// ---------- Lightweight synthesized sound effects (no paid/external audio files) ----------
let audioCtx = null;
function primeAudio(){
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
  }catch(_){ }
}
addEventListener('pointerdown',primeAudio,{passive:true});
addEventListener('keydown',primeAudio,{passive:true});
function tone(freq, delay=0, dur=.12, type='sine', gain=.07, endFreq=null){
  if(!audioCtx) return;
  const t=audioCtx.currentTime+delay, o=audioCtx.createOscillator(), g=audioCtx.createGain();
  o.type=type;o.frequency.setValueAtTime(freq,t);if(endFreq)o.frequency.exponentialRampToValueAtTime(Math.max(30,endFreq),t+dur);
  g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(gain,t+.015);g.gain.exponentialRampToValueAtTime(.0001,t+dur);
  o.connect(g);g.connect(audioCtx.destination);o.start(t);o.stop(t+dur+.03);
}
function playSound(name){
  primeAudio(); if(!audioCtx) return;
  if(name==='start'){ [[523,0],[659,.13],[784,.26],[1047,.43]].forEach(([f,d])=>tone(f,d,.17,'triangle',.08)); vibrate([40,30,40]); }
  if(name==='freeze'){ tone(1100,0,.1,'sine',.06,720);tone(1550,.06,.18,'sine',.045,980);vibrate(45); }
  if(name==='rescue'){ tone(520,0,.1,'triangle',.06,720);tone(780,.1,.14,'triangle',.065,1120);vibrate([30,30,30]); }
  if(name==='out'){ tone(360,0,.18,'sawtooth',.055,190);tone(180,.14,.28,'triangle',.06,80);vibrate([90,45,120]); }
  if(name==='end'){ [[523,0],[659,.12],[784,.24],[1047,.38],[784,.55],[1047,.69],[1319,.84]].forEach(([f,d])=>tone(f,d,.2,'triangle',.075));vibrate([60,40,60,40,120]); }
  if(name==='jump'){ tone(260,0,.13,'sine',.045,620); }
  if(name==='item'){ tone(880,0,.08,'triangle',.06);tone(1320,.08,.15,'triangle',.07);vibrate(35); }
  if(name==='boost'){ tone(260,0,.22,'sawtooth',.045,920);tone(520,.1,.2,'triangle',.055,1300);vibrate([35,25,35]); }
  if(name==='portal'){ tone(420,0,.13,'sine',.04,690);tone(690,.1,.14,'sine',.04,980); }
}
function vibrate(pattern){ try{ if(navigator.vibrate) navigator.vibrate(pattern); }catch(_){} }

// ---------- Wake lock + reconnect ----------
let wakeLock = null;
async function requestWakeLock(){
  if(mode!=='player'||document.hidden||!('wakeLock' in navigator)) return;
  try{ wakeLock=await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release',()=>wakeLock=null); }catch(_){ }
}
function getPlayerSession(){ try{return JSON.parse(localStorage.getItem(PLAYER_SESSION_KEY)||'null');}catch(_){return null;} }
function savePlayerSession(data){ localStorage.setItem(PLAYER_SESSION_KEY,JSON.stringify(data)); }
function clearPlayerSession(){ localStorage.removeItem(PLAYER_SESSION_KEY); }
function setReconnect(showIt,text='📶 다시 연결하는 중...'){ const el=$('#reconnectBadge');el.textContent=text;el.classList.toggle('hidden',!showIt); }

function restorePlayerSession(){
  const s=getPlayerSession();
  if(!s?.roomCode||!s?.playerToken) return false;
  const requested=cleanCode(new URLSearchParams(location.search).get('room'));
  if(requested&&requested!==s.roomCode) return false;
  setReconnect(true);
  socket.emit('playerResume',{roomCode:s.roomCode,playerToken:s.playerToken},res=>{
    if(!res?.ok){
      setReconnect(false); clearPlayerSession();
      if(requested){ $('#joinCode').value=requested;show('join');$('#joinError').textContent='이전 접속은 복구할 수 없어 다시 입장해 주세요.'; }
      return;
    }
    roomCode=s.roomCode; mapConfig=res.mapConfig; world=res.state||world; if(world?.serverNow)serverOffset=world.serverNow-Date.now();
    applyMe(res.player); me.id=res.playerId; show('player'); setReconnect(false); renderPositions.clear(); updateRoleBadge(); buildTeacherZoneTabs();
    if(res.summary?.state==='waiting') setStatus('교사가 게임을 시작할 때까지 기다려 주세요.',true);
    else if(res.summary?.state==='ended') setStatus('게임이 종료되었습니다. 다음 게임을 기다려 주세요.',true);
    else if(me.eliminated) setStatus('아웃 상태로 복귀했습니다. 다른 친구들의 게임을 관전할 수 있어요.',true);
    else if(me.frozen) setStatus('❄️ 얼음 상태로 복귀했습니다. 친구가 가까이 오면 풀립니다.',true);
    else setStatus('',false);
  });
  return true;
}
function restoreTeacherSession(){
  let s=null;try{s=JSON.parse(sessionStorage.getItem(TEACHER_SESSION_KEY)||'null');}catch(_){ }
  if(!s?.roomCode||!s?.teacherToken) return false;
  socket.emit('teacherResume',{roomCode:s.roomCode,token:s.teacherToken},async res=>{
    if(!res?.ok)return;
    roomCode=s.roomCode;teacherToken=s.teacherToken;mapConfig=res.mapConfig;$('#roomCodeText').textContent=roomCode;show('teacher');updateTeacherSummary(res.summary);buildTeacherZoneTabs();await loadQr();
  });
  return true;
}

socket.on('connect',()=>{
  setReconnect(false);
  if(mode==='player'||getPlayerSession()) { if(restorePlayerSession())return; }
  const params=new URLSearchParams(location.search);
  if(!params.get('room')&&mode==='home') restoreTeacherSession();
});
socket.on('disconnect',()=>{
  if(mode==='player'){ clearAllInput();setReconnect(true,'📶 연결이 잠시 끊겼어요. 화면을 켜두면 자동으로 복귀합니다.'); }
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){clearAllInput();return;}
  requestWakeLock();
  if(!socket.connected)socket.connect(); else if(mode==='player')restorePlayerSession();
});

// ---------- Home / teacher ----------
document.querySelectorAll('[data-back]').forEach(b=>b.onclick=()=>show(b.dataset.back));
$('#studentJoinOpen').onclick=()=>show('join');
$('#teacherCreate').onclick=()=>{
  primeAudio();socket.emit('createRoom',{origin:location.origin},async res=>{
    if(!res?.ok)return alert(res?.error||'방 생성 실패');
    roomCode=res.roomCode;teacherToken=res.teacherToken;mapConfig=res.mapConfig;sessionStorage.setItem(TEACHER_SESSION_KEY,JSON.stringify({roomCode,teacherToken}));
    $('#roomCodeText').textContent=roomCode;show('teacher');updateTeacherSummary(res.summary);buildTeacherZoneTabs();await loadQr();
  });
};
async function loadQr(){try{const qr=await fetch(`/api/qr/${roomCode}`).then(r=>r.json());$('#qrImage').src=qr.dataUrl;$('#joinUrl').textContent=qr.joinUrl;}catch(_){}}
$('#saveSettings').onclick=()=>socket.emit('teacherSettings',{roomCode,token:teacherToken,taggerCount:Number($('#taggerCount').value),durationSec:Number($('#durationSec').value)},res=>{$('#teacherMessage').textContent=res?.ok?'설정이 저장되었습니다.':(res?.error||'저장 실패');});
$('#startGame').onclick=()=>{
  primeAudio();socket.emit('teacherSettings',{roomCode,token:teacherToken,taggerCount:Number($('#taggerCount').value),durationSec:Number($('#durationSec').value)},()=>socket.emit('startGame',{roomCode,token:teacherToken},res=>{$('#teacherMessage').textContent=res?.ok?'게임이 시작되었습니다.':(res?.error||'시작 실패');}));
};
$('#resetGame').onclick=()=>socket.emit('resetGame',{roomCode,token:teacherToken},res=>{$('#teacherMessage').textContent=res?.ok?'대기실로 초기화했습니다.':(res?.error||'초기화 실패');});

// ---------- Join + character selection ----------
$('#joinCode').oninput=e=>e.target.value=cleanCode(e.target.value);
$('#joinBtn').onclick=prepareJoin;
$('#nickname').addEventListener('keydown',e=>{if(e.key==='Enter')prepareJoin();});
function prepareJoin(){
  primeAudio();const code=cleanCode($('#joinCode').value),nickname=$('#nickname').value.trim();$('#joinError').textContent='';
  if(code.length<5)return $('#joinError').textContent='5자리 방 코드를 입력하세요.';
  if(!nickname)return $('#joinError').textContent='닉네임을 입력하세요.';
  pendingJoin={code,nickname};$('#characterModal').classList.remove('hidden');
}
$('#cancelCharacter').onclick=()=>{$('#characterModal').classList.add('hidden');pendingJoin=null;};
document.querySelectorAll('[data-gender]').forEach(btn=>btn.addEventListener('click',()=>completeJoin(btn.dataset.gender)));
function completeJoin(gender){
  if(!pendingJoin)return;primeAudio();const {code,nickname}=pendingJoin;$('#characterModal').classList.add('hidden');pendingJoin=null;
  // 사용자가 명시적으로 새 참가를 선택했으므로 같은 브라우저의 옛 세션은 교체합니다.
  socket.emit('joinRoom',{roomCode:code,nickname,gender},res=>{
    if(!res?.ok){show('join');return $('#joinError').textContent=res?.error||'입장 실패';}
    roomCode=code;mapConfig=res.mapConfig;me.id=res.playerId;applyMe(res.player);savePlayerSession({roomCode:code,playerToken:res.playerToken,playerId:res.playerId,nickname,gender});
    renderPositions.clear();show('player');requestWakeLock();setStatus('교사가 게임을 시작할 때까지 기다려 주세요.',true);updateRoleBadge();
  });
}
const params=new URLSearchParams(location.search);if(params.get('room')){$('#joinCode').value=cleanCode(params.get('room'));if(!getPlayerSession())show('join');setTimeout(()=>$('#nickname').focus(),120);}

function applyMe(p){if(!p)return;me={...me,...p};updateBoostUI();}
function setStatus(text,showIt){const el=$('#statusOverlay');el.textContent=text;el.classList.toggle('hidden',!showIt);}
function pulseStatus(text,ms=850){clearTimeout(statusTimer);setStatus(text,true);statusTimer=setTimeout(()=>{if(!me.eliminated)setStatus('',false);},ms);}
function updateRoleBadge(){
  const b=$('#roleBadge');const loc=mapConfig?.zones?.[me.zone]?.label||'';
  if(me.eliminated){b.textContent=`👻 관전 중 · ${loc}`;b.style.background='rgba(50,50,60,.87)';return;}
  if(me.role==='tagger'){b.textContent=`🔴 술래 · ${loc}`;b.style.background='rgba(180,24,32,.9)';}
  else if(me.frozen){b.textContent=`❄️ 얼음 · ${loc}`;b.style.background='rgba(37,132,190,.9)';}
  else{b.textContent=`🔵 도망팀 · ${loc}`;b.style.background='rgba(24,103,180,.9)';}
}

// ---------- Game events ----------
socket.on('role',({role})=>{me.role=role;me.frozen=false;me.eliminated=false;me.boostCharges=0;me.boostUntil=0;updateRoleBadge();updateBoostUI();});
socket.on('gameStarted',({taggerCount,runnerCount})=>{
  me.eliminated=false;me.frozen=false;renderPositions.clear();updateRoleBadge();playSound('start');
  const myRole=me.role==='tagger'?'당신은 🔴 술래입니다!':'당신은 🔵 도망팀입니다!';
  setStatus(`🎮 게임 시작!\n술래 ${taggerCount}명 · 도망팀 ${runnerCount}명\n${myRole}`,true);
  clearTimeout(statusTimer);statusTimer=setTimeout(()=>setStatus('',false),2600);
});
socket.on('frozen',({frozen})=>{me.frozen=frozen;updateRoleBadge();if(frozen){playSound('freeze');pulseStatus('❄️ 얼음!\n친구가 가까이 오면 풀립니다.',900);}else{playSound('rescue');pulseStatus('🟢 친구가 구해줬어요! 다시 달리세요!',900);}});
socket.on('eliminated',({by})=>{me.eliminated=true;me.frozen=false;clearAllInput();updateRoleBadge();playSound('out');setStatus(`💥 아웃!\n${by?by+'에게 잡혔습니다.\n':''}이제 다른 친구들의 게임을 관전할 수 있어요.`,true);});
socket.on('gameEnded',({winner,survivors})=>{playSound('end');const msg=winner==='runners'?`🎉 도망팀 승리!\n${survivors}명 생존\n🎺 게임 끝!`:'🏆 술래팀 승리!\n모두 잡았습니다.\n🎺 게임 끝!';if(mode==='player')setStatus(msg,true);});
socket.on('jumped',()=>playSound('jump'));
socket.on('zoneChanged',({zone,label})=>{me.zone=zone;renderPositions.delete(me.id);playSound('portal');pulseStatus(`📍 ${label}`,650);updateRoleBadge();});
socket.on('itemCollected',({charges})=>{me.boostCharges=charges;playSound('item');pulseStatus('🐟 붕어빵 획득!\n⚡ 부스터를 사용할 수 있어요!',1000);updateBoostUI();});
socket.on('boostState',({charges,boostUntil})=>{me.boostCharges=charges;me.boostUntil=boostUntil;playSound('boost');pulseStatus('⚡ 부스터 ON!\n10초 동안 2배 속도!',800);updateBoostUI();});
socket.on('itemsDropped',({count})=>{if(mode==='player')pulseStatus(`🐟 붕어빵 ${count}개가 맵 곳곳에 나타났어요!`,850);});
socket.on('teacherSummary',updateTeacherSummary);
socket.on('world',data=>{
  world=data;if(data.serverNow)serverOffset=data.serverNow-Date.now();
  for(const p of data.players||[]){
    const rp=renderPositions.get(p.id);if(!rp||rp.zone!==p.zone)renderPositions.set(p.id,{x:p.x,y:p.y,zone:p.zone});
    if(p.id===me.id){me={...me,...p};updateRoleBadge();updateBoostUI();}
  }
  if(mode==='teacher')updateTeacherSummary(data.summary);updateTopbar();updateActivity();updateZoneTabCounts();
});

function updateTeacherSummary(s){if(!s)return;$('#teacherPlayers').textContent=s.playerCount;$('#teacherAlive').textContent=s.aliveRunners;$('#startGame').disabled=s.state==='playing';$('#saveSettings').disabled=s.state!=='waiting';updateZoneTabCounts(s);}
function updateTopbar(){
  if(!world)return;const s=world.summary;const left=s.endsAt?Math.max(0,Math.ceil((s.endsAt-serverNow())/1000)):s.durationSec;
  const playerLoc=mapConfig?.zones?.[me.zone]?.label||'운동장';
  $('#teacherTopbar').textContent=`방 ${s.code} · 참가 ${s.playerCount}/${s.maxPlayers} · 연결 ${s.connectedCount} · 생존 ${s.aliveRunners} · ⏱ ${fmt(left)}`;
  $('#playerTopbar').textContent=`${playerLoc} · 생존 ${s.aliveRunners} · ⏱ ${fmt(left)}`;
  updateBoostUI();
}
function updateActivity(){if(mode!=='teacher'||!world)return;$('#activity').innerHTML=world.summary.activity.slice().reverse().map(a=>`<div class="${a.kind}">${escapeHtml(a.text)}</div>`).join('');}
function buildTeacherZoneTabs(){
  if(!mapConfig)return;const el=$('#teacherZoneTabs');el.innerHTML='';
  for(const id of mapConfig.order){const b=document.createElement('button');b.dataset.zone=id;b.classList.toggle('active',id===teacherViewZone);b.addEventListener('click',()=>{teacherViewZone=id;[...el.children].forEach(x=>x.classList.toggle('active',x.dataset.zone===id));updateZoneTabCounts();});el.appendChild(b);}updateZoneTabCounts();
}
function updateZoneTabCounts(summary=world?.summary){if(!mapConfig)return;document.querySelectorAll('#teacherZoneTabs button').forEach(b=>{const z=mapConfig.zones[b.dataset.zone];const count=summary?.zoneCounts?.[b.dataset.zone]||0;b.innerHTML=`${z.id==='outdoor'?'🏫':'🏢'} ${z.id==='outdoor'?'운동장':z.level+'층'} <small>${count}</small>`;});}

// ---------- Keyboard + tablet controls ----------
const keyMap={ArrowUp:'up',KeyW:'up',ArrowDown:'down',KeyS:'down',ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right'};
addEventListener('keydown',e=>{
  if(mode!=='player')return;
  if(keyMap[e.code]){e.preventDefault();input[keyMap[e.code]]=true;sendInput();}
  if(e.code==='KeyI'&&!e.repeat){e.preventDefault();doFreeze();}
  if(e.code==='Space'&&!e.repeat){e.preventDefault();doJump();}
  if(e.code==='KeyB'&&!e.repeat){e.preventDefault();doBoost();}
});
addEventListener('keyup',e=>{if(mode!=='player')return;if(keyMap[e.code]){e.preventDefault();input[keyMap[e.code]]=false;sendInput();}});
function sendInput(force=false){const s=JSON.stringify(input);if(!force&&s===lastInputSent)return;lastInputSent=s;if(socket.connected)socket.emit('input',input);}
function doFreeze(){if(mode==='player'&&me.role==='runner'&&!me.frozen&&!me.eliminated)socket.emit('freezeToggle');}
function doJump(){if(mode==='player'&&!me.frozen&&!me.eliminated)socket.emit('jump');}
function doBoost(){if(mode==='player'&&me.role==='runner'&&!me.frozen&&!me.eliminated&&me.boostCharges>0&&serverNow()>=(me.boostUntil||0))socket.emit('useBoost');}
function updateBoostUI(){
  const btn=$('#boostBtn'),active=(me.boostUntil||0)>serverNow(),charges=me.boostCharges||0;
  btn.classList.toggle('hidden',charges<=0&&!active);btn.classList.toggle('active',active);btn.disabled=active;
  if(active){const sec=Math.max(0,Math.ceil((me.boostUntil-serverNow())/1000));$('#boostCount').textContent=`${sec}초`;}
  else $('#boostCount').textContent=charges>0?`×${charges}`:'';
}

const mobileControls=$('#mobileControls');
['contextmenu','selectstart','dragstart','copy'].forEach(type=>{mobileControls.addEventListener(type,e=>e.preventDefault());$('#player').addEventListener(type,e=>{if(e.target.closest?.('#mobileControls'))e.preventDefault();});});
['touchmove','gesturestart','gesturechange','gestureend'].forEach(type=>mobileControls.addEventListener(type,e=>e.preventDefault(),{passive:false}));
function bindActionButton(sel,fn){const b=$(sel);b.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();primeAudio();try{b.setPointerCapture(e.pointerId);}catch(_){}fn();});}
bindActionButton('#iceBtn',doFreeze);bindActionButton('#jumpBtn',doJump);bindActionButton('#boostBtn',doBoost);
const pointerToKey=new Map();
function releasePointer(pointerId){const key=pointerToKey.get(pointerId);if(!key)return;pointerToKey.delete(pointerId);if(![...pointerToKey.values()].includes(key)){input[key]=false;sendInput();}}
document.querySelectorAll('[data-key]').forEach(btn=>{
  const k=btn.dataset.key;btn.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();primeAudio();try{btn.setPointerCapture(e.pointerId);}catch(_){}pointerToKey.set(e.pointerId,k);input[k]=true;sendInput();});
  const up=e=>{e.preventDefault();e.stopPropagation();releasePointer(e.pointerId);};btn.addEventListener('pointerup',up);btn.addEventListener('pointercancel',up);btn.addEventListener('lostpointercapture',e=>releasePointer(e.pointerId));
});
function clearAllInput(){pointerToKey.clear();input={up:false,down:false,left:false,right:false};lastInputSent='';sendInput(true);}
addEventListener('blur',clearAllInput);

// ---------- Canvas rendering ----------
function resizeCanvas(c){const dpr=Math.min(devicePixelRatio||1,2),rect=c.getBoundingClientRect(),w=Math.max(1,Math.floor(rect.width*dpr)),h=Math.max(1,Math.floor(rect.height*dpr));if(c.width!==w||c.height!==h){c.width=w;c.height=h;}return{w,h,dpr};}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
function roundRect(ctx,x,y,w,h,r,fill=false,stroke=false){ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x,y,w,h,r);else ctx.rect(x,y,w,h);if(fill)ctx.fill();if(stroke)ctx.stroke();}
function drawWorld(canvas,isTeacher=false){
  const {w,h,dpr}=resizeCanvas(canvas),ctx=canvas.getContext('2d');ctx.clearRect(0,0,w,h);
  if(!world||!mapConfig){ctx.fillStyle='#77bf62';ctx.fillRect(0,0,w,h);return;}
  const myPlayer=world.players.find(p=>p.id===me.id);const zoneId=isTeacher?teacherViewZone:(myPlayer?.zone||me.zone||'outdoor');const z=mapConfig.zones[zoneId];if(!z)return;
  let scale,ox,oy;
  if(isTeacher){scale=Math.min(w/z.width,h/z.height);ox=(w-z.width*scale)/2;oy=(h-z.height*scale)/2;}
  else{
    const cssW=w/dpr,cssH=h/dpr,visibleW=cssW<650?820:1080,visibleH=cssH<520?620:760;scale=Math.min(w/visibleW,h/visibleH);
    const focus=(myPlayer&&!myPlayer.eliminated?renderPositions.get(myPlayer.id)||myPlayer:null)||world.players.find(p=>p.zone===zoneId&&!p.eliminated)||{x:z.width/2,y:z.height/2};
    ox=w/2-focus.x*scale;oy=h/2-focus.y*scale;if(z.width*scale>w)ox=clamp(ox,w-z.width*scale,0);else ox=(w-z.width*scale)/2;if(z.height*scale>h)oy=clamp(oy,h-z.height*scale,0);else oy=(h-z.height*scale)/2;
  }
  ctx.save();ctx.translate(ox,oy);ctx.scale(scale,scale);drawZone(ctx,z);drawItems(ctx,zoneId);drawTraces(ctx,zoneId);drawPlayers(ctx,zoneId);ctx.restore();
}
function drawZone(ctx,z){if(z.theme==='outdoor')drawOutdoor(ctx,z);else drawIndoor(ctx,z);drawPortals(ctx,z);}
function drawOutdoor(ctx,z){
  const W=z.width,H=z.height;const grass=ctx.createLinearGradient(0,0,0,H);grass.addColorStop(0,'#99d77d');grass.addColorStop(1,'#58a953');ctx.fillStyle=grass;ctx.fillRect(0,0,W,H);
  ctx.globalAlpha=.07;for(let x=0;x<W;x+=140){ctx.fillStyle=(x/140)%2===0?'#fff':'#174e31';ctx.fillRect(x,0,70,H);}ctx.globalAlpha=1;
  // school paths
  ctx.fillStyle='#e6d7ba';ctx.fillRect(0,510,W,105);ctx.fillRect(1750,470,100,300);ctx.fillRect(0,1370,W,70);
  // running track: large enough for 50+ players
  ctx.save();ctx.strokeStyle='#bd6550';ctx.lineWidth=150;ctx.beginPath();ctx.ellipse(1800,1210,1120,660,0,0,Math.PI*2);ctx.stroke();ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=4;for(let i=0;i<4;i++){ctx.beginPath();ctx.ellipse(1800,1210,1055-i*32,595-i*32,0,0,Math.PI*2);ctx.stroke();}ctx.restore();
  // football field
  ctx.fillStyle='rgba(62,151,70,.72)';ctx.fillRect(950,850,1700,720);ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=5;ctx.strokeRect(950,850,1700,720);ctx.beginPath();ctx.moveTo(1800,850);ctx.lineTo(1800,1570);ctx.stroke();ctx.beginPath();ctx.arc(1800,1210,95,0,Math.PI*2);ctx.stroke();ctx.strokeRect(950,1040,170,340);ctx.strokeRect(2480,1040,170,340);
  // playground base
  for(const a of z.areas||[]){if(a.type==='playground'){ctx.save();ctx.fillStyle='#77c9e9';roundRect(ctx,a.x,a.y,a.w,a.h,35,true);ctx.fillStyle='#f3cf58';ctx.beginPath();ctx.arc(a.x+160,a.y+160,80,0,Math.PI*2);ctx.fill();ctx.fillStyle='#ef7a6c';roundRect(ctx,a.x+340,a.y+100,150,70,25,true);ctx.fillStyle='#fff';ctx.font='900 34px sans-serif';ctx.textAlign='center';ctx.fillText('놀이터',a.x+a.w/2,a.y+a.h-45);ctx.restore();}}
  for(const o of z.obstacles){if(o.type==='building')drawBuilding3D(ctx,o);else if(o.type==='tree')drawTree3D(ctx,o);else if(o.type==='garden')drawGarden(ctx,o);else if(o.type==='goal')drawGoal(ctx,o);else if(o.type==='bench')drawBench(ctx,o);else if(o.type==='playgroundFence')drawFence(ctx,o);else if(o.type==='playEquipment')drawPlayEquipment(ctx,o);}
  ctx.fillStyle='rgba(19,54,60,.7)';ctx.font='900 34px sans-serif';ctx.textAlign='left';ctx.fillText('우리 학교 대운동장',40,H-38);
}
function drawBuilding3D(ctx,o){const depth=34;ctx.save();ctx.shadowColor='rgba(20,39,48,.28)';ctx.shadowBlur=22;ctx.shadowOffsetY=17;ctx.fillStyle='#ad694e';ctx.fillRect(o.x,o.y,o.w,o.h);ctx.shadowColor='transparent';ctx.fillStyle='#8c4e3c';ctx.beginPath();ctx.moveTo(o.x+o.w,o.y);ctx.lineTo(o.x+o.w+depth,o.y-depth);ctx.lineTo(o.x+o.w+depth,o.y+o.h-depth);ctx.lineTo(o.x+o.w,o.y+o.h);ctx.closePath();ctx.fill();ctx.fillStyle='#ead0a9';ctx.beginPath();ctx.moveTo(o.x,o.y);ctx.lineTo(o.x+depth,o.y-depth);ctx.lineTo(o.x+o.w+depth,o.y-depth);ctx.lineTo(o.x+o.w,o.y);ctx.closePath();ctx.fill();ctx.fillStyle='#d89c70';ctx.fillRect(o.x+14,o.y+14,o.w-28,o.h-28);for(let yy=o.y+52;yy<o.y+o.h-70;yy+=78){for(let x=o.x+45;x<o.x+o.w-60;x+=95){ctx.fillStyle='#77aecb';ctx.fillRect(x,yy,61,45);ctx.fillStyle='rgba(235,250,255,.48)';ctx.fillRect(x+7,yy+6,20,33);ctx.fillRect(x+34,yy+6,20,33);}}ctx.fillStyle='#f8f0e4';ctx.font='900 30px sans-serif';ctx.textAlign='center';ctx.fillText(o.label,o.x+o.w/2,o.y+o.h-28);ctx.restore();}
function drawTree3D(ctx,o){ctx.save();ctx.shadowColor='rgba(20,60,30,.25)';ctx.shadowBlur=13;ctx.shadowOffsetY=11;ctx.fillStyle='#704b30';ctx.fillRect(o.x+29,o.y+36,15,54);ctx.fillStyle='#3d8d49';ctx.beginPath();ctx.arc(o.x+36,o.y+29,40,0,Math.PI*2);ctx.fill();ctx.fillStyle='#60b15e';ctx.beginPath();ctx.arc(o.x+20,o.y+16,23,0,Math.PI*2);ctx.arc(o.x+52,o.y+17,24,0,Math.PI*2);ctx.fill();ctx.restore();}
function drawGarden(ctx,o){ctx.save();ctx.fillStyle='#a7774e';roundRect(ctx,o.x,o.y,o.w,o.h,22,true);ctx.fillStyle='#68a94f';roundRect(ctx,o.x+14,o.y+14,o.w-28,o.h-28,16,true);for(let y=o.y+42;y<o.y+o.h-25;y+=44)for(let x=o.x+42;x<o.x+o.w-25;x+=52){ctx.fillStyle=((x+y)/10)%2>1?'#ffd769':'#f59fc0';ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.fill();}ctx.fillStyle='#fff';ctx.font='900 24px sans-serif';ctx.textAlign='center';ctx.fillText(o.label,o.x+o.w/2,o.y+o.h/2);ctx.restore();}
function drawGoal(ctx,o){ctx.save();ctx.strokeStyle='#fff';ctx.lineWidth=9;ctx.shadowColor='rgba(0,0,0,.2)';ctx.shadowBlur=8;ctx.strokeRect(o.x,o.y,o.w,o.h);ctx.globalAlpha=.55;ctx.lineWidth=2;for(let y=o.y+20;y<o.y+o.h;y+=27){ctx.beginPath();ctx.moveTo(o.x,y);ctx.lineTo(o.x+o.w,y);ctx.stroke();}ctx.restore();}
function drawBench(ctx,o){ctx.save();ctx.fillStyle='#9c7049';roundRect(ctx,o.x,o.y,o.w,o.h,10,true);ctx.fillStyle='#60432f';ctx.fillRect(o.x+25,o.y+o.h-2,14,32);ctx.fillRect(o.x+o.w-39,o.y+o.h-2,14,32);ctx.restore();}
function drawFence(ctx,o){ctx.save();ctx.fillStyle='#f6f1df';ctx.fillRect(o.x,o.y,o.w,o.h);ctx.strokeStyle='#3ca5c8';ctx.lineWidth=5;if(o.w>o.h){for(let x=o.x;x<o.x+o.w;x+=45){ctx.beginPath();ctx.moveTo(x,o.y-10);ctx.lineTo(x,o.y+o.h+10);ctx.stroke();}}else{for(let y=o.y;y<o.y+o.h;y+=45){ctx.beginPath();ctx.moveTo(o.x-10,y);ctx.lineTo(o.x+o.w+10,y);ctx.stroke();}}ctx.restore();}
function drawPlayEquipment(ctx,o){ctx.save();ctx.fillStyle='#f27661';roundRect(ctx,o.x,o.y,o.w,o.h,14,true);ctx.fillStyle='#ffd45f';ctx.fillRect(o.x+15,o.y-42,12,42);ctx.fillRect(o.x+o.w-27,o.y-42,12,42);ctx.restore();}

function drawIndoor(ctx,z){
  ctx.fillStyle='#eef3f5';ctx.fillRect(0,0,z.width,z.height);ctx.fillStyle='#d5e3e8';for(let x=0;x<z.width;x+=70)for(let y=0;y<z.height;y+=70){ctx.strokeStyle='rgba(110,140,150,.15)';ctx.strokeRect(x,y,70,70);}
  // central corridor
  ctx.fillStyle='#c6e3ec';ctx.fillRect(0,500,z.width,400);ctx.fillStyle='rgba(255,255,255,.6)';ctx.fillRect(0,688,z.width,12);
  for(const r of z.rooms||[]){ctx.save();ctx.fillStyle=r.open?'#dff4e2':'#fff8e8';ctx.fillRect(r.x,r.y,r.w,r.h);ctx.fillStyle='#243b4b';ctx.font='900 26px sans-serif';ctx.textAlign='center';ctx.fillText(r.label,r.x+r.w/2,r.y+48);if(!r.open){for(let x=r.x+70;x<r.x+r.w-70;x+=115){ctx.fillStyle='#d3e8f0';ctx.fillRect(x,r.y+75,75,55);ctx.strokeStyle='#a9c8d5';ctx.strokeRect(x,r.y+75,75,55);}}ctx.restore();}
  for(const o of z.obstacles){if(o.type==='wall'){ctx.fillStyle='#55707c';ctx.fillRect(o.x,o.y,o.w,o.h);}else if(o.type==='desk'){ctx.fillStyle='#b98c5d';roundRect(ctx,o.x,o.y,o.w,o.h,8,true);ctx.fillStyle='#8e6846';ctx.fillRect(o.x+20,o.y+o.h,o.w-40,12);}else if(o.type==='bookshelf'){ctx.fillStyle='#7d5a43';ctx.fillRect(o.x,o.y,o.w,o.h);}}
  // corridor details
  for(let x=350;x<z.width-300;x+=420){ctx.fillStyle='#88a1ad';ctx.fillRect(x,540,150,24);ctx.fillStyle='#fff';ctx.font='700 17px sans-serif';ctx.textAlign='center';ctx.fillText('게시판',x+75,558);}
  ctx.fillStyle='rgba(29,58,73,.18)';ctx.font='1000 120px sans-serif';ctx.textAlign='center';ctx.fillText(`${z.level}F`,z.width/2,820);
}
function drawPortals(ctx,z){for(const p of z.portals||[]){const pulse=.5+.5*Math.sin(performance.now()/300);ctx.save();ctx.fillStyle=`rgba(62,163,255,${.18+.12*pulse})`;ctx.strokeStyle=`rgba(255,255,255,${.65+.25*pulse})`;ctx.lineWidth=5;roundRect(ctx,p.x,p.y,p.w,p.h,18,true,true);ctx.fillStyle='#17384c';ctx.font='900 23px sans-serif';ctx.textAlign='center';ctx.fillText(p.label,p.x+p.w/2,p.y+p.h/2+8);ctx.restore();}}

function drawItems(ctx,zoneId){if(!world)return;for(const item of world.items||[]){if(item.zone!==zoneId)continue;ctx.save();ctx.translate(item.x,item.y-Math.sin(performance.now()/240+item.x)*5);drawBungeoppang(ctx);ctx.restore();}}
function drawBungeoppang(ctx){ctx.save();ctx.shadowColor='rgba(0,0,0,.22)';ctx.shadowBlur=10;ctx.shadowOffsetY=6;ctx.fillStyle='#d98a3c';ctx.beginPath();ctx.moveTo(-31,0);ctx.quadraticCurveTo(-22,-25,5,-27);ctx.quadraticCurveTo(27,-23,34,-8);ctx.lineTo(49,-20);ctx.lineTo(45,0);ctx.lineTo(50,20);ctx.lineTo(32,9);ctx.quadraticCurveTo(20,27,-8,25);ctx.quadraticCurveTo(-29,20,-31,0);ctx.fill();ctx.shadowColor='transparent';ctx.strokeStyle='#9a5524';ctx.lineWidth=2;for(let x=-15;x<22;x+=11){ctx.beginPath();ctx.moveTo(x,-19);ctx.lineTo(x+9,18);ctx.stroke();}ctx.beginPath();ctx.arc(-12,-7,2.8,0,Math.PI*2);ctx.fillStyle='#402719';ctx.fill();ctx.font='900 12px sans-serif';ctx.textAlign='center';ctx.fillStyle='#fff';ctx.strokeStyle='rgba(70,35,10,.65)';ctx.lineWidth=4;ctx.strokeText('붕어빵',5,-36);ctx.fillText('붕어빵',5,-36);ctx.restore();}
function drawTraces(ctx,zoneId){for(const t of world?.traces||[]){if(t.zone!==zoneId)continue;ctx.save();ctx.translate(t.x,t.y);ctx.rotate(-.08);ctx.fillStyle='rgba(45,52,63,.24)';ctx.beginPath();ctx.ellipse(0,10,38,17,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(70,76,84,.55)';ctx.lineWidth=7;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(-18,4);ctx.lineTo(16,-4);ctx.moveTo(-10,1);ctx.lineTo(-24,-13);ctx.moveTo(8,-2);ctx.lineTo(22,12);ctx.stroke();ctx.font='25px sans-serif';ctx.textAlign='center';ctx.fillText('💀',0,-10);ctx.font='700 12px sans-serif';ctx.fillStyle='#26323e';ctx.fillText(t.name,0,32);ctx.restore();}}
function idPhase(id){let n=0;for(let i=0;i<String(id).length;i++)n=(n+String(id).charCodeAt(i)*(i+1))%1000;return n/1000*Math.PI*2;}
function drawPlayers(ctx,zoneId){const now=performance.now();for(const p of world?.players||[]){if(p.eliminated||p.zone!==zoneId)continue;let rp=renderPositions.get(p.id);if(!rp||rp.zone!==p.zone){rp={x:p.x,y:p.y,zone:p.zone};renderPositions.set(p.id,rp);}rp.x+=(p.x-rp.x)*.34;rp.y+=(p.y-rp.y)*.34;ctx.save();ctx.translate(rp.x,rp.y);drawCharacter(ctx,p,p.id===me.id,now);ctx.restore();}}
function drawCharacter(ctx,p,isMe,nowPerf){
  const now=serverNow(),moving=!!p.moving&&!p.frozen,swing=moving?Math.sin(nowPerf/95+idPhase(p.id))*7:0,bob=moving?Math.abs(Math.sin(nowPerf/95+idPhase(p.id)))*2.5:0;
  const jumping=(p.jumpEndsAt||0)>now&&(p.jumpStartedAt||0)<now;let jumpH=0;if(jumping){const prog=clamp((now-p.jumpStartedAt)/Math.max(1,p.jumpEndsAt-p.jumpStartedAt),0,1);jumpH=Math.sin(prog*Math.PI)*34;}
  const boosted=(p.boostUntil||0)>now,facing=p.facing||'down',flip=facing==='left'?-1:1,shirt=p.role==='tagger'?'#e64d52':'#3d8cf3',darkShirt=p.role==='tagger'?'#a92934':'#1c5fb4',skin='#ffd2b0';
  ctx.fillStyle=`rgba(15,35,42,${jumping?.13:.23})`;ctx.beginPath();ctx.ellipse(0,24,Math.max(11,21-jumpH*.16),Math.max(5,9-jumpH*.08),0,0,Math.PI*2);ctx.fill();
  if(isMe){ctx.strokeStyle='#ffe15a';ctx.lineWidth=4;ctx.beginPath();ctx.arc(0,-jumpH,31,0,Math.PI*2);ctx.stroke();}
  if(p.role==='tagger'){ctx.strokeStyle='rgba(255,67,75,.4)';ctx.lineWidth=6;ctx.beginPath();ctx.arc(0,-jumpH,29+Math.sin(nowPerf/150)*2,0,Math.PI*2);ctx.stroke();}
  if(boosted){ctx.strokeStyle='rgba(255,235,50,.85)';ctx.lineWidth=5;for(let k=0;k<3;k++){ctx.beginPath();ctx.moveTo(-34-k*6,-8-jumpH+k*10);ctx.lineTo(-55-k*8,-8-jumpH+k*10);ctx.stroke();}ctx.font='20px sans-serif';ctx.fillText('⚡',22,-43-jumpH);}
  ctx.translate(0,-bob-jumpH);ctx.scale(flip,1);ctx.lineCap='round';
  // legs; female choice gets a skirt silhouette, male choice gets shorts/trousers
  if(p.gender==='female'){
    ctx.strokeStyle='#26384d';ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(-5,11);ctx.lineTo(-7+swing*.45,24);ctx.moveTo(5,11);ctx.lineTo(7-swing*.45,24);ctx.stroke();
    ctx.fillStyle=darkShirt;ctx.beginPath();ctx.moveTo(-13,8);ctx.lineTo(13,8);ctx.lineTo(17,18);ctx.lineTo(-17,18);ctx.closePath();ctx.fill();
  }else{
    ctx.strokeStyle='#27384c';ctx.lineWidth=8;ctx.beginPath();ctx.moveTo(-6,10);ctx.lineTo(-8+swing*.55,24);ctx.moveTo(6,10);ctx.lineTo(8-swing*.55,24);ctx.stroke();
  }
  ctx.strokeStyle='#f4f5f7';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(-11+swing*.5,27);ctx.lineTo(-4+swing*.5,27);ctx.moveTo(5-swing*.5,27);ctx.lineTo(13-swing*.5,27);ctx.stroke();
  ctx.strokeStyle=skin;ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(-11,-4);ctx.lineTo(-18-swing*.55,8);ctx.moveTo(11,-4);ctx.lineTo(18+swing*.55,8);ctx.stroke();
  ctx.fillStyle=shirt;roundRect(ctx,-14,-8,28,24,8,true);ctx.fillStyle=darkShirt;ctx.fillRect(-11,9,22,6);ctx.fillStyle='#fff';ctx.beginPath();ctx.moveTo(-5,-8);ctx.lineTo(0,-2);ctx.lineTo(5,-8);ctx.closePath();ctx.fill();
  ctx.fillStyle=skin;ctx.beginPath();ctx.arc(0,-22,13,0,Math.PI*2);ctx.fill();ctx.fillStyle='#2d2928';
  if(p.gender==='female'){
    ctx.beginPath();ctx.arc(0,-25,14,Math.PI,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(-11,-19,7,0,Math.PI*2);ctx.arc(11,-19,7,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(15,-27,7,0,Math.PI*2);ctx.fill();
  }else{ctx.beginPath();ctx.arc(0,-25,13.5,Math.PI,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(-9,-21,4,0,Math.PI*2);ctx.arc(9,-21,4,0,Math.PI*2);ctx.fill();}
  if(facing!=='up'){ctx.fillStyle='#242b31';const eyeShift=facing==='right'?3:(facing==='left'?-3:0);ctx.beginPath();ctx.arc(-4+eyeShift,-21,1.6,0,Math.PI*2);ctx.arc(4+eyeShift,-21,1.6,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#a85b55';ctx.lineWidth=1.3;ctx.beginPath();ctx.arc(eyeShift,-17,4,.2*Math.PI,.8*Math.PI);ctx.stroke();}
  ctx.scale(flip,1);
  if(p.frozen){ctx.save();ctx.globalAlpha=.76;ctx.fillStyle='#9be7ff';ctx.strokeStyle='#f4fdff';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(0,-47);ctx.lineTo(27,-28);ctx.lineTo(30,15);ctx.lineTo(10,35);ctx.lineTo(-22,29);ctx.lineTo(-31,-8);ctx.lineTo(-20,-37);ctx.closePath();ctx.fill();ctx.stroke();ctx.globalAlpha=.95;ctx.font='19px sans-serif';ctx.textAlign='center';ctx.fillText('❄️',0,5);ctx.restore();}
  ctx.font='800 13px sans-serif';ctx.textAlign='center';ctx.lineWidth=5;ctx.strokeStyle='rgba(255,255,255,.95)';ctx.strokeText(p.name,0,-53);ctx.fillStyle='#142232';ctx.fillText(p.name,0,-53);if(p.role==='tagger'){ctx.font='17px sans-serif';ctx.fillText('👹',0,-68);}if(!p.connected){ctx.font='16px sans-serif';ctx.fillText('📴',18,-53);}
}

function frame(){if(mode==='teacher')drawWorld($('#teacherCanvas'),true);if(mode==='player')drawWorld($('#playerCanvas'),false);updateTopbar();requestAnimationFrame(frame);}requestAnimationFrame(frame);
