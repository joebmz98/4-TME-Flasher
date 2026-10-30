// 4-TME editor protocol, version 1.
//
// SysEx frames: F0 7D 34 54 <cmd> <data...> F7
//   7D     = non-commercial manufacturer ID
//   34 54  = "4T", so the MC8P ("M8"), DCLK ("DC") and WEASEL ("WS") pages never answer
// Every data byte is 7-bit. Replies use cmd | 0x40. Parameter values are
// 14-bit, sent as <lo 7 bits> <hi 7 bits>.
//
// The frames travel over the Daisy Seed's USB port running as a CDC serial
// port (Arduino IDE: Tools > USB support > CDC). Anything outside an F0..F7
// frame (debug prints) is ignored on both sides.
//
// | Cmd | Request                                   | Reply                                     |
// |-----|-------------------------------------------|-------------------------------------------|
// | 01  | INFO                                      | 41 proto, voices, params, presets, name length, flash ok, version ASCII |
// | 02  | GET_SETTINGS                              | 42 MIDI channel, LEDS, display timeout, values (4 bytes) |
// | 03  | SET_SETTINGS <4 bytes>                    | 42 after clamping; 4-TME saves them 0.5 s later |
// | 04  | GET_SOUND                                 | 44 sound (see encodeSound)                |
// | 05  | SET_PARAM <voice mask> <param> <lo> <hi>  | 45 param, then the value of all 4 voices (lo hi each) |
// | 06  | SET_SOUND <sound>                         | 44                                        |
// | 07  | STATUS                                    | 47 see decodeStatus()                     |
// | 08  | SET_VOICES <selected voice> <mute mask>   | 48 selected voice, mute mask              |
// | 09  | GET_PRESETS                               | 49 count, then per slot: used, 5 name chars |
// | 0A  | GET_PRESET <slot>                         | 4A slot, used, 5 name chars, 4 x 16 values |
// | 0B  | LOAD_PRESET <slot>                        | 44 the loaded sound                       |
// | 0C  | SAVE_PRESET <slot> <5 name chars>         | 49 (stores the current sound)             |
// | 0D  | WRITE_PRESET <slot> <name> <4 x 16 values>| 49 (stores a sound from a backup file)    |
// | 0E  | CLEAR_PRESET <slot> 43 4C 52 ("CLR")      | 49                                        |
// | 0F  | INIT_SOUND 49 4E 49 ("INI")               | 44 every voice back to the INIT sound     |
// | 10  | RESET_SETTINGS 44 45 46 ("DEF")           | 42 factory settings                       |
// | 11  | BOOTLOADER 44 46 55 ("DFU")               | 51, then the Seed restarts in DFU mode    |
// |     | anything refused                          | 7F <cmd> <reason>                         |
//
// Settings and presets live in 4-TME's W25Q64 SPI flash, so flashing new
// firmware into the Seed never touches them. The sound being edited is saved
// to flash 2 s after the last change (the "last state"), like turning the
// encoders.

export const PROTOCOL = 1;
export const HDR = [0xf0, 0x7d, 0x34, 0x54];
export const CMD = {
  INFO: 0x01, GET_SETTINGS: 0x02, SET_SETTINGS: 0x03, GET_SOUND: 0x04, SET_PARAM: 0x05,
  SET_SOUND: 0x06, STATUS: 0x07, SET_VOICES: 0x08, GET_PRESETS: 0x09, GET_PRESET: 0x0a,
  LOAD_PRESET: 0x0b, SAVE_PRESET: 0x0c, WRITE_PRESET: 0x0d, CLEAR_PRESET: 0x0e,
  INIT_SOUND: 0x0f, RESET_SETTINGS: 0x10, BOOTLOADER: 0x11,
};
export const RPL = {
  INFO: 0x41, SETTINGS: 0x42, SOUND: 0x44, PARAM: 0x45, STATUS: 0x47, VOICES: 0x48,
  PRESETS: 0x49, PRESET: 0x4a, BOOTLOADER: 0x51, NAK: 0x7f,
};
export const MAGIC = {
  CLEAR: [0x43, 0x4c, 0x52], INIT: [0x49, 0x4e, 0x49], RESET: [0x44, 0x45, 0x46], BOOTLOADER: [0x44, 0x46, 0x55],
};
export const NAK = { UNKNOWN: 1, LENGTH: 2, MAGIC: 3, RANGE: 4, NO_FLASH: 5, BUSY: 6, EMPTY: 7 };
export const NAK_REASON = {
  1: 'unknown command', 2: 'wrong length', 3: 'missing confirmation bytes', 4: 'value out of range',
  5: 'no SPI flash found, so presets and settings cannot be saved', 6: 'the flash is busy saving, try again',
  7: 'that preset slot is empty',
};

