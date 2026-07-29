/**
 * YIN pitch detection — a compact implementation of the algorithm from
 * "YIN, a fundamental frequency estimator for speech and music"
 * (de Cheveigné & Kawahara, 2002).
 *
 * Steps 1–4 of the paper:
 *   1. difference function        d(τ) = Σ (x_i − x_{i+τ})²
 *   2. cumulative mean normalized d′(τ) = d(τ) · τ / Σ_{k=1..τ} d(k)
 *   3. absolute threshold         first τ where d′(τ) < threshold
 *   4. parabolic interpolation    refine τ around that local minimum
 *
 * Returns Hz, or NaN if no periodic signal is found in the frame.
 */
(function () {
  "use strict";

  const DEFAULT_THRESHOLD = 0.12; // slightly tighter than the paper's 0.15

  function difference(buf, halfN) {
    const d = new Float32Array(halfN);
    for (let tau = 1; tau < halfN; tau++) {
      let sum = 0;
      for (let i = 0; i < halfN; i++) {
        const delta = buf[i] - buf[i + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }
    return d;
  }

  function cumulativeMeanNormalizedDifference(d) {
    const out = new Float32Array(d.length);
    out[0] = 1;
    let running = 0;
    for (let tau = 1; tau < d.length; tau++) {
      running += d[tau];
      out[tau] = d[tau] * tau / (running || 1e-12);
    }
    return out;
  }

  function absoluteThreshold(dprime, threshold) {
    for (let tau = 2; tau < dprime.length; tau++) {
      if (dprime[tau] < threshold) {
        // descend into the local minimum
        while (tau + 1 < dprime.length && dprime[tau + 1] < dprime[tau]) {
          tau++;
        }
        return tau;
      }
    }
    return -1;
  }

  function parabolicInterpolation(dprime, tau) {
    const x0 = tau > 0 ? tau - 1 : tau;
    const x2 = tau + 1 < dprime.length ? tau + 1 : tau;
    if (x0 === tau) return dprime[tau] <= dprime[x2] ? tau : x2;
    if (x2 === tau) return dprime[tau] <= dprime[x0] ? tau : x0;
    const s0 = dprime[x0], s1 = dprime[tau], s2 = dprime[x2];
    return tau + (s2 - s0) / (2 * (2 * s1 - s2 - s0));
  }

  /**
   * @param {Float32Array} samples  - time-domain audio in [-1, 1]
   * @param {number} sampleRate     - Hz, e.g. 48000
   * @param {object} [opts]
   * @param {number} [opts.threshold=0.12]
   * @returns {{hz: number, clarity: number}} clarity in [0,1]; NaN if unpitched
   */
  function detectYin(samples, sampleRate, opts) {
    const threshold = (opts && opts.threshold) || DEFAULT_THRESHOLD;
    const halfN = Math.floor(samples.length / 2);
    if (halfN < 32) return { hz: NaN, clarity: 0 };

    const d = difference(samples, halfN);
    const dprime = cumulativeMeanNormalizedDifference(d);
    const tau = absoluteThreshold(dprime, threshold);
    if (tau === -1) return { hz: NaN, clarity: 0 };

    const refined = parabolicInterpolation(dprime, tau);
    const hz = sampleRate / refined;
    // Clarity: 1 - d'(τ), clamped.
    const clarity = Math.max(0, Math.min(1, 1 - dprime[tau]));
    return { hz, clarity };
  }

  /**
   * Root-mean-square level of a frame, [0, 1].
   * Used as a gate: below a minimum level, we ignore YIN output.
   */
  function rms(samples) {
    let s = 0;
    for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / samples.length);
  }

  // Expose on window
  window.YIN = { detectYin, rms };
})();
