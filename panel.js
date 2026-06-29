/* ═══════════════════════════════════════════════════════════════════════════
   El Manijero · panel.js v2.0
   El frontend solo hace 5 cosas:
   1. Cargar biblioteca al inicio
   2. Reproducir audio
   3. Reportar fin de tema al backend
   4. Reportar cortina al backend (el backend decide la siguiente tanda)
   5. Refrescar estado cada 30 segundos
   Sin métricas inventadas. Sin decisiones de tanda.
   ═══════════════════════════════════════════════════════════════════════════ */

const GAS_URL = 'https://script.google.com/macros/s/AKfycbxq7UmItdXu-pr-bV26PWyD3aylipuGDAcTkfHyWNiIeXOnBg4DLMnSem0I5YHw2S23uA/exec';

const CORTINA_DURACION_SEG = 45;
const POLLING_INTERVAL_MS  = 30000;

// ── Estado global (mínimo necesario) ──────────────────────────────────────
let biblioteca    = [];
let indexActual   = 0;
let estadoPanel   = 'idle';   // idle · playing · paused · stopped
let sesionActualID = null;

// ── Audio ──────────────────────────────────────────────────────────────────
let audioEl    = null;
let audioGenId = 0;

// ── Timers ─────────────────────────────────────────────────────────────────
let cortinaTimer  = null;
let pollingTimer  = null;

// ── Knob ───────────────────────────────────────────────────────────────────
let knobValue    = 72;
let knobDragging = false;
let knobStartY   = 0;
let knobStartVal = 72;

// ══════════════════════════════════════════════════════════════════════════
// ARRANQUE
// ══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function() {
  updateClock();
  setInterval(updateClock, 30000);
  initSliders();
  initKnob();
  actualizarBotones();
  cargarBiblioteca();
  window.addEventListener('resize', handleResize);
  setTimeout(handleResize, 100);
});

// ══════════════════════════════════════════════════════════════════════════
// CARGAR BIBLIOTECA
// ══════════════════════════════════════════════════════════════════════════

async function cargarBiblioteca() {
  mostrarEstadoCarga('Conectando con el sistema…');

  try {
    // Primero traer estado del sistema para capturar sesionID
    const resEstado = await fetch(GAS_URL + '?action=getEstado');
    const estado    = await resEstado.json();

    if (estado.sesion && estado.sesion.sesionID) {
      sesionActualID = estado.sesion.sesionID;
      mostrarModo(estado.modo);
    }

    // Luego traer biblioteca
    const resBib = await fetch(GAS_URL + '?action=getBiblioteca');
    const data   = await resBib.json();

    if (!Array.isArray(data) || !data.length) {
      mostrarEstadoCarga('Biblioteca vacía. Iniciá la noche desde el panel.');
      return;
    }

    biblioteca = data;
    mostrarEstadoCarga(null);
    renderBibliotecaCargada();
    actualizarBotones();
    iniciarPolling();

  } catch(e) {
    console.warn('Error cargando biblioteca:', e);
    mostrarEstadoCarga('Error al conectar. Verificá la URL del GAS.');
  }
}

async function refrescarBiblioteca() {
  try {
    const res  = await fetch(GAS_URL + '?action=getBiblioteca');
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return;

    const temaActual   = biblioteca[indexActual];
    const idsYaUsados  = new Set(biblioteca.slice(0, indexActual + 1).map(t => t.ID));
    const nuevos       = data.filter(t => !idsYaUsados.has(t.ID));
    const longAntes    = biblioteca.length;

    biblioteca = biblioteca.slice(0, indexActual + 1).concat(nuevos);

    const diff = biblioteca.length - longAntes;
    if (diff > 0) {
      mostrarToast('+' + diff + ' tema' + (diff > 1 ? 's' : '') + ' agregado' + (diff > 1 ? 's' : ''));
      if (estadoPanel === 'playing') {
        renderCola(biblioteca.slice(indexActual + 1, indexActual + 6));
        actualizarContadorTemas();
      }
    }
  } catch(e) {
    console.warn('Error refrescando biblioteca:', e);
  }
}