export const NUM_VOICES = 4;
export const NUM_PRESETS = 32;
export const NAME_LEN = 5;
export const NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Parameters: the 16 encoders, in firmware order (enum Param in the sketch).
// Values are whole encoder positions 0..max, exactly what the firmware stores.
// `big` = a large knob on the panel, otherwise a small trimmer.
// ---------------------------------------------------------------------------

export const PARAMS = [
  { key: 'tune',      label: 'TUNE',       name: 'Tune',            max: 240, def: 120, group: 'osc',    big: true },
  { key: 'wave',      label: 'WAVE',       name: 'Wave scrub',      max: 150, def: 50,  group: 'osc' },
  { key: 'pitchEnv',  label: 'PITCH ENV',  name: 'Pitch env',       max: 96,  def: 48,  group: 'osc',    bipolar: true },
  { key: 'pitchLfo',  label: 'PITCH LFO',  name: 'Pitch LFO',       max: 100, def: 0,   group: 'osc' },
  { key: 'cutoff',    label: 'CUTOFF',     name: 'Cutoff',          max: 98,  def: 98,  group: 'filter', big: true },
  { key: 'res',       label: 'RESO',       name: 'Resonance',       max: 100, def: 0,   group: 'filter' },
  { key: 'fltEnv',    label: 'CUTOFF ENV', name: 'Cutoff env',      max: 100, def: 50,  group: 'filter', bipolar: true },
  { key: 'fltLfo',    label: 'CUTOFF LFO', name: 'Cutoff LFO',      max: 100, def: 0,   group: 'filter' },
  { key: 'fltCv',     label: 'CUTOFF CV',  name: 'Cutoff CV',       max: 0,   def: 0,   group: 'filter', todo: true },
  { key: 'attack',    label: 'ATTACK',     name: 'Attack',          max: 100, def: 0,   group: 'env',    big: true },
  { key: 'decay',     label: 'DECAY',      name: 'Decay',           max: 100, def: 42,  group: 'env',    big: true },
  { key: 'sustain',   label: 'SUSTAIN',    name: 'Sustain',         max: 100, def: 50,  group: 'env',    big: true },
  { key: 'release',   label: 'RELEASE',    name: 'Release',         max: 100, def: 42,  group: 'env',    big: true },
  { key: 'lfoRate',   label: 'LFO RATE',   name: 'LFO rate',        max: 100, def: 59,  group: 'lfo',    big: true },
  { key: 'pan',       label: 'PAN',        name: 'Pan',             max: 100, def: 50,  group: 'vca',    big: true, bipolar: true },
  { key: 'level',     label: 'LEVEL',      name: 'Level',           max: 100, def: 80,  group: 'vca',    big: true },
];
export const P = Object.fromEntries(PARAMS.map((p, i) => [p.key, i]));
export const NUM_PARAMS = PARAMS.length;
export const PARAM_DEFAULTS = Object.freeze(PARAMS.map((p) => p.def));
export const GROUPS = [
  { key: 'osc', title: 'Oscillator' },
  { key: 'filter', title: 'Filter' },
  { key: 'env', title: 'Envelope' },
  { key: 'lfo', title: 'LFO' },
  { key: 'vca', title: 'VCA' },
];

export const clampParam = (id, v) => clamp(Math.round(Number(v) || 0), 0, PARAMS[id].max);

// ---- what a position means (applyParam() in the sketch) ----
const timeFromNorm = (n) => 0.001 * Math.pow(10000, n);       // 1 ms .. 10 s
export const CUTOFF_MIN_HZ = 20;
export const CUTOFF_MAX_OCT = Math.log2(18000 / CUTOFF_MIN_HZ);
const norm = (id, p) => (PARAMS[id].max ? p / PARAMS[id].max : 0);

