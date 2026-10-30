// Run with: node test/run-tests.js   (Node 18 or newer, no packages needed)
// Flashes firmware images into a simulated STM32H750 (Daisy Seed) ROM
// bootloader and checks every byte that ends up in its flash. Also runs the
// SysEx protocol against the editor's simulated 4-TME.

import assert from 'node:assert/strict';
import { FirmwareImage, StmDfuse, parseIntelHex, parseMemoryLayout, DfuError, CHIPS, FLASH_BASE } from '../dfuse.js';
import { MockStm32Dfu } from './mock-stm32-dfu.js';
import * as P from '../protocol.js';

const H750 = CHIPS.STM32H750;

let passed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.stack}`);
    process.exitCode = 1;
  }
}

// A stand-in for a DaisyDuino build: vector table (stack in DTCM, reset
// handler in the image), code-like bytes, runs of 0xFF and zero padding.
function fakeFirmware(size, seed = 3) {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >> 16;
  }
  out.fill(0xff, 4096, 4096 + 700);   // a blank stretch that is not word aligned
  out.fill(0x00, 9000, 9500);
  out.fill(0xff, 20000, 20000 + 4096);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x20020000, true);
  dv.setUint32(4, FLASH_BASE + 0x1a1, true);
  return out;
}

function toHex(blocks) {
  const lines = [];
  const rec = (type, addr, data) => {
    const bytes = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
    const sum = (-bytes.reduce((a, b) => a + b, 0)) & 0xff;
    lines.push(':' + [...bytes, sum].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  };
  for (const { address, data } of blocks) {
    let hi = -1;
    for (let i = 0; i < data.length; i += 16) {
      const a = address + i;
      if (a >>> 16 !== hi) { hi = a >>> 16; rec(4, 0, [hi >> 8, hi & 0xff]); }
      rec(0, a & 0xffff, [...data.subarray(i, i + 16)]);
    }
  }
  rec(1, 0, []);
  return lines.join('\n');
}

const app = fakeFirmware(110 * 1024 + 13);  // odd length on purpose

function image(bytes = app, addr = FLASH_BASE) {
  const img = new FirmwareImage();
  img.addBin(bytes, addr, '4-tme.bin');
  return img;
}

function daisy(opts = {}) {
  return new MockStm32Dfu({ chip: 'h750', transferSize: 1024, ...opts });
}

async function flashInto(mock, img, opts = {}, dfuOpts = {}) {
  const dfu = new StmDfuse(mock, { log: () => {}, chip: H750, ...dfuOpts });
  await dfu.open();
  await dfu.flash(img, { verify: true, ...opts });
  return dfu;
}

function dataWrites(mock) { return mock.log.filter((l) => l.req === 1 && l.block >= 2); }

console.log('Images and layout (STM32H750)');

await test('H750 layout as the ROM reports it parses to 16 x 128 KB', () => {
  const l = parseMemoryLayout('@Internal Flash   /0x08000000/16*128Kg');
  assert.equal(l.sectors.length, 16);
  assert.equal(l.sectors[1].start, 0x08020000);
});

await test('segments are padded to whole 32 byte flash words with 0xFF', () => {
  const segs = image().segments(32);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].data.length % 32, 0);
  assert.ok(segs[0].data.subarray(app.length).every((b) => b === 0xff));
});

await test('parts that share a flash word are joined, not written twice', () => {
  const img = new FirmwareImage();
  img.addBin(new Uint8Array(40).fill(1), FLASH_BASE, 'a');
  img.addBin(new Uint8Array(40).fill(2), FLASH_BASE + 120, 'b'); // 0x78: same word as nothing, 80 byte gap
  img.addBin(new Uint8Array(8).fill(3), FLASH_BASE + 200, 'c');   // gap 40 < 64: merged
  const segs = img.segments(32);
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i].address >= segs[i - 1].address + segs[i - 1].data.length + 32 ||
      Math.floor(segs[i].address / 32) > Math.floor((segs[i - 1].address + segs[i - 1].data.length - 1) / 32));
  }
  for (const s of segs) { assert.equal(s.address % 32, 0); assert.equal(s.data.length % 32, 0); }
});

await test('a normal DaisyDuino build gets no warnings', () => {
  assert.deepEqual(image().warnings(H750), []);
});

await test('stack in AXI SRAM is accepted too', () => {
  const b = app.slice();
  new DataView(b.buffer).setUint32(0, 0x24080000, true);
  assert.deepEqual(image(b).warnings(H750), []);
});

await test('a Daisy bootloader build (0x90040000) is flagged', () => {
  assert.match(image(app, 0x90040000).warnings(H750).join(' '), /Daisy bootloader/);
});

await test('a build over 128 KB is flagged', () => {
  const big = fakeFirmware(140 * 1024);
  assert.match(image(big).warnings(H750).join(' '), /will not fit/);
});

await test('Intel HEX with a gap round-trips', () => {
  const hex = toHex([{ address: FLASH_BASE, data: app.subarray(0, 5000) }, { address: FLASH_BASE + 0x4000, data: app.subarray(0, 3000) }]);
  const blocks = parseIntelHex(hex);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1].data, app.subarray(0, 3000));
});

console.log('Flashing the simulated Daisy Seed bootloader');

await test('every byte lands where it should, over old firmware', async () => {
  const mock = daisy({ fillFlash: 0x00 });
  const dfu = await flashInto(mock, image());
  assert.deepEqual(mock.read(FLASH_BASE, app.length), app);
  assert.ok(mock.read(FLASH_BASE + app.length, 32 - (app.length % 32)).every((b) => b === 0xff), 'padding is blank');
  assert.equal(mock.doubleProgrammed, 0, 'no flash word programmed twice');
  assert.equal(mock.misaligned || 0, 0, 'every write starts on a flash word');
  assert.ok(dataWrites(mock).every((w) => w.len % 32 === 0), 'every write is whole flash words');
  assert.equal(dfu.transferSize, 1024);
});

await test('only the one 128 KB sector is erased', async () => {
  const mock = daisy({ fillFlash: 0x00 });
  await flashInto(mock, image());
  const erases = mock.log.filter((l) => l.req === 1 && l.block === 0 && l.cmd === 0x41);
  assert.equal(erases.length, 1);
  assert.ok(mock.read(0x08020000, 64).every((b) => b === 0x00), 'past 128 KB untouched');
});

await test('blank stretches are skipped in whole 32 byte words', async () => {
  const mock = daisy({ fillFlash: 0x00 });
  const logs = [];
  await flashInto(mock, image(), {}, { log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /Skipped 4\d{3} bytes that were 0xFF/.test(m)), logs.join('\n'));
  assert.deepEqual(mock.read(FLASH_BASE + 4096, 700), new Uint8Array(700).fill(0xff));
});

await test('writeSpans works in 32 byte words', () => {
  const dfu = new StmDfuse(daisy(), { chip: H750 });
  const d = new Uint8Array(128).fill(0xff);
  d[5] = 1;        // word 0 not blank
  d[64 + 31] = 2;  // word 2 not blank
  assert.deepEqual(dfu.writeSpans(d), [{ offset: 0, length: 32 }, { offset: 64, length: 32 }]);
});

await test('reads the layout from string descriptors when interface names are missing', async () => {
  const mock = daisy({ reportAltNames: false });
  const dfu = await flashInto(mock, image());
  assert.equal(dfu.layout.sectors.length, 16);
  assert.deepEqual(mock.read(FLASH_BASE, app.length), app);
});

await test('a build over 128 KB is refused before anything is erased', async () => {
  const mock = daisy({ fillFlash: 0x11 });
  const dfu = new StmDfuse(mock, { chip: H750 });
  await dfu.open();
  await assert.rejects(dfu.flash(image(fakeFirmware(130 * 1024))), /past the 128 KB/);
  assert.ok(mock.read(FLASH_BASE, 16).every((b) => b === 0x11));
});

await test('leave request makes the chip jump to 0x08000000', async () => {
  const mock = daisy();
  const dfu = await flashInto(mock, image());
  await dfu.leave();
  assert.equal(mock.jumpedTo, FLASH_BASE);
});

await test('recovers when an earlier session left the device in dfuERROR', async () => {
  const mock = daisy();
  mock.state = 10; mock.status = 15;
  await flashInto(mock, image());
  assert.deepEqual(mock.read(FLASH_BASE, app.length), app);
});

const FAST = { opDelayMs: 0, nakWhileBusy: false };

console.log('Unreliable USB');

await test('large transfers fail: blocks shrink, never below one flash word', async () => {
  const mock = daisy({ ...FAST, fillFlash: 0x00, failOutAbove: 256, failInAbove: 256 });
  const dfu = await flashInto(mock, image());
  assert.equal(dfu.blockSize, 256);
  assert.deepEqual(mock.read(FLASH_BASE, app.length), app);
  assert.equal(mock.misaligned || 0, 0);
});

await test('a link that fails every data transfer stops at 32 byte blocks with a clear error', async () => {
  const mock = daisy({ ...FAST, failOutAbove: 0 });
  const dfu = new StmDfuse(mock, { chip: H750 });
  await dfu.open();
  await assert.rejects(dfu.flash(image()), (e) => e.usbUnreliable === true && /even in 32 byte blocks/.test(e.message));
});

await test('random transfer errors, some after the chip took the data: verify + repair fix double-programmed words', async () => {
  const mock = daisy({ ...FAST, fillFlash: 0x00, flakyRate: 0.08, seed: 11 });
  const logs = [];
  await flashInto(mock, image(), {}, { log: (m) => logs.push(m) });
  assert.ok(mock.injectedFailures > 3);
  assert.deepEqual(mock.read(FLASH_BASE, app.length), app);
  assert.equal(mock.eccBad.size, 0, 'no flash word left with a bad ECC code');
});

await test('half-received blocks are thrown away, not programmed', async () => {
  const mock = daisy({ ...FAST, fillFlash: 0x00, packetErrorRate: 0.15, seed: 5 });
  await flashInto(mock, image());
  assert.ok(mock.injectedFailures > 0, 'the model should drop some transfers');
  assert.equal(mock.partialBlocksProgrammed, 0);
  assert.deepEqual(mock.read(FLASH_BASE, app.length), app);
});

await test('unplugging mid-write gives a disconnect message', async () => {
  const mock = daisy({ ...FAST, unplugAfterWrites: 3 });
  const dfu = new StmDfuse(mock, { chip: H750 });
  await dfu.open();
  await assert.rejects(dfu.flash(image()), /disconnected/);
});

await test('the F411 path still works (shared code with the MC8P flasher)', async () => {
  const mock = new MockStm32Dfu({ fillFlash: 0x00 });
  const dfu = new StmDfuse(mock, { log: () => {} });
  await dfu.open();
  const small = fakeFirmware(40000);
  await dfu.flash(image(small), { verify: true });
  assert.deepEqual(mock.read(FLASH_BASE, small.length), small);
});

console.log('The release firmware');

await test('manifest.json points at a build that fits and passes the H750 checks', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
  const part = manifest.builds[0].parts[0];
  const bytes = new Uint8Array(await readFile(new URL('../' + part.path, import.meta.url)));
  const img = new FirmwareImage();
  img.addBin(bytes, parseInt(part.offset, 16), part.path);
  assert.deepEqual(img.warnings(H750), []);
  assert.ok(bytes.length <= 128 * 1024);
  const mock = daisy({ fillFlash: 0x00 });
  await flashInto(mock, img);
  assert.deepEqual(mock.read(FLASH_BASE, bytes.length), bytes);
});

console.log('SysEx protocol (pages <-> simulated 4-TME)');

const ask = (dev, frame) => { let out = null; dev.onReply = (f) => { out = f; }; dev.receive(frame); return out; };

await test('frames carry the "4T" header and stay 7-bit', () => {
  const f = P.msg(P.CMD.SET_SOUND, ...P.encodeSound(P.defaultSound()));
  assert.deepEqual(f.slice(0, 4), [0xf0, 0x7d, 0x34, 0x54]);
  assert.ok(f.slice(1, -1).every((b) => b < 0x80));
  assert.ok(P.isOurs(f));
  assert.ok(!P.isOurs([0xf0, 0x7d, 0x57, 0x53, 1, 0xf7]), 'WEASEL frames are not ours');
});

await test('16 parameters in firmware order with the firmware maxima and INIT values', () => {
  assert.deepEqual(P.PARAMS.map((p) => p.max), [240, 150, 96, 100, 98, 100, 100, 100, 0, 100, 100, 100, 100, 100, 100, 100]);
  assert.deepEqual([...P.PARAM_DEFAULTS], [120, 50, 48, 0, 98, 0, 50, 0, 0, 0, 42, 50, 42, 59, 50, 80]);
});

await test('value text matches the firmware formatParam()', () => {
  const t = (k, p) => P.formatParam(P.P[k], p);
  assert.equal(t('tune', 120), '0.0 ST');
  assert.equal(t('tune', 0), '-12.0 ST');
  assert.equal(t('wave', 25), 'TRI>SAW 50');
  assert.equal(t('wave', 100), 'SQUARE');
  assert.equal(t('wave', 150), 'PW 5%');
  assert.equal(t('cutoff', 98), '17.8 KHZ');
  assert.equal(t('cutoff', 30), '160 HZ');
  assert.equal(t('attack', 0), '1 MS');
  assert.equal(t('decay', 42), '48 MS');
  assert.equal(t('release', 100), '10.00 S');
  assert.equal(t('lfoRate', 59), '1.98 HZ');
  assert.equal(t('lfoRate', 100), '25.6 HZ');
  assert.equal(t('pan', 50), 'CENTRE');
  assert.equal(t('pan', 20), 'L 60');
  assert.equal(t('fltEnv', 75), '+2.5 OCT');
});

await test('sound and preset encodings round-trip, values above 127 included', () => {
  const s = { selVoice: 3, muteMask: 5, params: P.defaultParams() };
  s.params[1][P.P.tune] = 240; s.params[2][P.P.wave] = 149;
  assert.equal(P.encodeSound(s).length, P.SOUND_BYTES);
  assert.deepEqual(P.decodeSound(P.encodeSound(s)), s);
  const list = Array.from({ length: 32 }, (_, i) => (i % 3 ? { used: false, name: '' } : { used: true, name: P.cleanName('ab-' + i) }));
  assert.deepEqual(P.decodePresetList(P.encodePresetList(list)), list);
  assert.equal(P.cleanName('zap!'), 'ZAP  ');
});

await test('stream parser pulls frames out of serial noise and split reads', () => {
  const frames = [];
  const parser = new P.FrameParser((f) => frames.push(f));
  const big = P.msg(P.RPL.PRESETS, ...P.encodePresetList([]));
  parser.push([0x41, 0x0d, 0x0a, ...big.slice(0, 40)]);
  parser.push(big.slice(40));
  parser.push([0xf0, 0x7d, 0x80, 0xf7, 0x20]);   // broken frame: dropped
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], big);
});

await test('simulated 4-TME: param edits, group mask, presets, settings, NAKs', () => {
  const d = new P.DemoTme();
  let r = P.payload(ask(d, P.msg(P.CMD.SET_PARAM, 0b0110, P.P.res, 77, 0)));
  assert.equal(r[0], P.P.res);
  assert.deepEqual([r[1], r[3], r[5], r[7]], [d.sound.params[0][P.P.res], 77, 77, d.sound.params[3][P.P.res]]);
  r = ask(d, P.msg(P.CMD.SAVE_PRESET, 9, ...P.nameBytes('test')));
  assert.equal(P.decodePresetList(P.payload(r))[9].name, 'TEST ');
  r = ask(d, P.msg(P.CMD.SAVE_PRESET, 10, ...P.nameBytes('busy')));
  assert.deepEqual(P.payload(r), [P.CMD.SAVE_PRESET, P.NAK.BUSY], 'one flash write at a time');
  d.busyUntil = 0;
  r = P.decodeSound(P.payload(ask(d, P.msg(P.CMD.LOAD_PRESET, 9))));
  assert.equal(r.params[1][P.P.res], 77);
  r = ask(d, P.msg(P.CMD.CLEAR_PRESET, 9, 0, 0, 0));
  assert.deepEqual(P.payload(r), [P.CMD.CLEAR_PRESET, P.NAK.MAGIC]);
  r = P.decodeSettings(P.payload(ask(d, P.msg(P.CMD.SET_SETTINGS, 3, 0, 4, 0))));
  assert.deepEqual(r, { midiChannel: 3, ledLevel: 0, saverIdx: 4, showValues: 0 });
  const st = P.decodeStatus(P.payload(ask(d, P.msg(P.CMD.STATUS))));
  assert.equal(st.soundSum, P.soundSum(d.sound));
  assert.equal(st.settingsSum, P.checksum([3, 0, 4, 0]));
  assert.equal(st.settingsPending, true);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
