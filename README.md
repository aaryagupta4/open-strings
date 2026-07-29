# open-strings

A browser-based violin tuner that tunes in perfect fifths, the way
string players actually do it. Also does regular single-string tuning.

Live: **https://aaryagupta4.github.io/open-strings/**

## Why

Every browser tuner I could find is chromatic-by-default (88 possible
targets when a violinist only cares about four) and shows a hunting
needle without any indication of *stability*. None of them support
tuning by fifths — bowing two strings together and listening for beats
to disappear — which is how real violinists tune.

## What's different

- **Fifths mode.** Bow two adjacent strings; the tuner locates both
  fundamentals via short-FFT peak-picking and reports the interval
  in cents from a pure 3:2, plus the beat frequency between their
  nearest coincident harmonic (3 × f_lower vs 2 × f_upper).
- **Cent trail, not a needle.** The last ~2 seconds of pitch draw as a
  rolling trail against a ±10¢ tolerance band. Reveals *stability*, not
  just direction.
- **Reference-tone playback.** Tap G, D, A, or E to hear the target
  pitch. Currently synthesized (sawtooth through a lowpass, mild
  vibrato); real bowed samples coming soon.
- **YIN, hand-implemented.** ~90 lines of pitch detection in `yin.js`.
  No pitchfinder / pitchy / crepe dependency.
- **No build step, no dependencies.** Static HTML/CSS/JS. Deploys
  anywhere.

## Local preview

```bash
python -m http.server 8000
# open http://localhost:8000
```

## Files

- `index.html` — markup
- `styles.css` — palette variables at the top; light/dark via
  `prefers-color-scheme`
- `yin.js` — YIN pitch detection + RMS gate
- `app.js` — WebAudio graph, mode switching, trail, fifths mode,
  reference tones
- `samples/` — (planned) real bowed violin samples for reference
  playback

## Roadmap

- [ ] Record real bowed violin samples for G3 / D4 / A4 / E5, drop into
      `samples/` and switch `playReference` off the synth
- [ ] Temperament switcher (A = 440 / 442 / 415 Hz)
- [ ] Vibrato analyzer (speed in Hz, depth peak-to-peak in cents)
- [ ] Cent trail expansion — hover to inspect any past instant

## Credits

YIN algorithm: de Cheveigné & Kawahara (2002), *YIN, a fundamental
frequency estimator for speech and music*.

## License

MIT.