export function paramValue(id, p) {
  const n = norm(id, p);
  switch (id) {
    case P.tune: return (p - 120) * 0.1;           // semitones
    case P.wave: return p / 50;                    // 0 tri, 1 saw, 2 square, 3 narrowest pulse
    case P.pitchEnv: return (p - 48) * 0.5;        // semitones
    case P.pitchLfo: return n * n * 12;            // semitones
    case P.cutoff: return p * 0.1;                 // octaves above 20 Hz
    case P.res: return n * 0.9;
    case P.fltEnv: return (p - 50) * 0.1;          // octaves
    case P.fltLfo: return n * n * 4;               // octaves
    case P.attack: case P.decay: case P.release: return timeFromNorm(n);   // seconds
    case P.sustain: return n;
    case P.lfoRate: return 0.05 * Math.pow(2, n * 9);   // Hz
    case P.pan: return n;                          // 0 left .. 1 right
    case P.level: return n;
    default: return 0;
  }
}

// The text the OLED shows while a knob turns (formatParam() in the sketch).
const lround = (x) => Math.sign(x) * Math.round(Math.abs(x));
function fmtFixed(v, decimals, plus = false) {
  const scale = 10 ** decimals;
  let x = lround(v * scale);
  const sign = x < 0 ? '-' : plus && x > 0 ? '+' : '';
  x = Math.abs(x);
  if (!decimals) return `${sign}${x}`;
  return `${sign}${Math.floor(x / scale)}.${String(x % scale).padStart(decimals, '0')}`;
}
const fmtTime = (s) => (s < 1 ? `${fmtFixed(s * 1000, 0)} MS` : `${fmtFixed(s, 2)} S`);

export function formatParam(id, p) {
  const v = paramValue(id, p);
  switch (id) {
    case P.tune: return `${fmtFixed(v, 1, true)} ST`;
    case P.wave:
      if (p === 0) return 'TRI';
      if (p < 50) return `TRI>SAW ${p * 2}`;
      if (p === 50) return 'SAW';
      if (p < 100) return `SAW>SQR ${(p - 50) * 2}`;
      if (p === 100) return 'SQUARE';
      return `PW ${fmtFixed(50 - (v - 2) * 45, 0)}%`;
    case P.pitchEnv: return `${fmtFixed(v, 1, true)} ST`;
    case P.pitchLfo: return `${fmtFixed(v, 2)} ST`;
    case P.cutoff: {
      const hz = CUTOFF_MIN_HZ * Math.pow(2, v);
      return hz < 1000 ? `${fmtFixed(hz, 0)} HZ` : `${fmtFixed(hz / 1000, 1)} KHZ`;
    }
    case P.res: return `${p}%`;
    case P.fltEnv: return `${fmtFixed(v, 1, true)} OCT`;
    case P.fltLfo: return `${fmtFixed(v, 2)} OCT`;
    case P.attack: case P.decay: case P.release: return fmtTime(v);
    case P.sustain: return `${p}%`;
    case P.lfoRate: return `${fmtFixed(v, v < 10 ? 2 : 1)} HZ`;
    case P.pan: return p === 50 ? 'CENTRE' : p < 50 ? `L ${(50 - p) * 2}` : `R ${(p - 50) * 2}`;
    case P.level: return `${p}%`;
    default: return '-';
  }
}

// ---------------------------------------------------------------------------
// Settings (the SETTINGS menu). Wire order = this order.
// ---------------------------------------------------------------------------

export const SETTINGS = [
  { key: 'midiChannel', label: 'MIDI', options: ['OMNI', ...Array.from({ length: 16 }, (_, i) => `CH ${i + 1}`)], def: 0 },
  { key: 'ledLevel', label: 'LEDS', options: ['LO', 'MID', 'HI'], def: 1 },
  { key: 'saverIdx', label: 'DISPLAY', options: ['OFF', '1M', '5M', '10M', '30M'], def: 2 },
  { key: 'showValues', label: 'VALUES', options: ['OFF', 'ON'], def: 1 },
];
export const SETTINGS_DEFAULTS = Object.freeze(Object.fromEntries(SETTINGS.map((s) => [s.key, s.def])));
export const SAVER_MIN = [0, 1, 5, 10, 30];

