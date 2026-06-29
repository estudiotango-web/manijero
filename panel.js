/* ═══════════════════════════════════════════════════════════════════════════
   El Manijero Radio · panel.js v2.1
   Radio global sincronizada.
   El frontend hace 6 cosas:
   1. Entrar sincronizado (offset = ahora - InicioTema)
   2. Reproducir audio con Web Audio API (EQ real)
   3. Reportar al backend qué está sonando + duracionSeg real
   4. Al terminar cortina → backend genera siguiente tanda
   5. Polling cada 30s para nuevos temas
   6. Chat en tiempo real
   ═══════════════════════════════════════════════════════════════════════════ */

const GAS_URL              = 'https://script.google.com/macros/s/AKfycbyqQ_W559BjKp3_q3oSy_numyR2pL_yBf2CX0NuvahNqQm0iA9vZ_ePX9OWabUw_zJGxw/exec';
const CORTINA_DURACION_SEG = 45;
const POLLING_MS           = 30000;
const CHAT_POLLING_MS      = 8000;

// ── Estado ─────────────────────────────────────────────────────────────────
let biblioteca     = [];
let indexActual    = 0;
let estadoPanel    = 'idle';
let audioGenId     = 0;

// ── Web Audio API ──────────────────────────────────────────────────────────
let audioCtx       = null;
let sourceNode     = null;
let bassFilter     = null;
let trebleFilter   = null;
let gainNode       = null;
let analyserNode   = null;
let audioEl        = null;

// ── Knob ───────────────────────────────────────────────────────────────────
let knobValue      = 72;
let knobDragging   = false;
let knobStartY     = 0;
let knobStartVal   = 72;

// ── Timers ─────────────────────────────────────────────────────────────────
let cortinaTimer   = null;
let pollingTimer   = null;
let chatTimer      = null;
let vuTimer        = null;
let ultimoIDReportado = null;

// ══════════════════════════════════════════════════════════════════════════
// ARRANQUE
// ══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function () {
  updateClock();
  setInterval(updateClock, 30000);
  initSliders();
  initKnob();
  actualizarBotones();
  sincronizarEntrada();
  window.addEventListener('resize', handleResize);
  setTimeout(handleResize, 100);
});

// ══════════════════════════════════════════════════════════════════════════
// SINCRONIZACIÓN DE ENTRADA
// Nuevo cliente → pregunta al backend qué está sonando y entra en sync
// ══════════════════════════════════════════════════════════════════════════

async function sincronizarEntrada() {
  mostrarEstadoCarga('Conectando con la radio…');

  try {
    // 1. Estado de la radio (qué está sonando ahora)
    const resEstado = await fetch(GAS_URL + '?action=getEstadoRadio');
    const estado    = await resEstado.json();

    // 2. Biblioteca completa
    const resBib = await fetch(GAS_URL + '?action=getBiblioteca');
    const bib    = await resBib.json();

    if (!Array.isArray(bib) || !bib.length) {
      mostrarEstadoCarga('Radio sin contenido. Iniciá la radio desde el backend.');
      return;
    }

    biblioteca = bib;
    mostrarEstadoCarga(null);
    actualizarBotones();
    iniciarPolling();
    iniciarChatPolling();

    // Si la radio está activa y hay tema sonando, entrar en sync
    if (estado.ok && estado.AudioURL && estado.OffsetSeg >= 0) {
      const idx = biblioteca.findIndex(t => t.ID === estado.ID);
      indexActual = idx >= 0 ? idx : 0;
      estadoPanel = 'playing';
      actualizarBotones();
      actualizarLiveBadge();
      renderTemaActual(biblioteca[indexActual], indexActual);
      renderCola(biblioteca.slice(indexActual + 1, indexActual + 6));
      reproducirDesdeOffset(biblioteca[indexActual], estado.OffsetSeg);
    } else {
      renderBibliotecaCargada();
    }

  } catch (e) {
    console.warn('Error sincronizando:', e);
    mostrarEstadoCarga('Error al conectar. Verificá la URL del GAS.');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// WEB AUDIO API — inicializar contexto y cadena de efectos
// ══════════════════════════════════════════════════════════════════════════

function initAudioContext() {
  if (audioCtx) return;
  audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
  gainNode     = audioCtx.createGain();
  gainNode.gain.value = knobValue / 100;

  bassFilter           = audioCtx.createBiquadFilter();
  bassFilter.type      = 'lowshelf';
  bassFilter.frequency.value = 200;
  bassFilter.gain.value      = 0;

  trebleFilter           = audioCtx.createBiquadFilter();
  trebleFilter.type      = 'highshelf';
  trebleFilter.frequency.value = 4000;
  trebleFilter.gain.value      = 0;

  analyserNode             = audioCtx.createAnalyser();
  analyserNode.fftSize     = 256;
  analyserNode.smoothingTimeConstant = 0.8;

  // Cadena: source → bass → treble → gain → analyser → destino
  bassFilter.connect(trebleFilter);
  trebleFilter.connect(gainNode);
  gainNode.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);
}

function conectarAudioEl(el) {
  if (!audioCtx) initAudioContext();
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch(e) {}
  }
  sourceNode = audioCtx.createMediaElementSource(el);
  sourceNode.connect(bassFilter);
}