function iniciarPolling() {
  if (pollingTimer) return;
  pollingTimer = setInterval(refrescarBiblioteca, POLLING_INTERVAL_MS);
}

// ══════════════════════════════════════════════════════════════════════════
// CONTROL DE MILONGA
// ══════════════════════════════════════════════════════════════════════════

function iniciarMilonga() {
  if (!biblioteca.length) return;
  if (estadoPanel === 'paused') { reanudar(); return; }
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
  detenerTimers();
  activarRing(false);
  actualizarBotones();
  actualizarLiveBadge();
  setEl('ia-texto', 'Milonga en pausa.');
}

function reanudar() {
  estadoPanel = 'playing';
  if (audioEl && audioEl.paused) audioEl.play();
  actualizarBotones();
  actualizarLiveBadge();
  activarRing(true);
}

function stopMilonga() {
  estadoPanel = 'stopped';
  detenerAudio();
  detenerTimers();
  activarRing(false);
  actualizarBotones();
  actualizarLiveBadge();
  resetProgressUI();
  setEl('now-name', '—');
  setEl('now-orq',  '—');
  setEl('ia-texto', 'Milonga detenida.');
  renderCola([]);
}

// ══════════════════════════════════════════════════════════════════════════
// REPRODUCCIÓN
// ══════════════════════════════════════════════════════════════════════════

function reproducirTema(index) {
  if (index >= biblioteca.length) {
    esperarNuevosTemas();
    return;
  }

  const tema = biblioteca[index];
  detenerTimers();
  detenerAudio();
  renderTemaActual(tema, index);
  renderCola(biblioteca.slice(index + 1, index + 6));
  actualizarContadorTemas();
  reportarAlBackend(tema);

  if (esCortina(tema)) {
    reproducirCortina(tema);
    return;
  }

  if (tema.AudioURL) {
    reproducirAudio(tema);
  } else {
    console.warn('Tema sin AudioURL — saltando:', tema.Titulo);
    setTimeout(avanzarTema, 800);
  }
}

function avanzarTema() {
  if (estadoPanel === 'stopped' || estadoPanel === 'idle') return;
  indexActual++;
  if (indexActual >= biblioteca.length) {
    esperarNuevosTemas();
    return;
  }
  reproducirTema(indexActual);
}

function esperarNuevosTemas() {
  setEl('ia-texto', 'Preparando próxima tanda…');
  const espera = setInterval(function() {
    if (estadoPanel === 'stopped' || estadoPanel === 'idle') {
      clearInterval(espera);
      return;
    }
    if (indexActual < biblioteca.length) {
      clearInterval(espera);
      reproducirTema(indexActual);
      return;
    }
    refrescarBiblioteca();
  }, 3000);
}

// ══════════════════════════════════════════════════════════════════════════
// AUDIO NATIVO
// ══════════════════════════════════════════════════════════════════════════

function reproducirAudio(tema) {
  const miGenId = ++audioGenId;
  const el      = new Audio();
  el.crossOrigin = 'anonymous';
  el.src         = tema.AudioURL;
  el.volume      = knobValue / 100;
  el.preload     = 'auto';
  audioEl        = el;

  el.addEventListener('loadedmetadata', function() {
    if (audioGenId !== miGenId) return;
    const tot = Math.floor(el.duration);
    setEl('time-total', Math.floor(tot / 60) + ':' + (tot % 60).toString().padStart(2, '0'));
  });

  el.addEventListener('canplaythrough', function onReady() {
    el.removeEventListener('canplaythrough', onReady);
    if (audioGenId !== miGenId) return;
    el.play().catch(function(err) {
      if (audioGenId !== miGenId) return;
      console.warn('Error al reproducir:', err);
      avanzarTema();
    });
    resetProgressUI();
    activarRing(true);
  }, { once: true });

  el.addEventListener('ended', function() {
    if (audioGenId !== miGenId) return;
    avanzarTema();
  });

  el.addEventListener('error', function() {
    if (audioGenId !== miGenId) return;
    console.warn('Error cargando audio — saltando:', tema.Titulo);
    avanzarTema();
  });

  el.addEventListener('timeupdate', function() {
    if (audioGenId !== miGenId || !el.duration) return;
    const pct = (el.currentTime / el.duration) * 100;
    const pf  = document.getElementById('progress-fill');
    if (pf) pf.style.width = pct.toFixed(1) + '%';
    const cur  = Math.floor(el.currentTime);
    const rest = Math.floor(el.duration - el.currentTime);
    setEl('time-current', fmt(cur));
    setEl('m-tiempo',     fmt(rest));
  });
}