export const encodeSettings = (s) => SETTINGS.map((f) => clamp(Math.round(Number(s[f.key] ?? f.def)), 0, f.options.length - 1));
export const decodeSettings = (b) => Object.fromEntries(SETTINGS.map((f, i) => [f.key, clamp(b[i] ?? f.def, 0, f.options.length - 1)]));

// ---------------------------------------------------------------------------
// A sound: every parameter of every voice, plus which voice is selected and
// which are muted. Presets hold the parameters and a name, not the mutes.
// ---------------------------------------------------------------------------

export const lo7 = (v) => v & 0x7f;
export const hi7 = (v) => (v >> 7) & 0x7f;
const v14 = (lo, hi) => ((hi & 0x7f) << 7) | (lo & 0x7f);

export const defaultParams = () => Array.from({ length: NUM_VOICES }, () => [...PARAM_DEFAULTS]);
export const defaultSound = () => ({ selVoice: 0, muteMask: 0, params: defaultParams() });

export function encodeParams(params) {
  const out = [];
  for (let v = 0; v < NUM_VOICES; v++) {
    for (let id = 0; id < NUM_PARAMS; id++) {
      const x = clampParam(id, params[v] ? params[v][id] : PARAM_DEFAULTS[id]);
      out.push(lo7(x), hi7(x));
    }
  }
  return out;
}
export function decodeParams(b, at = 0) {
  return Array.from({ length: NUM_VOICES }, (_, v) => Array.from({ length: NUM_PARAMS }, (_, id) =>
    clampParam(id, v14(b[at + (v * NUM_PARAMS + id) * 2], b[at + (v * NUM_PARAMS + id) * 2 + 1]))));
}
export const PARAM_BYTES = NUM_VOICES * NUM_PARAMS * 2;   // 128
export const SOUND_BYTES = 2 + PARAM_BYTES;               // 130

export function encodeSound(s) {
  return [clamp(s.selVoice | 0, 0, NUM_VOICES - 1), (s.muteMask | 0) & 0x0f, ...encodeParams(s.params)];
}
export function decodeSound(b) {
  return { selVoice: clamp(b[0] | 0, 0, NUM_VOICES - 1), muteMask: (b[1] | 0) & 0x0f, params: decodeParams(b, 2) };
}

// Names: 5 characters from NAME_CHARS, space padded (the panel's name entry).
export function cleanName(text) {
  const up = String(text ?? '').toUpperCase();
  let out = '';
  for (let i = 0; i < NAME_LEN; i++) {
    const c = up[i] ?? ' ';
    out += NAME_CHARS.includes(c) ? c : ' ';
  }
  return out;
}
export const nameBytes = (n) => [...cleanName(n)].map((c) => c.charCodeAt(0));
const nameFrom = (b, at) => cleanName(String.fromCharCode(...b.slice(at, at + NAME_LEN)));
export const trimName = (n) => cleanName(n).replace(/ +$/, '');

// "1. - - -" / "1. NAME", as on the OLED
export const slotText = (slot, p) => (p && p.used ? `${slot + 1}. ${trimName(p.name)}` : `${slot + 1}. - - -`);

export function encodePresetList(list) {
  const out = [NUM_PRESETS];
  for (let i = 0; i < NUM_PRESETS; i++) {
    const p = list[i] || { used: false, name: '' };
    out.push(p.used ? 1 : 0, ...(p.used ? nameBytes(p.name) : [0x20, 0x20, 0x20, 0x20, 0x20]));
  }
  return out;
}
export function decodePresetList(b) {
  const n = Math.min(b[0] | 0, NUM_PRESETS);
  return Array.from({ length: NUM_PRESETS }, (_, i) => {
    if (i >= n) return { used: false, name: '' };
    const at = 1 + i * (1 + NAME_LEN);
    return b[at] ? { used: true, name: nameFrom(b, at + 1) } : { used: false, name: '' };
  });
}
export function decodePreset(b) {
  return { slot: b[0], used: !!b[1], name: b[1] ? nameFrom(b, 2) : '', params: b[1] ? decodeParams(b, 2 + NAME_LEN) : null };
}

export function checksum(bytes) {
  return bytes.reduce((a, b) => (a * 3 + b + 1) & 0x7f, 0);
}
export const soundSum = (s) => checksum(encodeSound(s));
export const paramsSum = (params) => checksum(encodeParams(params));