// ══════════════════════════════════════════════════════════════════════════
// VU METER REAL (desde analyser)
// ══════════════════════════════════════════════════════════════════════════

function iniciarVU() {
  if (vuTimer) return;
  const data = new Uint8Array(analyserNode ? analyserNode.frequencyBinCount : 0);
  vuTimer = setInterval(function () {
    if (!analyserNode) return;
    analyserNode.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const db  = avg > 0 ? (20 * Math.log10(avg / 255)).toFixed(1) : '-∞';
    setEl('meta-lufs', db + ' dB');

    // Barras de VU si existen en el HTML
    const bL = document.getElementById('vu-left');
    const bR = document.getElementById('vu-right');
    const pct = Math.min((avg / 255) * 100, 100).toFixed(1);
    if (bL) bL.style.height = pct + '%';
    if (bR) bR.style.height = (pct * (0.9 + Math.random() * 0.2)).toFixed(1) + '%';
  }, 80);
}

function detenerVU() {
  if (vuTimer) { clearInterval(vuTimer); vuTimer = null; }
  setEl('meta-lufs', '—');
  const bL = document.getElementById('vu-left');
  const bR = document.getElementById('vu-right');
  if (bL) bL.style.height = '0%';
  if (bR) bR.style.height = '0%';
}

// ══════════════════════════════════════════════════════════════════════════
// CONTROL DE REPRODUCCIÓN
// ══════════════════════════════════════════════════════════════════════════

function iniciarMilonga() {
  if (!biblioteca.length) return;
  if (estadoPanel === 'paused') { reanudar(); return; }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  estadoPanel = 'playing';
  indexActual = 0;
  actualizarBotones();
  actualizarLiveBadge();
  reproducirTema(indexActual);
}

function pausarMilonga() {
  if (estadoPanel !== 'playing') return;
  estadoPanel = 'paused';
  if (audioEl && !audioEl.paused) audioEl.pause();
  if (audioCtx) audioCtx.suspend();
  detenerTimers();
  detenerVU();
  activarRing(false);
  actualizarBotones();
  actualizarLiveBadge();
  setEl('ia-texto', 'Radio en pausa.');
}

function reanudar() {
  estadoPanel = 'playing';
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (audioEl && audioEl.paused) audioEl.play();
  actualizarBotones();
  actualizarLiveBadge();
  activarRing(true);
  iniciarVU();
}

function stopMilonga() {
  estadoPanel = 'stopped';
  detenerAudio();
  detenerTimers();
  detenerVU();
  activarRing(false);
  actualizarBotones();
  actualizarLiveBadge();
  resetProgressUI();
  setEl('now-name', '—');
  setEl('now-orq',  '—');
  setEl('ia-texto', 'Radio detenida.');
  renderCola([]);
}

// ══════════════════════════════════════════════════════════════════════════
// REPRODUCCIÓN
// ══════════════════════════════════════════════════════════════════════════

