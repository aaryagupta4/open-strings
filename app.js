/**
 * Open Strings — application entry point.
 *
 * Responsibilities:
 *   - Mic permission + WebAudio graph.
 *   - Per-frame YIN pitch detection (see yin.js) with an RMS gate.
 *   - Mapping detected Hz -> nearest violin open string + cents deviation.
 *   - Trail canvas: rolling ~2s history of cents deviation.
 *   - Reference-tone playback (synthesized bowed tone for now).
 *   - Fifths mode: two-peak FFT detection + beat-frequency readout.
 *
 * Design notes:
 *   - No dependencies. Ships as static files.
 *   - Frame size 2048 at 48 kHz = ~43 ms of audio, ~24 fps redraws.
 *   - We median-smooth the last 5 detections to kill occasional YIN
 *     octave errors on violin's rich harmonic spectrum.
 */
(function () {
  "use strict";

  // Violin open strings
  const STRINGS = [
    { note: "G", hz: 196.00,  octave: 3 },
    { note: "D", hz: 293.66,  octave: 4 },
    { note: "A", hz: 440.00,  octave: 4 },
    { note: "E", hz: 659.25,  octave: 5 },
  ];

  const CENT_RANGE = 50;            // trail y-axis clamped to ±50 cents
  const HISTORY_MS = 2000;          // trail duration
  const MIN_RMS = 0.008;            // gate: silence below this
  const MIN_CLARITY = 0.55;         // gate: YIN clarity below this is trash
  const FRAME_SIZE = 2048;
  const SMOOTH_N = 5;               // median filter length

  // ============================================================
  // State
  // ============================================================
  let audioCtx = null;
  let analyser = null;
  let inputSource = null;
  let running = false;
  let mode = "single";

  const trailPoints = [];           // [{t, cents, hz, note}]
  const recentHz = [];              // for median smoothing

  // ============================================================
  // DOM refs
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const startCard   = $("start-card");
  const btnStart    = $("btn-start");
  const tunerSingle = $("tuner-single");
  const tunerFifths = $("tuner-fifths");
  const targetNote  = $("target-note");
  const targetFreq  = $("target-freq");
  const detectedHz  = $("detected-hz");
  const detectedCts = $("detected-cents");
  const stabilityEl = $("stability");
  const trailCanvas = $("trail");
  const trailCtx    = trailCanvas.getContext("2d");
  const fpLower     = $("fp-lower");
  const fpUpper     = $("fp-upper");
  const fifthRatio  = $("fifth-ratio");
  const fifthCents  = $("fifth-cents");
  const fifthBeats  = $("fifth-beats");

  // Mode toggle
  document.querySelectorAll(".mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode").forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-selected", "true");
      mode = btn.dataset.mode;
      tunerSingle.hidden = mode !== "single";
      tunerFifths.hidden = mode !== "fifths";
    });
  });

  // Reference-tone buttons
  document.querySelectorAll(".string-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const hz = parseFloat(btn.dataset.freq);
      playReference(hz, btn);
    });
  });

  btnStart.addEventListener("click", async () => {
    try {
      btnStart.disabled = true;
      btnStart.textContent = "Requesting mic…";
      await start();
      startCard.hidden = true;
      tunerSingle.hidden = false;
      resizeTrail();
      loop();
    } catch (err) {
      btnStart.disabled = false;
      btnStart.textContent = "Try again";
      console.error(err);
      alert("Couldn't access the mic. Check permissions and reload.");
    }
  });

  window.addEventListener("resize", resizeTrail);

  // ============================================================
  // Audio pipeline
  // ============================================================
  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    inputSource = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FRAME_SIZE;
    analyser.smoothingTimeConstant = 0;
    inputSource.connect(analyser);
    running = true;
  }

  function loop() {
    if (!running) return;
    if (mode === "single") tickSingle();
    else if (mode === "fifths") tickFifths();
    requestAnimationFrame(loop);
  }

  // ============================================================
  // Single-string tick
  // ============================================================
  function tickSingle() {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);

    const level = YIN.rms(buf);
    if (level < MIN_RMS) {
      renderIdle();
      return;
    }

    const { hz, clarity } = YIN.detectYin(buf, audioCtx.sampleRate);
    if (!isFinite(hz) || clarity < MIN_CLARITY) {
      renderIdle();
      return;
    }

    recentHz.push(hz);
    while (recentHz.length > SMOOTH_N) recentHz.shift();
    const smoothed = median(recentHz);

    const target = nearestString(smoothed);
    const cents = 1200 * Math.log2(smoothed / target.hz);
    const now = performance.now();
    trailPoints.push({ t: now, cents, hz: smoothed });
    // trim to HISTORY_MS
    while (trailPoints.length && now - trailPoints[0].t > HISTORY_MS) trailPoints.shift();

    render(smoothed, cents, target);
  }

  function renderIdle() {
    targetNote.textContent = "—";
    targetNote.classList.add("silent");
    targetFreq.textContent = "listening…";
    detectedHz.textContent = "— Hz";
    detectedCts.textContent = "—";
    detectedCts.className = "readout-value";
    stabilityEl.textContent = "—";

    // still draw the trail so it visibly fades / drops
    const now = performance.now();
    while (trailPoints.length && now - trailPoints[0].t > HISTORY_MS) trailPoints.shift();
    drawTrail();
  }

  function render(hz, cents, target) {
    targetNote.classList.remove("silent");
    targetNote.textContent = target.note;
    targetFreq.textContent = target.hz.toFixed(2) + " Hz";
    detectedHz.textContent = hz.toFixed(2) + " Hz";
    const sign = cents >= 0 ? "+" : "−";
    detectedCts.textContent = sign + Math.abs(cents).toFixed(1) + "¢";

    detectedCts.className = "readout-value " + tuneClass(cents);
    stabilityEl.textContent = stabilityLabel();
    drawTrail();
  }

  function tuneClass(cents) {
    if (Math.abs(cents) <= 3) return "tune-in";
    if (cents < 0) return "tune-flat";
    return "tune-sharp";
  }

  function stabilityLabel() {
    // Std-dev of last ~40 points of cents deviation.
    const n = Math.min(40, trailPoints.length);
    if (n < 6) return "…";
    let mean = 0;
    for (let i = trailPoints.length - n; i < trailPoints.length; i++) mean += trailPoints[i].cents;
    mean /= n;
    let variance = 0;
    for (let i = trailPoints.length - n; i < trailPoints.length; i++) {
      const d = trailPoints[i].cents - mean;
      variance += d * d;
    }
    const sd = Math.sqrt(variance / n);
    if (sd < 1.5) return "rock-steady";
    if (sd < 4)   return "steady";
    if (sd < 10)  return "wavering";
    return "drifting";
  }

  // ============================================================
  // Trail canvas
  // ============================================================
  function resizeTrail() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const rect = trailCanvas.getBoundingClientRect();
    trailCanvas.width = Math.floor(rect.width * dpr);
    trailCanvas.height = Math.floor(rect.height * dpr);
    trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawTrail() {
    const rect = trailCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    trailCtx.clearRect(0, 0, w, h);

    // ±10 cent tolerance band (subtle sage rectangle)
    const cs = getComputedStyle(document.documentElement);
    const sage = cs.getPropertyValue("--tune-in").trim();
    const red  = cs.getPropertyValue("--tune-sharp").trim();
    const purple = cs.getPropertyValue("--tune-flat").trim();
    const rule = cs.getPropertyValue("--rule").trim();

    const bandY0 = centsToY(+10, h);
    const bandY1 = centsToY(-10, h);
    trailCtx.fillStyle = hexToRgba(sage, 0.10);
    trailCtx.fillRect(0, bandY0, w, bandY1 - bandY0);

    // baseline (in-tune) line
    trailCtx.strokeStyle = hexToRgba(sage, 0.7);
    trailCtx.setLineDash([2, 4]);
    trailCtx.beginPath();
    trailCtx.moveTo(0, h / 2);
    trailCtx.lineTo(w, h / 2);
    trailCtx.stroke();
    trailCtx.setLineDash([]);

    if (trailPoints.length < 2) return;

    const now = performance.now();
    trailCtx.lineWidth = 2;
    trailCtx.strokeStyle = hexToRgba(cs.getPropertyValue("--ink").trim(), 0.7);
    trailCtx.beginPath();
    for (let i = 0; i < trailPoints.length; i++) {
      const p = trailPoints[i];
      const age = now - p.t;
      const x = w - (age / HISTORY_MS) * w;
      const y = centsToY(p.cents, h);
      if (i === 0) trailCtx.moveTo(x, y); else trailCtx.lineTo(x, y);
    }
    trailCtx.stroke();

    // Latest point emphasized
    const last = trailPoints[trailPoints.length - 1];
    const lx = w;
    const ly = centsToY(last.cents, h);
    trailCtx.fillStyle =
      Math.abs(last.cents) <= 3 ? sage : (last.cents < 0 ? purple : red);
    trailCtx.beginPath();
    trailCtx.arc(lx - 2, ly, 5, 0, Math.PI * 2);
    trailCtx.fill();
  }

  function centsToY(cents, h) {
    const clamped = Math.max(-CENT_RANGE, Math.min(CENT_RANGE, cents));
    // -50 -> bottom, +50 -> top
    return h / 2 - (clamped / CENT_RANGE) * (h / 2 - 8);
  }

  // ============================================================
  // Fifths mode
  //   Take FFT magnitudes, find the two strongest peaks under 900 Hz
  //   (fundamentals of any adjacent violin pair fall well below).
  //   Report interval as cents from a pure 3:2 (~701.955 cents), plus
  //   the beat frequency between their nearest coincident harmonic.
  // ============================================================
  function tickFifths() {
    const N = analyser.frequencyBinCount;
    const mags = new Float32Array(N);
    analyser.getFloatFrequencyData(mags); // dB
    const sr = audioCtx.sampleRate;
    const binHz = sr / analyser.fftSize;

    // Consider only 150–900 Hz for open-string fundamentals
    const lo = Math.floor(150 / binHz);
    const hi = Math.floor(900 / binHz);

    const peaks = findPeaks(mags, lo, hi, 2);
    if (peaks.length < 2 || peaks[1].dB < -70) {
      renderFifthsIdle();
      return;
    }

    // Parabolic refinement of the peak bin for better freq resolution
    const p1 = refinePeak(mags, peaks[0].bin) * binHz;
    const p2 = refinePeak(mags, peaks[1].bin) * binHz;
    const lower = Math.min(p1, p2);
    const upper = Math.max(p1, p2);

    // Cents from pure fifth (3:2)
    const intervalCents = 1200 * Math.log2(upper / lower);
    const centsFromPure = intervalCents - 1200 * Math.log2(3 / 2);

    // Beat frequency: 3f_lower vs 2f_upper is the strongest coincident pair.
    const beats = Math.abs(3 * lower - 2 * upper);

    fpLower.textContent = nearestString(lower).note;
    fpUpper.textContent = nearestString(upper).note;
    fifthRatio.textContent = (upper / lower).toFixed(4);
    fifthCents.textContent = fmtCents(centsFromPure) + " from pure";
    fifthBeats.textContent = beats.toFixed(2) + " Hz beating";
  }

  function renderFifthsIdle() {
    fpLower.textContent = "—";
    fpUpper.textContent = "—";
    fifthRatio.textContent = "—";
    fifthCents.textContent = "— cents from pure";
    fifthBeats.textContent = "— Hz beating";
  }

  function findPeaks(mags, lo, hi, count) {
    const found = [];
    for (let i = lo + 1; i < hi - 1; i++) {
      if (mags[i] > mags[i - 1] && mags[i] > mags[i + 1] && mags[i] > -85) {
        found.push({ bin: i, dB: mags[i] });
      }
    }
    found.sort((a, b) => b.dB - a.dB);
    return found.slice(0, count).sort((a, b) => a.bin - b.bin);
  }

  function refinePeak(mags, bin) {
    if (bin <= 0 || bin >= mags.length - 1) return bin;
    const a = mags[bin - 1], b = mags[bin], c = mags[bin + 1];
    const denom = (a - 2 * b + c);
    if (denom === 0) return bin;
    return bin + 0.5 * (a - c) / denom;
  }

  // ============================================================
  // Reference tone: synthesized bowed sound (to be replaced with
  // real violin samples once recorded).
  // ============================================================
  function playReference(hz, btn) {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const now = audioCtx.currentTime;
    const dur = 1.6;

    // Very short attack + slow release, sawtooth through a lowpass, a
    // touch of vibrato. Sounds violinish, ships today.
    const osc = audioCtx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = hz;

    const vibrato = audioCtx.createOscillator();
    vibrato.frequency.value = 5.5;
    const vibGain = audioCtx.createGain();
    vibGain.gain.value = hz * 0.005;
    vibrato.connect(vibGain).connect(osc.frequency);

    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    lp.Q.value = 0.7;

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.05);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.8);
    gain.gain.linearRampToValueAtTime(0.0,  now + dur);

    osc.connect(lp).connect(gain).connect(audioCtx.destination);
    osc.start(now);
    vibrato.start(now);
    osc.stop(now + dur + 0.05);
    vibrato.stop(now + dur + 0.05);

    if (btn) {
      btn.classList.add("playing");
      setTimeout(() => btn.classList.remove("playing"), dur * 1000);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================
  function nearestString(hz) {
    let best = STRINGS[0], bestCents = Infinity;
    for (const s of STRINGS) {
      const c = Math.abs(1200 * Math.log2(hz / s.hz));
      if (c < bestCents) { best = s; bestCents = c; }
    }
    return best;
  }

  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function fmtCents(c) {
    const sign = c >= 0 ? "+" : "−";
    return sign + Math.abs(c).toFixed(1) + "¢";
  }

  function hexToRgba(hex, a) {
    // Accepts "#rgb" or "#rrggbb"; returns rgba() string.
    let h = hex.trim().replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
})();