export const msg = (cmd, ...data) => [...HDR, cmd, ...data, 0xf7];
export const isOurs = (d) => d.length >= 6 && HDR.every((b, i) => d[i] === b) && d[d.length - 1] === 0xf7;
export const payload = (d) => Array.from(d.slice(5, -1));

// ---------------------------------------------------------------------------
// STATUS reply payload (17 bytes).
//   0 flags  bit0 flash found, bit1 flash busy, bit2 settings waiting to be saved,
//            bit3 sound waiting to be saved (last state), bit4 a note has arrived
//   1 sound checksum   2 settings checksum   3 preset list checksum
//   4 MIDI activity counter (bumps on every message)
//   5 last note   6 last channel 0-15   7 last velocity
//   8 gates, bit per voice   9-12 amp envelope per voice 0-127
//   13-16 LFO per voice, 0-127 (64 = centre)
// ---------------------------------------------------------------------------

export function decodeStatus(p) {
  return {
    flashOk: !!(p[0] & 1), flashBusy: !!(p[0] & 2), settingsPending: !!(p[0] & 4), soundPending: !!(p[0] & 8),
    soundSum: p[1], settingsSum: p[2], presetSum: p[3], activity: p[4],
    lastNote: p[5], lastChannel: p[6], lastVelocity: p[7], anyNote: !!(p[0] & 16),
    gates: p[8] & 0x0f,
    env: [p[9], p[10], p[11], p[12]].map((x) => (x || 0) / 127),
    lfo: [p[13], p[14], p[15], p[16]].map((x) => (x === undefined ? 0 : (x - 63.5) / 63.5)),
  };
}
export function encodeStatus(s) {
  return [
    (s.flashOk ? 1 : 0) | (s.flashBusy ? 2 : 0) | (s.settingsPending ? 4 : 0) | (s.soundPending ? 8 : 0) | (s.anyNote ? 16 : 0),
    s.soundSum & 0x7f, s.settingsSum & 0x7f, s.presetSum & 0x7f, s.activity & 0x7f,
    s.lastNote & 0x7f, s.lastChannel & 0x0f, s.lastVelocity & 0x7f, s.gates & 0x0f,
    ...[0, 1, 2, 3].map((v) => clamp(Math.round((s.env[v] || 0) * 127), 0, 127)),
    ...[0, 1, 2, 3].map((v) => clamp(Math.round(((s.lfo[v] || 0) + 1) * 63.5), 0, 127)),
  ];
}

export function decodeInfo(p) {
  return {
    protocol: p[0], voices: p[1], params: p[2], presets: p[3], nameLen: p[4], flashOk: !!p[5],
    version: String.fromCharCode(...p.slice(6)),
  };
}

// Pulls F0..F7 frames out of a byte stream (USB serial delivers arbitrary
// pieces and may carry debug text between frames).
export class FrameParser {
  constructor(onFrame, maxLength = 256) {
    this.onFrame = onFrame;
    this.max = maxLength;
    this.buf = null;
  }