function reproducirTema(index) {
  if (index >= biblioteca.length) { esperarNuevosTemas(); return; }
  const tema = biblioteca[index];
  detenerTimers();
  detenerAudio();
  renderTemaActual(tema, index);
  renderCola(biblioteca.slice(index + 1, index + 6));
  actualizarContadorTemas();
  reportarAlBackend(tema, 0);

  if (esCortina(tema)) { reproducirCortina(tema); return; }
  if (tema.AudioURL)   { reproducirAudio(tema, 0); return; }

  console.warn('Sin AudioURL — saltando:', tema.Titulo);
  setTimeout(avanzarTema, 800);
}

function reproducirDesdeOffset(tema, offsetSeg) {
  detenerTimers();
  detenerAudio();
  renderTemaActual(tema, indexActual);
  renderCola(biblioteca.slice(indexActual + 1, indexActual + 6));

  if (esCortina(tema)) {
    reproducirCortina(tema, offsetSeg);
    return;
  }
  if (tema.AudioURL) {
    reproducirAudio(tema, offsetSeg);
    return;
  }
  avanzarTema();
}

function avanzarTema() {
  if (estadoPanel === 'stopped' || estadoPanel === 'idle') return;
  indexActual++;
  if (indexActual >= biblioteca.length) { esperarNuevosTemas(); return; }
  reproducirTema(indexActual);
}

function esperarNuevosTemas() {
  setEl('ia-texto', 'Preparando próxima tanda…');
  const espera = setInterval(function () {
    if (estadoPanel === 'stopped' || estadoPanel === 'idle') { clearInterval(espera); return; }
    if (indexActual < biblioteca.length) { clearInterval(espera); reproducirTema(indexActual); return; }
    refrescarBiblioteca();
  }, 3000);
}

// ══════════════════════════════════════════════════════════════════════════
// AUDIO NATIVO CON WEB AUDIO API
// ══════════════════════════════════════════════════════════════════════════

function reproducirAudio(tema, offsetSeg) {
  const miGenId = ++audioGenId;
  const el      = new Audio();
  el.crossOrigin = 'anonymous';
  el.src         = tema.AudioURL;
  el.preload     = 'auto';
  audioEl        = el;

  // Duración: escuchar durationchange además de loadedmetadata
  function actualizarDuracion() {
    if (audioGenId !== miGenId || !el.duration || isNaN(el.duration)) return;
    const tot = Math.floor(el.duration);
    setEl('time-total', fmt(tot));
    // Reportar duracion real al backend
    reportarAlBackend(tema, tot);
  }
  el.addEventListener('loadedmetadata', actualizarDuracion);
  el.addEventListener('durationchange',  actualizarDuracion);

  el.addEventListener('canplaythrough', function onReady() {
    el.removeEventListener('canplaythrough', onReady);
    if (audioGenId !== miGenId) return;

    try { conectarAudioEl(el); } catch(e) { console.warn('Web Audio no disponible:', e); }

    if (offsetSeg > 0 && el.duration && offsetSeg < el.duration) {
      el.currentTime = offsetSeg;
    }

    el.play().catch(function (err) {
      if (audioGenId !== miGenId) return;
      console.warn('Error reproduciendo:', err);
      avanzarTema();
    });

    resetProgressUI();
    activarRing(true);
    iniciarVU();
  }, { once: true });

  el.addEventListener('ended', function () {
    if (audioGenId !== miGenId) return;
    detenerVU();
    avanzarTema();
  });

  el.addEventListener('error', function () {
    if (audioGenId !== miGenId) return;
    console.warn('Error de audio — saltando:', tema.Titulo);
    detenerVU();
    avanzarTema();
  });

  el.addEventListener('timeupdate', function () {
    if (audioGenId !== miGenId || !el.duration) return;
    const pct  = (el.currentTime / el.duration) * 100;
    const pf   = document.getElementById('progress-fill');
    if (pf) pf.style.width = pct.toFixed(1) + '%';
    setEl('time-current', fmt(el.currentTime));
    setEl('m-tiempo',     fmt(el.duration - el.currentTime));
  });
}