function reproducirCortina(tema) {
  const FADE_IN_MS  = 2000;
  const FADE_OUT_MS = 4000;
  const STEP_MS     = 50;
  const miGenId     = ++audioGenId;

  // Si no tiene audio, simular duración
  if (!tema.AudioURL) {
    activarRing(true);
    let seg = 0;
    const tick = setInterval(function() {
      if (audioGenId !== miGenId) { clearInterval(tick); return; }
      seg++;
      const pct = Math.min((seg / CORTINA_DURACION_SEG) * 100, 100);
      const pf  = document.getElementById('progress-fill');
      if (pf) pf.style.width = pct.toFixed(1) + '%';
      setEl('time-current', fmt(seg));
      setEl('m-tiempo',     fmt(CORTINA_DURACION_SEG - seg));
      if (seg >= CORTINA_DURACION_SEG) {
        clearInterval(tick);
        if (audioGenId === miGenId) avanzarTema();
      }
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

    el.play().catch(function() {
      if (audioGenId === miGenId) avanzarTema();
    });

    resetProgressUI();
    setEl('time-total', '0:' + CORTINA_DURACION_SEG);
    activarRing(true);

    // Progreso manual de cortina
    let seg = 0;
    const tick = setInterval(function() {
      if (audioGenId !== miGenId) { clearInterval(tick); return; }
      seg++;
      const pct = Math.min((seg / CORTINA_DURACION_SEG) * 100, 100);
      const pf  = document.getElementById('progress-fill');
      if (pf) pf.style.width = pct.toFixed(1) + '%';
      setEl('time-current', fmt(seg));
      setEl('m-tiempo',     fmt(CORTINA_DURACION_SEG - seg));
      if (seg >= CORTINA_DURACION_SEG) clearInterval(tick);
    }, 1000);
    cortinaTimer = tick;

    // Fade in
    const targetVol = knobValue / 100;
    const stepsIn   = FADE_IN_MS / STEP_MS;
    const stepIn    = targetVol / stepsIn;
    const fadeIn    = setInterval(function() {
      if (audioGenId !== miGenId) { clearInterval(fadeIn); return; }
      el.volume = Math.min(el.volume + stepIn, targetVol);
      if (el.volume >= targetVol) clearInterval(fadeIn);
    }, STEP_MS);

    // Fade out + avanzar
    setTimeout(function() {
      if (audioGenId !== miGenId) return;
      const stepsOut = FADE_OUT_MS / STEP_MS;
      const stepOut  = el.volume / stepsOut;
      const fadeOut  = setInterval(function() {
        if (audioGenId !== miGenId) { clearInterval(fadeOut); return; }
        el.volume = Math.max(el.volume - stepOut, 0);
        if (el.volume <= 0) {
          clearInterval(fadeOut);
          if (audioGenId === miGenId) avanzarTema();
        }
      }, STEP_MS);
    }, (CORTINA_DURACION_SEG * 1000) - FADE_OUT_MS);

  }, { once: true });

  el.addEventListener('error', function() {
    if (audioGenId !== miGenId) return;
    console.warn('Error cargando cortina — saltando');
    avanzarTema();
  });
}

function detenerAudio() {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = '';
    audioEl     = null;
  }
  audioGenId++;
}

// ══════════════════════════════════════════════════════════════════════════
// REPORTAR AL BACKEND
// El backend decide si generar nueva tanda (cuando detecta cortina)
// ══════════════════════════════════════════════════════════════════════════

let ultimoIDReportado = null;

