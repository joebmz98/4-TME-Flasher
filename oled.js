// A 128x32 copy of 4-TME's SSD1306, drawn pixel for pixel like the firmware:
// the main screen's generative art (one planet per voice over a starfield,
// drawArt() in the sketch), the parameter readout shown while a knob turns,
// and the short SAVED / LOADED messages. Text is Picopixel from the Adafruit
// GFX Library, the same bitmaps the firmware draws with.

import { P, NUM_VOICES, PARAMS, paramValue, formatParam, CUTOFF_MAX_OCT, triLfo } from './protocol.js';

export const W = 128;
export const H = 32;

const PICO_BMP = 'e8b457d5f5004e3e80a54a4a5a50c06a409580aa805d0060e080254856d47540c54ec51c9792f31c5354e54855545594a04664e38098c50456c657dad75c7246d6dcf3cef34872d4b7daf824d4bb5a924e8eeb58809db99056d4d74856d440d75a711ce924b6d4b6a48c6b5500b55ab524e54eeac09112d5c054f090c7f0935e718025de5e306e80779c935ab8456092eaaa40d56ad6805500d7407590e871e0ba40b580b5008d54aa80ace0e5706a26fcc8ac5a';
const PICO_GLY = [0,0,0,2,0,1,0,1,5,2,0,-4,1,3,2,4,0,-4,2,5,5,6,0,-4,6,3,6,4,0,-4,9,3,5,4,0,-4,11,4,5,5,0,-4,14,1,2,2,0,-4,15,2,5,3,0,-4,17,2,5,3,0,-4,19,3,3,4,0,-3,21,3,3,4,0,-3,23,2,2,3,0,0,24,3,1,4,0,-2,25,1,1,2,0,0,26,3,5,4,0,-4,28,3,5,4,0,-4,30,2,5,3,0,-4,32,3,5,4,0,-4,34,3,5,4,0,-4,36,3,5,4,0,-4,38,3,5,4,0,-4,40,3,5,4,0,-4,42,3,5,4,0,-4,44,3,5,4,0,-4,46,3,5,4,0,-4,48,1,3,2,0,-3,49,2,4,3,0,-3,50,2,3,3,0,-3,51,3,3,4,0,-3,53,2,3,3,0,-3,54,3,5,4,0,-4,56,3,5,4,0,-4,58,3,5,4,0,-4,60,3,5,4,0,-4,62,3,5,4,0,-4,64,3,5,4,0,-4,66,3,5,4,0,-4,68,3,5,4,0,-4,70,3,5,4,0,-4,72,3,5,4,0,-4,74,1,5,2,0,-4,75,3,5,4,0,-4,77,3,5,4,0,-4,79,3,5,4,0,-4,81,5,5,6,0,-4,85,4,5,5,0,-4,88,3,5,4,0,-4,90,3,5,4,0,-4,92,3,6,4,0,-4,95,3,5,4,0,-4,97,3,5,4,0,-4,99,3,5,4,0,-4,101,3,5,4,0,-4,103,3,5,4,0,-4,105,5,5,6,0,-4,109,3,5,4,0,-4,111,3,5,4,0,-4,113,3,5,4,0,-4,115,2,5,3,0,-4,117,3,5,4,0,-4,119,2,5,3,0,-4,121,3,2,4,0,-4,122,4,1,4,0,1,123,2,2,3,0,-4,124,3,4,4,0,-3,126,3,5,4,0,-4,128,3,3,4,0,-2,130,3,5,4,0,-4,132,3,4,4,0,-3,134,2,5,3,0,-4,136,3,5,4,0,-3,138,3,5,4,0,-4,140,1,5,2,0,-4,141,2,6,3,0,-4,143,3,5,4,0,-4,145,2,5,3,0,-4,147,5,3,6,0,-2,149,3,3,4,0,-2,151,3,3,4,0,-2,153,3,4,4,0,-2,155,3,4,4,0,-2,157,2,3,3,0,-2,158,3,4,4,0,-3,160,2,5,3,0,-4,162,3,3,4,0,-2,164,3,3,4,0,-2,166,5,3,6,0,-2,168,3,3,4,0,-2,170,3,4,4,0,-2,172,3,4,4,0,-3,174,3,5,4,0,-4,176,1,6,2,0,-4,177,3,5,4,0,-4,179,4,2,5,0,-3];
const PICO = Uint8Array.from(PICO_BMP.match(/../g), (h) => parseInt(h, 16));

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const N_STARS = 28;
const ART_VOICE_X = [30, 52, 82, 108];
const PARAM_HOLD_MS = 1500;     // the readout stays this long after the last change, like the firmware
const TOAST_MS = 1500;