  push(bytes) {
    for (const b of bytes) {
      if (b === 0xf0) { this.buf = [b]; continue; }
      if (!this.buf) continue;
      if (b === 0xf7) {
        this.buf.push(b);
        const frame = this.buf;
        this.buf = null;
        this.onFrame(frame);
        continue;
      }
      if (b & 0x80 || this.buf.length >= this.max) { this.buf = null; continue; }
      this.buf.push(b);
    }
  }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Middle C (60) = C4, as on most keyboards and DAWs.
export const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

// ---------------------------------------------------------------------------
// Envelope and LFO shapes, for the simulated 4-TME and the page's preview.
// ---------------------------------------------------------------------------

// Level of an ADSR at `t` seconds after the gate opened; the gate closed after
// `gate` seconds (Infinity = still held). Close enough to DaisySP's Adsr to look right.
export function adsrAt(t, gate, params) {
  const a = paramValue(P.attack, params[P.attack]);
  const d = paramValue(P.decay, params[P.decay]);
  const s = paramValue(P.sustain, params[P.sustain]);
  const r = paramValue(P.release, params[P.release]);
  const held = (x) => (x < a ? x / a : s + (1 - s) * Math.exp((-(x - a) * 4.6) / d));
  if (t < gate) return held(t);
  const from = held(gate);
  return from * Math.exp((-(t - gate) * 4.6) / r);
}
export const triLfo = (phase) => { const x = phase - Math.floor(phase); return x < 0.5 ? 4 * x - 1 : 3 - 4 * x; };

// ---------------------------------------------------------------------------
// A 4-TME that lives in the page, for "try demo" and the tests. It answers
// like the firmware and plays a little arpeggio round-robin over the voices.
// ---------------------------------------------------------------------------

const DEMO_PRESETS = {
  0: { name: 'PLUCK', params: (v) => { const p = [...PARAM_DEFAULTS]; p[P.cutoff] = 52; p[P.res] = 35; p[P.fltEnv] = 82; p[P.decay] = 38; p[P.sustain] = 0; p[P.release] = 40; p[P.pan] = [20, 80, 35, 65][v]; return p; } },
  1: { name: 'SPACE', params: (v) => { const p = [...PARAM_DEFAULTS]; p[P.wave] = [0, 40, 120, 140][v]; p[P.pitchLfo] = 30; p[P.lfoRate] = 30 + v * 9; p[P.attack] = 70; p[P.release] = 80; p[P.cutoff] = 70; p[P.fltLfo] = 40; return p; } },
  2: { name: 'BRASS', params: () => { const p = [...PARAM_DEFAULTS]; p[P.cutoff] = 45; p[P.fltEnv] = 75; p[P.attack] = 45; p[P.decay] = 55; p[P.sustain] = 70; p[P.res] = 15; return p; } },
  4: { name: 'ZAP', params: (v) => { const p = [...PARAM_DEFAULTS]; p[P.pitchEnv] = 96; p[P.decay] = 30; p[P.sustain] = 0; p[P.wave] = 100; p[P.tune] = 120 + v * 24 - 36; return p; } },
  7: { name: 'PAD-4', params: (v) => { const p = [...PARAM_DEFAULTS]; p[P.tune] = 120 + [-1, 1, -2, 2][v]; p[P.attack] = 78; p[P.release] = 85; p[P.sustain] = 90; p[P.cutoff] = 62; p[P.lfoRate] = 25; p[P.fltLfo] = 25; p[P.pan] = [0, 100, 30, 70][v]; return p; } },
};

export class DemoTme {
  constructor({ version = '16.0-demo', flash = true } = {}) {
    this.version = version;
    this.flashOk = flash;
    this.settings = { ...SETTINGS_DEFAULTS };
    this.sound = defaultSound();
    this.presets = Array.from({ length: NUM_PRESETS }, () => null);   // { name, params }
    for (const [slot, p] of Object.entries(DEMO_PRESETS)) {
      this.presets[slot] = { name: cleanName(p.name), params: Array.from({ length: NUM_VOICES }, (_, v) => p.params(v)) };
    }
    // start on the SPACE sound so the demo screen has something to look at
    this.sound.params = this.presets[1].params.map((p) => [...p]);
    this.busyUntil = 0;
    this.settingsDueAt = 0;
    this.soundDueAt = 0;
    this.onReply = () => {};
    this.t0 = Date.now();
    this.activity = 0;
    this.play = true;     // make up notes
    this.now = () => Date.now();
  }

  reply(cmd, data = []) { this.onReply(msg(cmd, ...data)); }
  nak(cmd, reason) { this.reply(RPL.NAK, [cmd & 0x7f, reason]); }

  // like the panel: an encoder turned on 4-TME itself
  turn(voice, id, delta) {
    this.sound.params[voice][id] = clampParam(id, this.sound.params[voice][id] + delta);
    this.soundDueAt = this.now() + 2000;
  }

  presetList() {
    return this.presets.map((p) => (p ? { used: true, name: p.name } : { used: false, name: '' }));
  }
  busy() { return this.now() < this.busyUntil; }
  startWrite() { this.busyUntil = this.now() + 60; }