function reportarAlBackend(tema) {
  if (!tema || !tema.ID) return;
  if (tema.ID === ultimoIDReportado) return;
  ultimoIDReportado = tema.ID;

  const params = new URLSearchParams({
    action:          'reportarReproduccion',
    sesionID:        sesionActualID || '',
    ID:              tema.ID,
    Titulo:          tema.Titulo     || '',
    Orquesta:        tema.Orquesta   || '',
    Genero:          tema.Genero     || '',
    Estilo:          tema.Estilo     || '',
    Anio:            tema.Anio       || '',
    esCortina:       esCortina(tema) ? '1' : '0',
    indexActual:     indexActual,
    totalBiblioteca: biblioteca.length,
  });

  fetch(GAS_URL + '?' + params.toString())
    .then(r => r.json())
    .then(function(data) {
      if (!data.ok) return;

      // Capturar sesionID si el servidor lo devuelve
      if (data.sesionID && !sesionActualID) {
        sesionActualID = data.sesionID;
      }

      // Si el backend generó nueva tanda, refrescar biblioteca
      if (data.accion === 'tandaGenerada' && data.temasAgregados > 0) {
        setTimeout(refrescarBiblioteca, 2000);
      }

      // Mostrar mensaje del copiloto
      if (data.mensajeIA) {
        setEl('ia-texto', data.mensajeIA);
      }

      if (data.proximaTanda) {
        setEl('rec-proxima', 'Próxima tanda: ' + data.proximaTanda);
      }
    })
    .catch(function(err) {
      console.warn('Error reportando al backend:', err.message);
    });
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER UI
// ══════════════════════════════════════════════════════════════════════════

function renderBibliotecaCargada() {
  setEl('now-name', 'Listo para iniciar');
  setEl('now-orq',  biblioteca.length + ' temas cargados');
  setEl('now-year', '');
  setEl('ia-texto', 'Sistema listo. Presioná Iniciar Tanda para comenzar.');

  const chips = document.getElementById('now-chips');
  if (chips) chips.innerHTML = '<span class="chip ch-cortina">Sin datos aún</span>';

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
  setEl('m-tanda-sub', (tema.Genero || '') + ' · ' + (tema.Orquesta || ''));
  setEl('ia-footer-text', 'Tema ' + (index + 1) + ' de ' + biblioteca.length);
  setEl('badge-temas', (index + 1) + ' / ' + biblioteca.length);
  setEl('badge-sub',   esCortina(tema) ? 'Cortina' : ('Tanda · ' + (tema.Genero || '')));
  setEl('time-total',  esCortina(tema) ? '0:' + CORTINA_DURACION_SEG : (tema.Duracion || '—'));

  // Pista: mostrar estado real o aviso sin cámara
  actualizarUIPista();

  let html = '<span class="chip ch-' + (tema.Genero || '').toLowerCase() + '">' + (tema.Genero || '?') + '</span>';
  if (tema.Estilo && !esCortina(tema)) html += '<span class="chip ch-gold">' + tema.Estilo + '</span>';
  if (tema.BPM > 0)                   html += '<span class="chip ch-gold">' + tema.BPM + ' BPM</span>';
  if (tema.Energia)                   html += '<span class="chip ch-gold">Energía ' + String(tema.Energia).toLowerCase() + '</span>';
  if (!esCortina(tema))               html += '<span class="chip ch-green">✓ Audio HD</span>';

  const chips = document.getElementById('now-chips');
  if (chips) chips.innerHTML = html;

  setEl('ia-texto', esCortina(tema)
    ? 'Cortina activa · se cortará a los ' + CORTINA_DURACION_SEG + 's.'
    : 'Reproduciendo · el copiloto se actualiza al reportar al sistema.');

  // Limpiar métricas — no se inventan
  setEl('meta-lufs', '—');
  setEl('meta-gain', '—');
  setEl('meta-tp',   '—');
  setEl('meta-rd',   '—');
}

function actualizarUIPista() {
  // Sin cámara: mostrar aviso claro, no inventar datos
  setEl('m-pista',        '—');
  setEl('m-personas',     '—');
  setEl('m-pista-sub',    'SIN CÁMARA ACTIVA');
  setEl('m-personas-sub', 'SIN CÁMARA ACTIVA');
  setEl('g-energia',      '—');
  setEl('g-densidad',     '—');
  setEl('g-fatiga',       '—');
  setEl('g-conexion',     '—');
  setEl('g-energia-sub',  'sin datos');
  setEl('g-densidad-sub', 'sin datos');
  setEl('g-fatiga-sub',   'sin datos');
  setEl('g-conexion-sub', 'sin datos');
  setEl('pv-aplausos',    '—');
  setEl('pv-abandono',    '—');
}

function actualizarContadorTemas() {
  if (estadoPanel !== 'playing' && estadoPanel !== 'paused') {
    setEl('m-tanda', '0 / 0');
    return;
  }
  const tema = biblioteca[indexActual];
  if (!tema) return;
  if (esCortina(tema)) {
    setEl('m-tanda', 'Cortina');
  } else {
    const pt = calcularPosEnTanda();
    setEl('m-tanda', pt.pos + ' / ' + pt.total);
  }
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
  lista.innerHTML = temas.map(function(t, i) {
    const esNext = i === 0;
    const num    = indexActual + i + 2;
    return '<div class="q-item ' + (esNext ? 'q-next' : '') + '">' +
      (esNext
        ? '<i class="ti ti-arrow-right q-arrow"></i>'
        : '<span class="q-num">' + num + '</span>') +
      '<div class="q-info">' +
        '<div class="q-track">' + (t.Titulo || '—') + ' · ' + (t.Orquesta || '—') + '</div>' +
        '<div class="q-orq">' + (esCortina(t) ? '0:45' : (t.Duracion || '—')) + ' · ' + (t.Estilo || '') + '</div>' +
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
    bi.disabled = !biblioteca.length;
    bi.innerHTML = '<i class="ti ti-player-play"></i> Iniciar Tanda';
    bp.disabled  = true;
    bs.disabled  = true;
  } else if (estadoPanel === 'playing') {
    bi.disabled  = true;
    bp.disabled  = false;
    bs.disabled  = false;
    bp.innerHTML = '<i class="ti ti-player-pause"></i> Pausar';
  } else if (estadoPanel === 'paused') {
    bi.disabled  = false;
    bi.innerHTML = '<i class="ti ti-player-play"></i> Continuar';
    bp.disabled  = true;
    bs.disabled  = false;
  }
}

function actualizarLiveBadge() {
  const b = document.getElementById('live-badge');
  if (!b) return;
  if (estadoPanel === 'playing') {
    b.innerHTML = '<div class="live-dot"></div><span> En vivo · reproduciendo</span>';
  } else if (estadoPanel === 'paused') {
    b.innerHTML = '<div class="live-dot" style="background:#c9a84c;animation:none"></div><span> En pausa</span>';
  } else {
    b.innerHTML = '<div class="live-dot" style="background:#555;animation:none"></div><span> Detenido</span>';
  }
}

function mostrarModo(modo) {
  const modos = {
    RADIO:   'Modo Radio IA',
    DJ_AUTO: 'Modo DJ Automático',
    MILONGA: 'Modo Milonga Pro',
  };
  setEl('evento-nombre', modos[modo] || 'El Manijero');
}

// ══════════════════════════════════════════════════════════════════════════
// KNOB
// ══════════════════════════════════════════════════════════════════════════

function drawKnob(value) {
  const canvas = document.getElementById('knob-canvas');
  if (!canvas) return;
  const W   = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  const cx  = W / 2, cy = H / 2;
  const r   = W * 0.38, lw = W * 0.075;

  ctx.clearRect(0, 0, W, H);

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, 2.25 * Math.PI);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = lw;
  ctx.lineCap     = 'round';
  ctx.stroke();

  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, '#5C0E0E');
  grad.addColorStop(1, '#C9924A');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, (0.75 + (value / 100) * 1.5) * Math.PI);
  ctx.strokeStyle = grad;
  ctx.lineWidth   = lw;
  ctx.lineCap     = 'round';
  ctx.stroke();

  const angle = (0.75 + (value / 100) * 1.5) * Math.PI;
  ctx.beginPath();
  ctx.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, lw * 0.7, 0, Math.PI * 2);
  ctx.fillStyle = '#E8B870';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle   = '#1A1008';
  ctx.fill();
  ctx.strokeStyle = 'rgba(201,146,74,0.2)';
  ctx.lineWidth   = 1;
  ctx.stroke();

  const db = -40 + (value / 100) * 52;
  setEl('knob-db', (db > 0 ? '+' : '') + db.toFixed(1) + ' dB');
}