function reproducirCortina(tema, offsetSeg) {
  const FADE_IN  = 2000;
  const FADE_OUT = 4000;
  const STEP     = 50;
  const miGenId  = ++audioGenId;
  const durSeg   = CORTINA_DURACION_SEG;
  const inicio   = offsetSeg || 0;

  if (!tema.AudioURL) {
    activarRing(true);
    let seg = inicio;
    const tick = setInterval(function () {
      if (audioGenId !== miGenId) { clearInterval(tick); return; }
      seg++;
      const pct = Math.min((seg / durSeg) * 100, 100);
      const pf  = document.getElementById('progress-fill');
      if (pf) pf.style.width = pct.toFixed(1) + '%';
      setEl('time-current', fmt(seg));
      setEl('m-tiempo',     fmt(durSeg - seg));
      if (seg >= durSeg) { clearInterval(tick); if (audioGenId === miGenId) avanzarTema(); }
    }, 1000);
    cortinaTimer = tick;
    return;
  }

  const el       = new Audio();
  el.crossOrigin = 'anonymous';
  el.src         = tema.AudioURL;
  el.volume      = 0;
  el.preload     = 'auto';
  audioEl        = el;

  el.addEventListener('canplaythrough', function onReady() {
    el.removeEventListener('canplaythrough', onReady);
    if (audioGenId !== miGenId) return;

    try { conectarAudioEl(el); } catch(e) {}

    if (inicio > 0 && el.duration && inicio < el.duration) el.currentTime = inicio;

    el.play().catch(function () { if (audioGenId === miGenId) avanzarTema(); });

    resetProgressUI();
    setEl('time-total', fmt(durSeg));
    activarRing(true);

    let seg = inicio;
    const tick = setInterval(function () {
      if (audioGenId !== miGenId) { clearInterval(tick); return; }
      seg++;
      const pct = Math.min((seg / durSeg) * 100, 100);
      const pf  = document.getElementById('progress-fill');
      if (pf) pf.style.width = pct.toFixed(1) + '%';
      setEl('time-current', fmt(seg));
      setEl('m-tiempo',     fmt(durSeg - seg));
      if (seg >= durSeg) clearInterval(tick);
    }, 1000);
    cortinaTimer = tick;

    const targetVol = knobValue / 100;
    const stepsIn   = FADE_IN / STEP;
    const stepIn    = targetVol / stepsIn;
    const fi = setInterval(function () {
      if (audioGenId !== miGenId) { clearInterval(fi); return; }
      el.volume = Math.min(el.volume + stepIn, targetVol);
      if (gainNode) gainNode.gain.value = el.volume;
      if (el.volume >= targetVol) clearInterval(fi);
    }, STEP);

    const restante = (durSeg - inicio) * 1000;
    setTimeout(function () {
      if (audioGenId !== miGenId) return;
      const stepsOut = FADE_OUT / STEP;
      const stepOut  = el.volume / stepsOut;
      const fo = setInterval(function () {
        if (audioGenId !== miGenId) { clearInterval(fo); return; }
        el.volume = Math.max(el.volume - stepOut, 0);
        if (gainNode) gainNode.gain.value = el.volume;
        if (el.volume <= 0) {
          clearInterval(fo);
          detenerVU();
          if (audioGenId === miGenId) avanzarTema();
        }
      }, STEP);
    }, Math.max(restante - FADE_OUT, 0));

  }, { once: true });

  el.addEventListener('error', function () {
    if (audioGenId !== miGenId) return;
    avanzarTema();
  });
}

function detenerAudio() {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = '';
    audioEl     = null;
  }
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch(e) {}
    sourceNode = null;
  }
  audioGenId++;
}

// ══════════════════════════════════════════════════════════════════════════
// REPORTAR AL BACKEND
// ══════════════════════════════════════════════════════════════════════════

function reportarAlBackend(tema, duracionSeg) {
  if (!tema || !tema.ID) return;

  // Solo reportar una vez por tema salvo que cambie la duración real
  if (tema.ID === ultimoIDReportado && duracionSeg === 0) return;
  ultimoIDReportado = tema.ID;

  const params = new URLSearchParams({
    action:          'reportarReproduccion',
    ID:              tema.ID,
    Titulo:          tema.Titulo     || '',
    Orquesta:        tema.Orquesta   || '',
    Genero:          tema.Genero     || '',
    Estilo:          tema.Estilo     || '',
    Anio:            tema.Anio       || '',
    AudioURL:        tema.AudioURL   || '',
    esCortina:       esCortina(tema) ? '1' : '0',
    duracionSeg:     duracionSeg || 0,
    indexActual:     indexActual,
    totalBiblioteca: biblioteca.length,
  });

  fetch(GAS_URL + '?' + params.toString())
    .then(r => r.json())
    .then(function (data) {
      if (!data.ok) return;

      if (data.accion === 'tandaGenerada' && data.temasAgregados > 0) {
        setTimeout(refrescarBiblioteca, 2000);
      }

      if (data.mensajeIA) setEl('ia-texto', data.mensajeIA);
      if (data.proximaTanda) setEl('rec-proxima', 'Próxima tanda: ' + data.proximaTanda);

      // Mostrar frase de introducción si hay pedido activo
      if (data.frase) mostrarFrase(data.frase);
    })
    .catch(function (e) { console.warn('Error reportando:', e.message); });
}