  voiceState(t) {
    // 8th notes at 132 BPM, each held 60 % of a step, round-robin over the voices
    const step = 60 / 132 / 2;
    const notes = [48, 55, 60, 63, 67, 70, 72, 63, 58, 62, 65, 69];
    const env = [0, 0, 0, 0];
    const lfo = [0, 0, 0, 0];
    let gates = 0;
    let last = null;
    const n = Math.floor(t / step);
    if (this.play) {
      for (let k = Math.max(0, n - 12); k <= n; k++) {
        const v = k % NUM_VOICES;
        const on = t - k * step;
        const e = adsrAt(on, step * 0.6, this.sound.params[v]);
        env[v] = Math.max(0, Math.min(1, (this.sound.muteMask >> v) & 1 ? 0 : e));
        if (on < step * 0.6) gates |= 1 << v;
      }
      last = { note: notes[n % notes.length], velocity: 70 + ((n * 37) % 57), channel: Math.max(0, this.settings.midiChannel - 1) };
    }
    for (let v = 0; v < NUM_VOICES; v++) lfo[v] = triLfo(t * paramValue(P.lfoRate, this.sound.params[v][P.lfoRate]));
    return { env, lfo, gates, last };
  }

  status() {
    const now = this.now();
    const t = (now - this.t0) / 1000;
    const vs = this.voiceState(t);
    if (this.play) this.activity = Math.floor(t / (60 / 132 / 2)) & 0x7f;   // bumps with every note
    if (this.settingsDueAt && now >= this.settingsDueAt) this.settingsDueAt = 0;
    if (this.soundDueAt && now >= this.soundDueAt) this.soundDueAt = 0;
    return {
      flashOk: this.flashOk, flashBusy: this.busy(),
      settingsPending: !!this.settingsDueAt, soundPending: !!this.soundDueAt,
      soundSum: soundSum(this.sound), settingsSum: checksum(encodeSettings(this.settings)),
      presetSum: checksum(encodePresetList(this.presetList())), activity: this.activity,
      anyNote: !!vs.last, lastNote: vs.last ? vs.last.note : 0, lastChannel: vs.last ? vs.last.channel : 0, lastVelocity: vs.last ? vs.last.velocity : 0,
      gates: vs.gates, env: vs.env, lfo: vs.lfo,
    };
  }

  edited() { this.soundDueAt = this.now() + 2000; }