function getEventY(e) {
  if (e.touches && e.touches.length > 0)              return e.touches[0].clientY;
  if (e.changedTouches && e.changedTouches.length > 0) return e.changedTouches[0].clientY;
  return e.clientY;
}

function initKnob() {
  const canvas = document.getElementById('knob-canvas');
  if (!canvas) return;
  drawKnob(knobValue);
  canvas.addEventListener('mousedown',  function(e) {
    knobDragging = true; knobStartY = getEventY(e); knobStartVal = knobValue; e.preventDefault();
  });
  window.addEventListener('mousemove', function(e) {
    if (!knobDragging) return;
    const delta = (knobStartY - getEventY(e)) * 0.6;
    knobValue   = Math.max(0, Math.min(100, knobStartVal + delta));
    drawKnob(knobValue);
    const s = document.getElementById('vol');
    const o = document.getElementById('vol-out');
    if (s) s.value       = Math.round(knobValue);
    if (o) o.textContent = Math.round(knobValue);
    if (audioEl) audioEl.volume = Math.round(knobValue) / 100;
    e.preventDefault();
  });
  window.addEventListener('mouseup', function() { knobDragging = false; });
  canvas.addEventListener('touchstart', function(e) {
    knobDragging = true; knobStartY = getEventY(e); knobStartVal = knobValue; e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', function(e) {
    if (!knobDragging) return;
    const delta = (knobStartY - getEventY(e)) * 0.6;
    knobValue   = Math.max(0, Math.min(100, knobStartVal + delta));
    drawKnob(knobValue);
    if (audioEl) audioEl.volume = Math.round(knobValue) / 100;
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', function() { knobDragging = false; });
}

// ══════════════════════════════════════════════════════════════════════════
// HELPERS UI
// ══════════════════════════════════════════════════════════════════════════

function esCortina(t) {
  return String(t.Genero || '').trim().toLowerCase() === 'cortina';
}

function fmt(seg) {
  const s = Math.max(0, Math.floor(seg));
  return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function activarRing(on) {
  const r = document.querySelector('.album-spinning-ring');
  if (r) r.classList[on ? 'add' : 'remove']('active');
}

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
  el.textContent = msg || '';
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
  t.textContent    = msg;
  t.style.opacity  = '1';
  setTimeout(function() { t.style.opacity = '0'; }, 3000);
}

function updateClock() {
  const now   = new Date();
  const dias  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  setEl('evento-hora',  now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0'));
  setEl('evento-fecha', dias[now.getDay()] + ' ' + now.getDate() + ' ' + meses[now.getMonth()]);
}

function initSliders() {
  ['vol','bass','treble'].forEach(function(id) {
    const s = document.getElementById(id);
    const o = document.getElementById(id + '-out');
    if (!s || !o) return;
    s.addEventListener('input', function() {
      o.textContent = Math.round(s.value);
      if (id === 'vol') {
        knobValue = parseInt(s.value);
        drawKnob(knobValue);
        if (audioEl) audioEl.volume = knobValue / 100;
      }
    });
  });
}

function handleResize() {
  const wf = document.getElementById('waveform-canvas');
  const ev = document.getElementById('evolucion-canvas');
  if (wf) wf.width = wf.offsetWidth || 400;
  if (ev) ev.width = ev.offsetWidth  || 300;
}

console.log('El Manijero panel v2.0 · listo');