// ══════════════════════════════════════════════════════════════════════════
// CHAT
// ══════════════════════════════════════════════════════════════════════════

function enviarChat() {
  const input = document.getElementById('chat-input');
  const usuario = document.getElementById('chat-usuario');
  if (!input) return;

  const msg  = (input.value || '').trim();
  const user = (usuario ? usuario.value : '') || 'Oyente';
  if (!msg) return;

  input.value = '';
  input.disabled = true;

  fetch(GAS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'enviarChat', usuario: user, mensaje: msg }),
  })
    .then(r => r.json())
    .then(function (data) {
      input.disabled = false;
      if (data.frase) mostrarFrase(data.frase);
      cargarChat();
    })
    .catch(function () { input.disabled = false; });
}

function cargarChat() {
  fetch(GAS_URL + '?action=getChat&limite=20')
    .then(r => r.json())
    .then(function (data) {
      if (!Array.isArray(data)) return;
      renderChat(data);
    })
    .catch(function () {});
}

function renderChat(mensajes) {
  const lista = document.getElementById('chat-lista');
  if (!lista) return;

  if (!mensajes.length) {
    lista.innerHTML = '<div class="chat-vacio">Sé el primero en saludar 🎵</div>';
    return;
  }

  lista.innerHTML = mensajes.map(function (m) {
    const ts    = m.Timestamp ? new Date(m.Timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
    const tipo  = String(m.Tipo || '').toUpperCase();
    const badge = tipo === 'PEDIDO'      ? '<span class="chat-badge pedido">pedido</span>'
                : tipo === 'DEDICATORIA' ? '<span class="chat-badge dedic">dedicatoria</span>'
                : '';
    const texto = m.MensajeTraducido || m.MensajeOriginal || '';
    return '<div class="chat-item">' +
      '<span class="chat-user">' + (m.Usuario || 'anon') + '</span>' +
      '<span class="chat-ts">'   + ts + '</span>' +
      badge +
      '<div class="chat-msg">'   + texto + '</div>' +
      '</div>';
  }).join('');

  lista.scrollTop = lista.scrollHeight;
}

function iniciarChatPolling() {
  if (chatTimer) return;
  cargarChat();
  chatTimer = setInterval(cargarChat, CHAT_POLLING_MS);
}

function mostrarFrase(frase) {
  if (!frase) return;
  setEl('ia-texto', frase);
  mostrarToast(frase);
}

// ══════════════════════════════════════════════════════════════════════════
// POLLING Y REFRESCO
// ══════════════════════════════════════════════════════════════════════════

async function refrescarBiblioteca() {
  try {
    const res  = await fetch(GAS_URL + '?action=getBiblioteca');
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return;

    const idsYaUsados = new Set(biblioteca.slice(0, indexActual + 1).map(t => t.ID));
    const nuevos      = data.filter(t => !idsYaUsados.has(t.ID));
    const longAntes   = biblioteca.length;

    biblioteca = biblioteca.slice(0, indexActual + 1).concat(nuevos);

    const diff = biblioteca.length - longAntes;
    if (diff > 0) {
      mostrarToast('+' + diff + ' tema' + (diff > 1 ? 's' : '') + ' en la radio');
      renderCola(biblioteca.slice(indexActual + 1, indexActual + 6));
      actualizarContadorTemas();
    }
  } catch (e) { console.warn('Error refrescando:', e); }
}

function iniciarPolling() {
  if (pollingTimer) return;
  pollingTimer = setInterval(refrescarBiblioteca, POLLING_MS);
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER UI
// ══════════════════════════════════════════════════════════════════════════

function renderBibliotecaCargada() {
  setEl('now-name', 'El Manijero Radio');
  setEl('now-orq',  biblioteca.length + ' temas listos');
  setEl('now-year', '');
  setEl('ia-texto', 'Radio lista. Presioná Play para entrar.');
  renderCola(biblioteca.slice(0, 5));
  actualizarContadorTemas();

  const conAudio = biblioteca.filter(t => !!t.AudioURL).length;
  const badge    = document.getElementById('live-badge');
  if (badge) {
    badge.innerHTML =
      '<div class="live-dot" style="background:#c9a84c;box-shadow:none"></div>' +
      '<span> ' + biblioteca.length + ' temas · ' + conAudio + ' con audio</span>';
  }
  setEl('badge-temas', biblioteca.length + ' temas');
  setEl('badge-sub',   conAudio + ' con audio');
}

function renderTemaActual(tema, index) {
  setEl('now-name', tema.Titulo   || '—');
  setEl('now-orq',  tema.Orquesta ? 'Orquesta ' + tema.Orquesta : '—');
  setEl('now-year',
    (tema.Anio   || '') +
    (tema.Genero ? ' · ' + tema.Genero : '') +
    (tema.Estilo ? ' · ' + tema.Estilo : '')
  );
  setEl('m-tanda-sub',    (tema.Genero || '') + ' · ' + (tema.Orquesta || ''));
  setEl('ia-footer-text', 'Tema ' + (index + 1) + ' de ' + biblioteca.length);
  setEl('badge-temas',    (index + 1) + ' / ' + biblioteca.length);
  setEl('badge-sub',      esCortina(tema) ? 'Cortina' : ('Tanda · ' + (tema.Genero || '')));
  setEl('time-total',     esCortina(tema) ? fmt(CORTINA_DURACION_SEG) : (tema.Duracion || '—'));

  // Métricas — solo reales
  setEl('meta-lufs', '—');
  setEl('meta-gain', '—');
  setEl('meta-tp',   '—');
  setEl('meta-rd',   '—');
  setEl('m-pista',        '—');
  setEl('m-personas',     '—');
  setEl('m-pista-sub',    'SIN CÁMARA');
  setEl('m-personas-sub', 'SIN CÁMARA');

  let html = '<span class="chip ch-' + (tema.Genero || '').toLowerCase() + '">' + (tema.Genero || '?') + '</span>';
  if (tema.Estilo && !esCortina(tema)) html += '<span class="chip ch-gold">' + tema.Estilo + '</span>';
  if (tema.Anio)                       html += '<span class="chip ch-gold">' + tema.Anio + '</span>';
  if (!esCortina(tema))                html += '<span class="chip ch-green">✓ Audio</span>';

  const chips = document.getElementById('now-chips');
  if (chips) chips.innerHTML = html;

  setEl('ia-texto', esCortina(tema)
    ? 'Cortina · ' + CORTINA_DURACION_SEG + 's · próxima tanda en camino.'
    : 'Reproduciendo en la radio global.');
}

function actualizarContadorTemas() {
  if (estadoPanel !== 'playing' && estadoPanel !== 'paused') {
    setEl('m-tanda', '0 / 0');
    return;
  }
  const tema = biblioteca[indexActual];
  if (!tema) return;
  if (esCortina(tema)) { setEl('m-tanda', 'Cortina'); return; }
  const pt = calcularPosEnTanda();
  setEl('m-tanda', pt.pos + ' / ' + pt.total);
}

function calcularPosEnTanda() {
  let pos = 1;
  for (let i = indexActual - 1; i >= 0; i--) {
    if (esCortina(biblioteca[i])) break;
    pos++;
  }
  let total = pos;
  for (let j = indexActual + 1; j < biblioteca.length; j++) {
    if (esCortina(biblioteca[j])) break;
    total++;
  }
  return { pos, total };
}

function renderCola(temas) {
  const lista = document.getElementById('queue-list');
  if (!lista) return;
  if (!temas.length) {
    lista.innerHTML = '<div class="q-item"><div class="q-info"><div class="q-track">Cola vacía</div></div></div>';
    return;
  }
  lista.innerHTML = temas.map(function (t, i) {
    const esNext = i === 0;
    const num    = indexActual + i + 2;
    return '<div class="q-item ' + (esNext ? 'q-next' : '') + '">' +
      (esNext ? '<i class="ti ti-arrow-right q-arrow"></i>' : '<span class="q-num">' + num + '</span>') +
      '<div class="q-info">' +
        '<div class="q-track">' + (t.Titulo || '—') + ' · ' + (t.Orquesta || '—') + '</div>' +
        '<div class="q-orq">'  + (esCortina(t) ? fmt(CORTINA_DURACION_SEG) : (t.Duracion || '—')) + ' · ' + (t.Estilo || '') + '</div>' +
      '</div>' +
      '<span class="chip ch-' + (t.Genero || '').toLowerCase() + '">' + (t.Genero || '') + '</span>' +
      '</div>';
  }).join('');
}

function actualizarBotones() {
  const bi = document.getElementById('btn-iniciar');
  const bp = document.getElementById('btn-pausar');
  const bs = document.getElementById('btn-stop');
  if (!bi) return;
  if (estadoPanel === 'idle' || estadoPanel === 'stopped') {
    bi.disabled  = !biblioteca.length;
    bi.innerHTML = '<i class="ti ti-player-play"></i> Entrar a la radio';
    if (bp) bp.disabled = true;
    if (bs) bs.disabled = true;
  } else if (estadoPanel === 'playing') {
    bi.disabled  = true;
    if (bp) { bp.disabled = false; bp.innerHTML = '<i class="ti ti-player-pause"></i> Pausar'; }
    if (bs) bs.disabled = false;
  } else if (estadoPanel === 'paused') {
    bi.disabled  = false;
    bi.innerHTML = '<i class="ti ti-player-play"></i> Continuar';
    if (bp) bp.disabled = true;
    if (bs) bs.disabled = false;
  }
}

function actualizarLiveBadge() {
  const b = document.getElementById('live-badge');
  if (!b) return;
  if (estadoPanel === 'playing') {
    b.innerHTML = '<div class="live-dot"></div><span> EN VIVO · Radio global</span>';
  } else if (estadoPanel === 'paused') {
    b.innerHTML = '<div class="live-dot" style="background:#c9a84c;animation:none"></div><span> En pausa</span>';
  } else {
    b.innerHTML = '<div class="live-dot" style="background:#555;animation:none"></div><span> Detenido</span>';
  }
}

// ══════════════════════════════════════════════════════════════════════════
// KNOB
// ══════════════════════════════════════════════════════════════════════════

function drawKnob(value) {
  const canvas = document.getElementById('knob-canvas');
  if (!canvas) return;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  const cx = W / 2, cy = H / 2;
  const r = W * 0.38, lw = W * 0.075;

  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, 2.25 * Math.PI);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();

  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, '#5C0E0E'); grad.addColorStop(1, '#C9924A');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, (0.75 + (value / 100) * 1.5) * Math.PI);
  ctx.strokeStyle = grad; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();

  const angle = (0.75 + (value / 100) * 1.5) * Math.PI;
  ctx.beginPath();
  ctx.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, lw * 0.7, 0, Math.PI * 2);
  ctx.fillStyle = '#E8B870'; ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = '#1A1008'; ctx.fill();
  ctx.strokeStyle = 'rgba(201,146,74,0.2)'; ctx.lineWidth = 1; ctx.stroke();

  const db = -40 + (value / 100) * 52;
  setEl('knob-db', (db > 0 ? '+' : '') + db.toFixed(1) + ' dB');
}