  receive(frame) {
    if (!isOurs(frame)) return;
    const cmd = frame[4];
    const p = payload(frame);
    const magic = (m) => m.every((b, i) => p[i] === b);
    const flashCheck = () => {
      if (!this.flashOk) { this.nak(cmd, NAK.NO_FLASH); return false; }
      if (this.busy()) { this.nak(cmd, NAK.BUSY); return false; }
      return true;
    };
    switch (cmd) {
      case CMD.INFO:
        return this.reply(RPL.INFO, [PROTOCOL, NUM_VOICES, NUM_PARAMS, NUM_PRESETS, NAME_LEN, this.flashOk ? 1 : 0, ...[...this.version].map((c) => c.charCodeAt(0) & 0x7f)]);
      case CMD.GET_SETTINGS:
        return this.reply(RPL.SETTINGS, encodeSettings(this.settings));
      case CMD.SET_SETTINGS:
        if (p.length !== SETTINGS.length) return this.nak(cmd, NAK.LENGTH);
        this.settings = decodeSettings(p);
        if (this.flashOk) this.settingsDueAt = this.now() + 500;
        return this.reply(RPL.SETTINGS, encodeSettings(this.settings));
      case CMD.RESET_SETTINGS:
        if (!magic(MAGIC.RESET)) return this.nak(cmd, NAK.MAGIC);
        this.settings = { ...SETTINGS_DEFAULTS };
        if (this.flashOk) this.settingsDueAt = this.now() + 500;
        return this.reply(RPL.SETTINGS, encodeSettings(this.settings));
      case CMD.GET_SOUND:
        return this.reply(RPL.SOUND, encodeSound(this.sound));
      case CMD.SET_PARAM: {
        if (p.length !== 4) return this.nak(cmd, NAK.LENGTH);
        const [mask, id] = p;
        if (id >= NUM_PARAMS || !(mask & 0x0f)) return this.nak(cmd, NAK.RANGE);
        const val = clampParam(id, v14(p[2], p[3]));
        for (let v = 0; v < NUM_VOICES; v++) if ((mask >> v) & 1) this.sound.params[v][id] = val;
        this.edited();
        return this.reply(RPL.PARAM, [id, ...this.sound.params.flatMap((pv) => [lo7(pv[id]), hi7(pv[id])])]);
      }
      case CMD.SET_SOUND:
        if (p.length !== SOUND_BYTES) return this.nak(cmd, NAK.LENGTH);
        this.sound = decodeSound(p);
        this.edited();
        return this.reply(RPL.SOUND, encodeSound(this.sound));
      case CMD.SET_VOICES:
        if (p.length !== 2) return this.nak(cmd, NAK.LENGTH);
        this.sound.selVoice = clamp(p[0], 0, NUM_VOICES - 1);
        this.sound.muteMask = p[1] & 0x0f;
        this.edited();
        return this.reply(RPL.VOICES, [this.sound.selVoice, this.sound.muteMask]);
      case CMD.STATUS:
        return this.reply(RPL.STATUS, encodeStatus(this.status()));
      case CMD.GET_PRESETS:
        return this.reply(RPL.PRESETS, encodePresetList(this.presetList()));
      case CMD.GET_PRESET: {
        if (p.length !== 1) return this.nak(cmd, NAK.LENGTH);
        if (p[0] >= NUM_PRESETS) return this.nak(cmd, NAK.RANGE);
        if (!this.flashOk) return this.nak(cmd, NAK.NO_FLASH);
        if (this.busy()) return this.nak(cmd, NAK.BUSY);
        const pr = this.presets[p[0]];
        return this.reply(RPL.PRESET, pr ? [p[0], 1, ...nameBytes(pr.name), ...encodeParams(pr.params)] : [p[0], 0]);
      }
      case CMD.LOAD_PRESET: {
        if (p.length !== 1) return this.nak(cmd, NAK.LENGTH);
        if (p[0] >= NUM_PRESETS) return this.nak(cmd, NAK.RANGE);
        if (!flashCheck()) return;
        const pr = this.presets[p[0]];
        if (!pr) return this.nak(cmd, NAK.EMPTY);
        this.sound.params = pr.params.map((x) => [...x]);
        this.edited();
        return this.reply(RPL.SOUND, encodeSound(this.sound));
      }
      case CMD.SAVE_PRESET:
        if (p.length !== 1 + NAME_LEN) return this.nak(cmd, NAK.LENGTH);
        if (p[0] >= NUM_PRESETS) return this.nak(cmd, NAK.RANGE);
        if (!flashCheck()) return;
        this.presets[p[0]] = { name: nameFrom(p, 1), params: this.sound.params.map((x) => [...x]) };
        this.startWrite();
        return this.reply(RPL.PRESETS, encodePresetList(this.presetList()));
      case CMD.WRITE_PRESET:
        if (p.length !== 1 + NAME_LEN + PARAM_BYTES) return this.nak(cmd, NAK.LENGTH);
        if (p[0] >= NUM_PRESETS) return this.nak(cmd, NAK.RANGE);
        if (!flashCheck()) return;
        this.presets[p[0]] = { name: nameFrom(p, 1), params: decodeParams(p, 1 + NAME_LEN) };
        this.startWrite();
        return this.reply(RPL.PRESETS, encodePresetList(this.presetList()));
      case CMD.CLEAR_PRESET:
        if (p.length !== 4) return this.nak(cmd, NAK.LENGTH);
        if (p[0] >= NUM_PRESETS) return this.nak(cmd, NAK.RANGE);
        if (!MAGIC.CLEAR.every((b, i) => p[i + 1] === b)) return this.nak(cmd, NAK.MAGIC);
        if (!flashCheck()) return;
        this.presets[p[0]] = null;
        this.startWrite();
        return this.reply(RPL.PRESETS, encodePresetList(this.presetList()));
      case CMD.INIT_SOUND:
        if (!magic(MAGIC.INIT)) return this.nak(cmd, NAK.MAGIC);
        this.sound.params = defaultParams();
        this.edited();
        return this.reply(RPL.SOUND, encodeSound(this.sound));
      case CMD.BOOTLOADER:
        if (!magic(MAGIC.BOOTLOADER)) return this.nak(cmd, NAK.MAGIC);
        return this.reply(RPL.BOOTLOADER);
      default:
        return this.nak(cmd, NAK.UNKNOWN);
    }
  }
}
