// Drives the host build of TmeEditor.h (harness.cpp) with frames made by
// protocol.js, and checks the replies decode to what the web pages expect.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import * as P from '../../protocol.js';

const proc = spawn(new URL('./harness', import.meta.url).pathname);
let wait = null;
let buf = '';
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (wait) { const w = wait; wait = null; w(l); }
  }
});
const send = (text) => new Promise((r) => { wait = r; proc.stdin.write(text + '\n'); });
const req = async (frame, noise = '') => {
  const l = await send(noise + frame.map((b) => b.toString(16)).join(' '));
  const hex = l.split('|')[0].trim();
  const bytes = hex ? hex.split(/\s+/).map((h) => parseInt(h, 16)) : [];
  const frames = [];
  new P.FrameParser((f) => frames.push(f)).push(bytes);
  for (const f of frames) assert.ok(f.slice(1, -1).every((b) => b < 0x80), 'replies stay 7-bit');
  assert.equal(frames.reduce((n, f) => n + f.length, 0), bytes.length, 'nothing outside frames');
  return { frames, cmd: frames[0] && frames[0][4], p: frames[0] ? P.payload(frames[0]) : [] };
};
const nakOf = (r) => (r.cmd === P.RPL.NAK ? r.p[1] : 0);
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok    ${name}`); };

console.log('Firmware link (TmeEditor.h, host build)');

let r = await req(P.msg(P.CMD.INFO), '68 65 6c 6c 6f 0d 0a ');
const info = P.decodeInfo(r.p);
assert.deepEqual([info.protocol, info.voices, info.params, info.presets, info.nameLen, info.flashOk, info.version],
  [P.PROTOCOL, 4, 16, 32, 5, true, '16.0']);
ok('INFO through serial noise: protocol 1, 4 voices x 16 params, 32 presets, version 16.0');

r = await req(P.msg(P.CMD.GET_SOUND));
assert.equal(r.cmd, P.RPL.SOUND);
assert.deepEqual(P.decodeSound(r.p), P.defaultSound(), 'the INIT sound decodes to PARAM_DEFAULTS');
ok('GET_SOUND: 130 bytes, the sketch\'s PARAM_DEFAULT equals protocol.js PARAM_DEFAULTS');

r = await req(P.msg(P.CMD.SET_PARAM, 0b0101, P.P.cutoff, P.lo7(40), P.hi7(40)));
assert.equal(r.cmd, P.RPL.PARAM);
assert.equal(r.p[0], P.P.cutoff);
const vals = [0, 1, 2, 3].map((v) => r.p[1 + v * 2] | (r.p[2 + v * 2] << 7));
assert.deepEqual(vals, [40, 98, 40, 98]);
assert.match(await send('STATE'), /readout=0,4 /);
ok('SET_PARAM to voices 1 and 3 only; the OLED readout shows voice 1 cutoff');

r = await req(P.msg(P.CMD.SET_PARAM, 1, P.P.tune, P.lo7(239), P.hi7(239)));
assert.equal(r.p[1] | (r.p[2] << 7), 239);
r = await req(P.msg(P.CMD.SET_PARAM, 1, P.P.tune, 0x7f, 0x7f));
assert.equal(r.p[1] | (r.p[2] << 7), 240, '14-bit values above the max clamp');
r = await req(P.msg(P.CMD.SET_PARAM, 0, P.P.tune, 0, 0));
assert.equal(nakOf(r), P.NAK.RANGE);
r = await req(P.msg(P.CMD.SET_PARAM, 1, 16, 0, 0));
assert.equal(nakOf(r), P.NAK.RANGE);
ok('14-bit values > 127 survive; clamping; no voice or a bad param is refused');

const sound = { selVoice: 2, muteMask: 0b1000, params: P.defaultParams() };
sound.params[3][P.P.wave] = 150; sound.params[1][P.P.lfoRate] = 3; sound.params[0][P.P.tune] = 200;
r = await req(P.msg(P.CMD.SET_SOUND, ...P.encodeSound(sound)));
assert.deepEqual(P.decodeSound(r.p), sound);
r = await req(P.msg(P.CMD.STATUS));
let st = P.decodeStatus(r.p);
assert.equal(st.soundSum, P.soundSum(sound), 'firmware and page agree on the sound checksum');
assert.equal(st.soundPending, true);
assert.deepEqual([st.gates, st.env.map((e) => Math.round(e * 127)), st.anyNote], [5, [0, 40, 80, 120], false]);
ok('SET_SOUND round-trips (selected voice, mutes, every value); STATUS checksum matches the page');

await send('NOTE 3 61 99');
r = await req(P.msg(P.CMD.STATUS));
st = P.decodeStatus(r.p);
assert.deepEqual([st.anyNote, st.lastNote, st.lastChannel, st.lastVelocity], [true, 61, 2, 99]);
ok('MIDI monitor: last note, channel and velocity');

r = await req(P.msg(P.CMD.SET_VOICES, 3, 0b0011));
assert.deepEqual([r.cmd, ...r.p], [P.RPL.VOICES, 3, 3]);
ok('SET_VOICES: selected voice and mutes');

r = await req(P.msg(P.CMD.SET_SETTINGS, 5, 2, 0, 0));
assert.deepEqual(P.decodeSettings(r.p), { midiChannel: 5, ledLevel: 2, saverIdx: 0, showValues: 0 });
r = await req(P.msg(P.CMD.SET_SETTINGS, 99, 9, 9, 9));
assert.deepEqual(P.encodeSettings(P.decodeSettings(r.p)), [16, 2, 4, 1], 'settings clamp to their ranges');
r = await req(P.msg(P.CMD.STATUS));
st = P.decodeStatus(r.p);
assert.equal(st.settingsSum, P.checksum([16, 2, 4, 1]));
assert.equal(st.settingsPending, true);
r = await req(P.msg(P.CMD.RESET_SETTINGS, 1, 2, 3));
assert.equal(nakOf(r), P.NAK.MAGIC);
r = await req(P.msg(P.CMD.RESET_SETTINGS, ...P.MAGIC.RESET));
assert.deepEqual(P.decodeSettings(r.p), P.SETTINGS_DEFAULTS);
ok('settings: set, clamp, checksum, factory reset needs "DEF"');

r = await req(P.msg(P.CMD.GET_PRESETS));
let list = P.decodePresetList(r.p);
assert.equal(r.frames[0].length, 199);
assert.ok(list.every((x) => !x.used));
r = await req(P.msg(P.CMD.SAVE_PRESET, 4, ...[...'zap!x'].map((c) => c.charCodeAt(0))));
list = P.decodePresetList(r.p);
assert.deepEqual(list[4], { used: true, name: 'ZAP X' }, 'names: upper case, unknown characters become spaces');
r = await req(P.msg(P.CMD.SAVE_PRESET, 5, ...P.nameBytes('BUSY')));
assert.equal(nakOf(r), P.NAK.BUSY, 'one flash write at a time');
r = await req(P.msg(P.CMD.STATUS));
r = await req(P.msg(P.CMD.STATUS));
assert.equal(P.decodeStatus(r.p).flashBusy, false);
ok('SAVE_PRESET stores the current sound under a cleaned name; busy flash is refused');

r = await req(P.msg(P.CMD.GET_PRESET, 4));
let pr = P.decodePreset(r.p);
assert.deepEqual([pr.slot, pr.used, pr.name], [4, true, 'ZAP X']);
assert.deepEqual(pr.params, sound.params);
r = await req(P.msg(P.CMD.GET_PRESET, 9));
assert.deepEqual(P.decodePreset(r.p), { slot: 9, used: false, name: '', params: null });
ok('GET_PRESET: name and all 64 values; an empty slot says so');

const backup = P.defaultParams();
backup[2][P.P.res] = 77; backup[0][P.P.release] = 100;
r = await req(P.msg(P.CMD.WRITE_PRESET, 31, ...P.nameBytes('BAK'), ...P.encodeParams(backup)));
assert.deepEqual(P.decodePresetList(r.p)[31], { used: true, name: 'BAK  ' });
await req(P.msg(P.CMD.STATUS)); await req(P.msg(P.CMD.STATUS));
r = await req(P.msg(P.CMD.LOAD_PRESET, 31));
assert.deepEqual(P.decodeSound(r.p).params, backup);
r = await req(P.msg(P.CMD.LOAD_PRESET, 30));
assert.equal(nakOf(r), P.NAK.EMPTY);
ok('WRITE_PRESET from a backup, then LOAD_PRESET brings it back; empty slot refused');

r = await req(P.msg(P.CMD.CLEAR_PRESET, 31));
assert.equal(nakOf(r), P.NAK.LENGTH);
r = await req(P.msg(P.CMD.CLEAR_PRESET, 31, 1, 2, 3));
assert.equal(nakOf(r), P.NAK.MAGIC);
r = await req(P.msg(P.CMD.CLEAR_PRESET, 31, ...P.MAGIC.CLEAR));
assert.equal(P.decodePresetList(r.p)[31].used, false);
r = await req(P.msg(P.CMD.STATUS));
assert.equal(P.decodeStatus(r.p).presetSum, P.checksum(P.encodePresetList(P.decodePresetList(
  (await req(P.msg(P.CMD.GET_PRESETS))).p))));
ok('CLEAR_PRESET needs "CLR"; preset list checksum matches the page');

r = await req(P.msg(P.CMD.INIT_SOUND));
assert.equal(nakOf(r), P.NAK.MAGIC);
r = await req(P.msg(P.CMD.INIT_SOUND, ...P.MAGIC.INIT));
assert.deepEqual(P.decodeSound(r.p).params, P.defaultParams());
ok('INIT_SOUND needs "INI" and restores the INIT sound');

r = await req(P.msg(P.CMD.BOOTLOADER, 1, 2, 3));
assert.equal(nakOf(r), P.NAK.MAGIC);
assert.match(await send('STATE'), /boots=0/);
r = await req(P.msg(P.CMD.BOOTLOADER, ...P.MAGIC.BOOTLOADER));
assert.equal(r.cmd, P.RPL.BOOTLOADER);
assert.match(await send('STATE'), /boots=1/);
ok('BOOTLOADER needs "DFU", replies, then restarts');

r = await req(P.msg(0x3a));
assert.equal(nakOf(r), P.NAK.UNKNOWN);
r = await req([0xf0, 0x7d, 0x57, 0x53, 0x01, 0xf7]);
assert.equal(r.frames.length, 0, 'WEASEL frames are not for us');
r = await req(P.msg(P.CMD.SET_SOUND, 1, 2, 3));
assert.equal(nakOf(r), P.NAK.LENGTH);
ok('unknown commands, other instruments\' SysEx and wrong lengths');

// two frames in one USB packet, the second split by noise
const both = [...P.msg(P.CMD.GET_SETTINGS), 0x41, 0x42, ...P.msg(P.CMD.SET_VOICES, 0, 0)];
r = await req(both);
assert.deepEqual(r.frames.map((f) => f[4]), [P.RPL.SETTINGS, P.RPL.VOICES]);
ok('two requests in one read are both answered, in order');

await send('NOFLASH');
r = await req(P.msg(P.CMD.SAVE_PRESET, 0, ...P.nameBytes('X')));
assert.equal(nakOf(r), P.NAK.NO_FLASH);
r = await req(P.msg(P.CMD.INFO));
assert.equal(P.decodeInfo(r.p).flashOk, false);
ok('no SPI flash: INFO says so and saves are refused');

proc.stdin.end();
console.log(`\n${passed} firmware link tests passed`);