export class Oled {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.img = this.ctx.createImageData(W, H);
    this.fb = new Uint8Array(W * H);
    // the firmware's fixed pseudo-random starfield (same seed, same LCG)
    this.sx = []; this.sy = []; this.layer = [];
    let r = 0x4d45;
    const lcg = () => { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return (r >>> 16) & 0xffff; };
    for (let k = 0; k < N_STARS; k++) {
      this.sx[k] = lcg() % W;
      this.sy[k] = lcg() % H;
      this.layer[k] = 1 + (k % 3);
    }
    this.spin = [0, 0, 0, 0];
    this.lfoPhase = [0, 0, 0, 0];
    this.envShown = [0, 0, 0, 0];
    this.readout = null;    // { id, voice, until }
    this.toast = null;      // { l1, l2, until }
  }

  // ---- drawing primitives (Adafruit GFX rules) ----
  clear() { this.fb.fill(0); }
  px(x, y, c = 1) { x |= 0; y |= 0; if (x >= 0 && x < W && y >= 0 && y < H) this.fb[y * W + x] = c; }
  rect(x, y, w, h, c = 1) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c); }
  hline(x, y, w, c = 1) { this.rect(x, y, w, 1, c); }
  line(x0, y0, x1, y1, c = 1) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // Draws (or measures) text; returns { x1, y1, w, h, end } like getTextBounds.
  text(str, x, y, size, draw = true, c = 1) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const ch of String(str)) {
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) continue;
      const g = (code - 0x20) * 6;
      let bo = PICO_GLY[g];
      const w = PICO_GLY[g + 1], h = PICO_GLY[g + 2], adv = PICO_GLY[g + 3], xo = PICO_GLY[g + 4], yo = PICO_GLY[g + 5];
      if (w && h) {
        minx = Math.min(minx, x + xo * size); maxx = Math.max(maxx, x + (xo + w) * size - 1);
        miny = Math.min(miny, y + yo * size); maxy = Math.max(maxy, y + (yo + h) * size - 1);
      }
      if (draw) {
        let bits = 0, bit = 0;
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            if (!(bit++ & 7)) bits = PICO[bo++];
            if (bits & 0x80) this.rect(x + (xo + xx) * size, y + (yo + yy) * size, size, size, c);
            bits = (bits << 1) & 0xff;
          }
        }
      }
      x += adv * size;
    }
    if (minx === Infinity) return { x1: x, y1: y, w: 0, h: 0, end: x };
    return { x1: minx, y1: miny, w: maxx - minx + 1, h: maxy - miny + 1, end: x };
  }
  rightAligned(str, y, size) {
    const b = this.text(str, 0, y, size, false);
    this.text(str, W - b.w - b.x1 - 1, y, size);     // 1 px right margin
  }
  // size 3, dropping to 2 if it would run off the right edge (printFit())
  textFit(str, x, y) {
    const b = this.text(str, x, y, 3, false);
    this.text(str, x, y, b.x1 + b.w > W - 1 ? 2 : 3);
  }

  flush() {
    const d = this.img.data;
    for (let i = 0; i < W * H; i++) {
      const v = this.fb[i] ? 255 : 0;
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    this.ctx.putImageData(this.img, 0, 0);
  }

  // ---- what the page tells it ----
  showParam(id, voice) { this.readout = { id, voice, until: performance.now() + PARAM_HOLD_MS }; }
  showToast(l1, l2 = '') { this.toast = { l1, l2, until: performance.now() + TOAST_MS }; }

  // One frame. `state`: { params[4][16], muteMask, env[4] (0..1, from 4-TME or 0),
  // marked: bit per voice (the planets with a marker), who: "V2" / "S 13", showValues }
  frame(dt, state) {
    const now = performance.now();
    this.clear();
    if (this.toast && now < this.toast.until) {
      this.text(this.toast.l1, 0, 12, 3);
      this.textFit(this.toast.l2, 0, 29);
      this.flush();
      return;
    }
    this.toast = null;
    // the readout needs every frame the art does, for the LFO and star motion to stay smooth
    this.advance(dt, state);
    if (state.showValues !== false && this.readout && now < this.readout.until) {
      const { id, voice } = this.readout;
      this.text(PARAMS[id].label, 0, 10, 2);
      this.rightAligned(state.who, 10, 2);
      this.rightAligned(formatParam(id, state.params[voice][id]), 26, 3);
    } else {
      this.drawArt(state);
      const b = this.text(state.who, 1, 10, 2, false);
      this.rect(0, 0, b.x1 + b.w + 2, b.y1 + b.h + 2, 0);   // keep the label readable
      this.text(state.who, 1, 10, 2);
    }
    this.flush();
  }

  advance(dt, state) {
    let avgRate = 0;
    for (let v = 0; v < NUM_VOICES; v++) {
      const rate = paramValue(P.lfoRate, state.params[v][P.lfoRate]);
      avgRate += rate / NUM_VOICES;
      this.spin[v] = (this.spin[v] + dt * rate * 0.6) % (Math.PI * 2);
      this.lfoPhase[v] = (this.lfoPhase[v] + dt * rate) % 1;
      // envelopes arrive a few times a second: rise fast, fall at the rate they were falling
      const target = state.env ? state.env[v] || 0 : 0;
      const k = Math.min(1, dt / (target > this.envShown[v] ? 0.02 : 0.08));
      this.envShown[v] += (target - this.envShown[v]) * k;
    }
    const drift = 2 + 6 * Math.log2(1 + avgRate);
    for (let k = 0; k < N_STARS; k++) {
      this.sx[k] -= drift * this.layer[k] * 0.5 * dt;
      if (this.sx[k] < 0) this.sx[k] += W;
    }
  }

  drawArt(state) {
    for (let k = 0; k < N_STARS; k++) this.px(this.sx[k], this.sy[k]);
    for (let v = 0; v < NUM_VOICES; v++) {
      const p = state.params[v];
      const muted = !!((state.muteMask >> v) & 1);
      const env = muted ? 0 : Math.max(0, Math.min(1, this.envShown[v]));
      const level = p[P.level] / PARAMS[P.level].max;
      const pan = (p[P.pan] / PARAMS[P.pan].max) * 2 - 1;
      const cx = ART_VOICE_X[v] + pan * 6;
      const cy = 19 - Math.max(-1, Math.min(1, paramValue(P.tune, p[P.tune]) / 12)) * 3;
      const r = 2 + 3 * level + 5.5 * env;

      const w = Math.max(0, Math.min(3, paramValue(P.wave, p[P.wave])));
      let sides, xs = 1;
      if (w <= 1) sides = 3 + Math.floor(w * 9 + 0.5);
      else if (w <= 2) sides = 12 - Math.floor((w - 1) * 8 + 0.5);
      else { sides = 4; xs = 1 - (w - 2) * 0.75; }

      const lfoVal = triLfo(this.lfoPhase[v]);
      const wob = 1 + 0.3 * (p[P.pitchLfo] / PARAMS[P.pitchLfo].max) * lfoVal;
      const rr = r * wob;
      const sector = (Math.PI * 2) / sides;
      const apo = Math.cos(Math.PI / sides);
      const dens = Math.max(0, Math.min(1, paramValue(P.cutoff, p[P.cutoff]) / CUTOFF_MAX_OCT));
      const thresh = Math.floor(dens * dens * 16 + 0.5);

      const x0 = Math.trunc(cx - rr - 1), x1 = Math.trunc(cx + rr + 1);
      const y0 = Math.trunc(cy - rr - 1), y1 = Math.trunc(cy + rr + 1);
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= H) continue;
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || x >= W) continue;
          const dx = (x - cx) / xs, dy = y - cy;
          const d = Math.hypot(dx, dy);
          if (d > rr + 1) continue;
          let ph = (Math.atan2(dy, dx) - this.spin[v]) % sector;
          if (ph < 0) ph += sector;
          const edge = (rr * apo) / Math.cos(ph - sector * 0.5);
          if (d > edge) continue;
          const outline = d > edge - 1;
          this.px(x, y, outline || (!muted && BAYER4[(y & 3) * 4 + (x & 3)] < thresh) ? 1 : 0);
        }
      }

      const res = paramValue(P.res, p[P.res]) / 0.9;
      if (res > 0.15) {
        const n = 3 + Math.trunc(res * 6);
        const len = 1.5 + 2.5 * res + 4 * env * Math.max(0, Math.min(1, paramValue(P.fltEnv, p[P.fltEnv]) / 5));
        for (let k = 0; k < n; k++) {
          const a = -this.spin[v] * 0.5 + (k * Math.PI * 2) / n;
          const ca = Math.cos(a), sa = Math.sin(a);
          this.line(cx + ca * (rr + 1.5) * xs, cy + sa * (rr + 1.5), cx + ca * (rr + 1.5 + len) * xs, cy + sa * (rr + 1.5 + len));
        }
      }
      if ((state.marked >> v) & 1) this.hline(Math.trunc(cx) - 3, H - 1, 7);
    }
  }
}
