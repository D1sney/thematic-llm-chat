import { createIconSwap } from './motion.js';

const MAX_BYTES = 3 * 1024 * 1024, MAX_SECONDS = 300;
const WAVE_STEP_MS = 210, WAVE_GAP = 7;
const mimeTypes = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
const messages = {
  TRANSCRIPTION_NOT_CONFIGURED: 'Распознавание голоса пока не настроено.',
  TRANSCRIPTION_TIMEOUT: 'Распознавание заняло слишком много времени. Запись сохранена для повтора.',
  TRANSCRIPTION_EMPTY: 'Не удалось разобрать речь. Попробуйте записать ещё раз.',
  TRANSCRIPTION_RATE_LIMITED: 'Слишком много записей. Попробуйте немного позже.',
  TRANSCRIPTION_RUNNING: 'Запись ещё распознаётся. Нажмите «Повторить» чуть позже.',
  AUDIO_FORMAT: 'Формат записи не поддерживается. Попробуйте записать ещё раз.',
  TRANSCRIPTION_UNAVAILABLE: 'Распознавание сейчас недоступно. Можно повторить без новой записи.',
  AUDIO_TOO_LARGE: 'Запись слишком большая. Запишите более короткое сообщение.',
};

// Recording is transient: no audio in localStorage, messages or attachments.
export function createVoiceInput({ composer, canStart, onChange, onResult, announce }) {
  const mic = composer.querySelector('#voice-start'), stop = composer.querySelector('#voice-stop');
  const cancel = composer.querySelector('#voice-cancel'), row = composer.querySelector('#voice-recording');
  const status = composer.querySelector('#voice-status'), time = composer.querySelector('#voice-time');
  const retry = composer.querySelector('#voice-retry'), error = composer.querySelector('#voice-error');
  const errorText = composer.querySelector('#voice-error-text');
  function hideError() { if (error.matches(':popover-open')) error.hidePopover(); error.hidden = true; errorText.textContent = ''; }
  function positionError() {
    if (!error.matches(':popover-open')) return;
    const r = composer.getBoundingClientRect();
    error.style.width = 'max-content'; error.style.maxWidth = `${Math.min(r.width, innerWidth - 24)}px`;
    const width = error.getBoundingClientRect().width;
    error.style.left = `${Math.max(12, Math.min(r.left, innerWidth - width - 12))}px`;
    error.style.top = `${Math.max(12, r.top - error.getBoundingClientRect().height - 12)}px`;
  }
  composer.querySelector('#voice-error-close').addEventListener('click', () => { hideError(); (phase === 'error' ? retry : mic).focus({ preventScroll: true }); });
  window.addEventListener('resize', positionError);
  new ResizeObserver(positionError).observe(composer);
  const canvas = composer.querySelector('canvas'), context = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const stopGlyphs = createIconSwap(mic.querySelector('svg').cloneNode(true), stop.querySelector('svg'));
  stop.append(stopGlyphs);
  let phase = 'idle', generation = 0, run = null;
  let layoutMotion = null, layoutVersion = 0, pointerMotion = false;
  const glyphMotions = new Map();
  composer.addEventListener('pointerdown', () => { pointerMotion = true; }, true);
  composer.addEventListener('keydown', () => { pointerMotion = false; }, true);

  function render() {
    const wasActive = Boolean(composer.dataset.voice && composer.dataset.voice !== 'idle');
    const active = phase !== 'idle', foldChanged = wasActive !== active;
    const previousHeight = foldChanged ? composer.getBoundingClientRect().height : 0;
    if (foldChanged) {
      layoutMotion?.cancel(); layoutMotion = null;
      delete composer.dataset.voiceFolding;
    }
    composer.dataset.voice = phase;
    row.hidden = !active;
    mic.hidden = active || !supported;
    stop.hidden = !['requesting', 'recording'].includes(phase);
    stop.disabled = phase !== 'recording';
    stopGlyphs.toggleAttribute('data-instant', !pointerMotion || reduced.matches);
    stopGlyphs.dataset.state = phase === 'recording' ? 'b' : 'a';
    retry.hidden = phase !== 'error' || !run?.blob;
    cancel.disabled = false;
    status.textContent = phase === 'requesting' ? 'Разрешите доступ к микрофону'
      : phase === 'transcribing' ? 'Распознаю речь…' : phase === 'error' ? 'Запись сохранена для повтора' : 'Записываю';
    status.classList.toggle('sr-only', phase === 'recording');
    row.setAttribute('aria-busy', String(phase === 'requesting' || phase === 'transcribing'));
    onChange();
    // Establish the microphone pose even when permission resolves in the same
    // frame, so the shared icon slot can shrink/fade it into the stop square.
    if (phase === 'requesting') getComputedStyle(stopGlyphs.querySelector('[data-icon="a"]')).opacity;
    if (foldChanged) {
      const version = ++layoutVersion;
      // This is the composer's content disclosure: animate its measured height
      // so the bottom stays anchored. Defer measurement until draft restoration
      // and resizeInput have settled; the waveform and controls are never scaled.
      queueMicrotask(() => {
        if (version !== layoutVersion || !pointerMotion || reduced.matches || document.hidden || !previousHeight) return;
        const nextHeight = composer.getBoundingClientRect().height;
        if (!nextHeight || Math.abs(previousHeight - nextHeight) < 1) return;
        composer.dataset.voiceFolding = '';
        const animation = composer.animate([{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }], {
          duration: 220, easing: getComputedStyle(composer).getPropertyValue('--ease-out').trim(),
        });
        layoutMotion = animation;
        for (const glyph of active ? [cancel.querySelector('svg'), canvas, sendIcon()] : [mic.querySelector('svg')]) {
          glyphMotions.get(glyph)?.cancel();
          const motion = glyph.animate([
            { opacity: .15, transform: glyph === canvas ? 'none' : 'translateY(2px) scale(.9)' },
            { opacity: 1, transform: 'none' },
          ], { duration: 180, easing: getComputedStyle(composer).getPropertyValue('--ease-out').trim() });
          glyphMotions.set(glyph, motion);
          motion.finished.catch(() => {}).then(() => { if (glyphMotions.get(glyph) === motion) glyphMotions.delete(glyph); });
        }
        animation.finished.catch(() => {}).then(() => {
          if (layoutMotion === animation) { layoutMotion = null; delete composer.dataset.voiceFolding; }
        });
      });
    }
  }
  function sendIcon() { return composer.querySelector('#send-button > svg'); }
  function releaseRecording(recording) {
    clearInterval(recording?.timer);
    cancelAnimationFrame(recording?.frame);
    recording?.stream?.getTracks().forEach(track => track.stop());
    recording?.audioContext?.close().catch(() => {});
    if (recording?.recorder?.state === 'recording') recording.recorder.stop();
  }
  function clear() {
    generation++;
    const previous = run;
    run = null; phase = 'idle';
    previous?.controller?.abort();
    releaseRecording(previous);
    for (const animation of glyphMotions.values()) animation.cancel();
    glyphMotions.clear();
    hideError();
    render();
  }
  function fail(text, recording = run) {
    if (recording !== run) return;
    releaseRecording(recording);
    errorText.textContent = text; error.hidden = false;
    if (recording?.blob) phase = 'error';
    else { run = null; phase = 'idle'; }
    render(); error.showPopover(); positionError(); announce(text);
  }
  function paint(recording, progress = 0) {
    const width = Math.round(canvas.getBoundingClientRect().width), height = 28;
    if (!width || !context) return;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio; canvas.height = height * ratio;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const count = Math.max(8, Math.floor(width / WAVE_GAP) + 1);
    if (recording.levels.length !== count) recording.levels = [...Array(Math.max(0, count - recording.levels.length)).fill(0), ...recording.levels].slice(-count);
    context.fillStyle = getComputedStyle(canvas).color;
    recording.levels.forEach((value, index) => {
      const barHeight = 3 + Math.min(1, value * 7) * 23;
      const x = index * WAVE_GAP - progress * WAVE_GAP;
      context.globalAlpha = Math.max(0, Math.min(1, (width - x) / 12, (x + 3) / 12));
      context.beginPath(); context.roundRect(x, (height - barHeight) / 2, 3, barHeight, 1.5); context.fill();
    });
    context.globalAlpha = 1;
  }
  function meter(recording) {
    // Failure to create an analyser must never prevent recording (Safari, suspended audio).
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      recording.audioContext = new Audio();
      recording.audioContext.resume().catch(() => {});
      const source = recording.audioContext.createMediaStreamSource(recording.stream);
      const analyser = recording.audioContext.createAnalyser(); analyser.fftSize = 256;
      source.connect(analyser);
      const values = new Uint8Array(analyser.fftSize);
      let lastStep = performance.now(), peak = 0;
      function frame(now) {
        if (run !== recording || phase !== 'recording') return;
        if (!reduced.matches) {
          analyser.getByteTimeDomainData(values);
          const rms = Math.sqrt(values.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / values.length);
          peak = Math.max(peak, rms);
          if (now - lastStep >= WAVE_STEP_MS) {
            recording.levels.push(peak); recording.levels.shift();
            peak = rms; lastStep = now - ((now - lastStep) % WAVE_STEP_MS);
          }
          paint(recording, (now - lastStep) / WAVE_STEP_MS);
        }
        recording.frame = requestAnimationFrame(frame);
      }
      if (!reduced.matches) recording.frame = requestAnimationFrame(frame);
    } catch { /* Static baseline and elapsed time still indicate recording. */ }
  }
  async function start() {
    if (phase !== 'idle' || !supported || !canStart()) return;
    const token = ++generation;
    const recording = { chunks: [], size: 0, levels: [], requestId: crypto.randomUUID() };
    run = recording; phase = 'requesting'; hideError(); time.textContent = '0:00'; render();
    cancel.focus({ preventScroll: true });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      if (generation !== token || document.hidden) {
        stream.getTracks().forEach(track => track.stop());
        if (run === recording) clear();
        return;
      }
      recording.stream = stream;
      const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
      recording.recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48000 });
      recording.recorder.addEventListener('dataavailable', event => {
        if (event.data.size) { recording.chunks.push(event.data); recording.size += event.data.size; }
        if (run === recording && phase === 'recording' && recording.size > MAX_BYTES - 65536) finish(false);
      });
      recording.recorder.addEventListener('error', () => fail('Микрофон прервал запись. Попробуйте записать ещё раз.', recording));
      recording.recorder.addEventListener('stop', () => {
        if (run !== recording || phase !== 'recording') return;
        // Microphone unplugged or browser stopped the capture: preserve the recorded portion.
        finish(false);
      });
      recording.recorder.start(1000);
      recording.started = performance.now(); phase = 'recording'; render();
      paint(recording); meter(recording);
      recording.timer = setInterval(() => {
        if (run !== recording) return;
        const seconds = Math.floor((performance.now() - recording.started) / 1000);
        time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        if (seconds >= MAX_SECONDS) finish(false);
      }, 250);
      announce('Идёт запись. Квадрат — вернуть текст, стрелка — отправить.');
    } catch (failure) {
      if (generation !== token) return;
      fail(failure.name === 'NotAllowedError' ? 'Нет доступа к микрофону. Разрешите его в настройках браузера.'
        : failure.name === 'NotFoundError' ? 'Микрофон не найден. Подключите его и попробуйте ещё раз.'
          : 'Не удалось включить микрофон. Проверьте, не занят ли он другим приложением.', recording);
    }
  }
  async function recognize(send, recovered = false) {
    const recording = run, token = generation;
    if (!recording?.blob) return;
    phase = 'transcribing'; hideError(); render();
    recording.controller = new AbortController();
    try {
      const response = await fetch(`/api/v1/audio/transcriptions?request_id=${recording.requestId}`, {
        method: 'POST', body: recording.blob, signal: recording.controller.signal,
        headers: { 'Content-Type': recording.blob.type },
      });
      const body = await response.json().catch(() => null);
      if (generation !== token) return;
      if (!response.ok) {
        const code = body?.error?.code;
        // A manual retry may discover that its old request died with the server.
        // Only a confirmed terminal attempt permits a new paid request here.
        if (['TRANSCRIPTION_INTERRUPTED', 'TRANSCRIPTION_FAILED'].includes(code) && !recovered) {
          recording.requestId = crypto.randomUUID();
          return recognize(send, true);
        }
        // Unknown outcomes keep the ID: a retry retrieves a saved result without billing twice.
        if (!['TRANSCRIPTION_RUNNING'].includes(code) && code) recording.requestId = crypto.randomUUID();
        throw new Error(messages[code] || 'Не удалось распознать запись. Можно повторить без новой записи.');
      }
      if (!body || typeof body.text !== 'string' || !body.text.trim()) throw new Error('Не удалось разобрать речь. Попробуйте записать ещё раз.');
      const text = body.text.trim();
      clear();
      onResult(text, send, body.request_id);
    } catch (failure) {
      if (generation !== token || failure.name === 'AbortError') return;
      fail(failure.message === 'Failed to fetch' ? 'Нет связи с сервером. Запись сохранена для повтора.' : failure.message, recording);
    }
  }
  async function finish(send) {
    if (phase !== 'recording') return;
    const recording = run;
    phase = 'transcribing'; render();
    if (recording.recorder.state !== 'inactive') {
      await new Promise(resolve => {
        recording.recorder.addEventListener('stop', resolve, { once: true });
        recording.recorder.stop();
      });
    }
    releaseRecording(recording);
    if (run !== recording) return;
    recording.blob = new Blob(recording.chunks, { type: recording.recorder.mimeType }); recording.chunks = [];
    if (!recording.blob.size) { fail('Запись пустая. Попробуйте записать ещё раз.', recording); return; }
    if (recording.blob.size > MAX_BYTES) { recording.blob = null; fail('Запись слишком большая. Запишите более короткое сообщение.', recording); return; }
    await recognize(send);
  }
  mic.addEventListener('click', start);
  stop.addEventListener('click', () => finish(false));
  cancel.addEventListener('click', () => { clear(); mic.focus({ preventScroll: true }); announce('Запись отменена'); });
  retry.addEventListener('click', () => recognize(false));
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && phase !== 'idle' && !event.defaultPrevented) { event.preventDefault(); pointerMotion = false; clear(); mic.focus({ preventScroll: true }); } });
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && phase === 'idle' && error.matches(':popover-open')) { hideError(); mic.focus({ preventScroll: true }); } });
  window.addEventListener('pagehide', clear);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (phase === 'requesting') clear();
    else if (phase === 'recording') finish(false);
  });
  return { get active() { return phase !== 'idle'; }, get recording() { return phase === 'recording'; }, start, finish, cancel: clear,
    update(disabled) { mic.disabled = disabled; if (phase === 'idle') mic.hidden = !supported; } };
}