function getEventY(e) {
  if (e.touches && e.touches.length > 0)               return e.touches[0].clientY;
  if (e.changedTouches && e.changedTouches.length > 0) return e.changedTouches[0].clientY;
  return e.clientY;
}

function initKnob() {
  const canvas = document.getElementById('knob-canvas');
  if (!canvas) return;
  drawKnob(knobValue);
  canvas.addEventListener('mousedown', function (e) {
    knobDragging = true; knobStartY = getEventY(e); knobStartVal = knobValue; e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!knobDragging) return;
    knobValue = Math.max(0, Math.min(100, knobStartVal + (knobStartY - getEventY(e)) * 0.6));
    drawKnob(knobValue);
    const s = document.getElementById('vol');
    const o = document.getElementById('vol-out');
    if (s) s.value = Math.round(knobValue);
    if (o) o.textContent = Math.round(knobValue);
    if (gainNode) gainNode.gain.value = knobValue / 100;
    e.preventDefault();
  });
  window.addEventListener('mouseup', function () { knobDragging = false; });
  canvas.addEventListener('touchstart', function (e) {
    knobDragging = true; knobStartY = getEventY(e); knobStartVal = knobValue; e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', function (e) {
    if (!knobDragging) return;
    knobValue = Math.max(0, Math.min(100, knobStartVal + (knobStartY - getEventY(e)) * 0.6));
    drawKnob(knobValue);
    if (gainNode) gainNode.gain.value = knobValue / 100;
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', function () { knobDragging = false; });
}

// ══════════════════════════════════════════════════════════════════════════
// HELPERS UI
// ══════════════════════════════════════════════════════════════════════════

function esCortina(t) { return String(t.Genero || '').trim().toLowerCase() === 'cortina'; }
function fmt(seg) { const s = Math.max(0, Math.floor(seg)); return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0'); }
function setEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function activarRing(on) { const r = document.querySelector('.album-spinning-ring'); if (r) r.classList[on ? 'add' : 'remove']('active'); }

function resetProgressUI() {
  const pf = document.getElementById('progress-fill');
  if (pf) pf.style.width = '0%';
  setEl('time-current', '0:00');
  setEl('time-total',   '0:00');
  setEl('m-tiempo',     '—');
}

function detenerTimers() {
  if (cortinaTimer) { clearInterval(cortinaTimer); cortinaTimer = null; }
}

function mostrarEstadoCarga(msg) {
  const el = document.getElementById('carga-estado');
  if (!el) return;
  el.textContent   = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function mostrarToast(msg) {
  let t = document.getElementById('manijero-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'manijero-toast';
    t.style.cssText =
      'position:fixed;bottom:24px;right:24px;background:#1A1008;color:#C9924A;' +
      'border:1px solid rgba(201,146,74,0.4);border-radius:6px;padding:10px 18px;' +
      'font-size:13px;z-index:9999;opacity:0;transition:opacity .3s;' +
      'font-family:Oswald,sans-serif;letter-spacing:1px';
    document.body.appendChild(t);
  }
  t.textContent   = msg;
  t.style.opacity = '1';
  setTimeout(function () { t.style.opacity = '0'; }, 4000);
}

function updateClock() {
  const now   = new Date();
  const dias  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  setEl('evento-hora',  now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0'));
  setEl('evento-fecha', dias[now.getDay()] + ' ' + now.getDate() + ' ' + meses[now.getMonth()]);
}

function initSliders() {
  const vol = document.getElementById('vol');
  const volOut = document.getElementById('vol-out');
  if (vol) {
    vol.addEventListener('input', function () {
      knobValue = parseInt(vol.value);
      drawKnob(knobValue);
      if (volOut) volOut.textContent = Math.round(knobValue);
      if (gainNode) gainNode.gain.value = knobValue / 100;
    });
  }

  const bass = document.getElementById('bass');
  if (bass) {
    bass.addEventListener('input', function () {
      const v = ((parseInt(bass.value) - 50) / 50) * 15;
      if (bassFilter) bassFilter.gain.value = v;
      const o = document.getElementById('bass-out');
      if (o) o.textContent = Math.round(bass.value);
    });
  }

  const treble = document.getElementById('treble');
  if (treble) {
    treble.addEventListener('input', function () {
      const v = ((parseInt(treble.value) - 50) / 50) * 15;
      if (trebleFilter) trebleFilter.gain.value = v;
      const o = document.getElementById('treble-out');
      if (o) o.textContent = Math.round(treble.value);
    });
  }
}

function handleResize() {
  const wf = document.getElementById('waveform-canvas');
  const ev = document.getElementById('evolucion-canvas');
  if (wf) wf.width = wf.offsetWidth || 400;
  if (ev) ev.width = ev.offsetWidth  || 300;
}

console.log('El Manijero Radio v2.1 · listo');
