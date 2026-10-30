// Ways to reach a 4-TME from the page. Each transport sends and receives the
// SysEx frames from protocol.js; Link adds request/reply on top.
//
//  SerialTransport  USB serial (Web Serial). DaisyDuino's USB port runs as a
//                   CDC serial port when the sketch is built with USB support
//                   set to CDC; the editor link in the firmware uses it.
//  DemoTransport    the simulated 4-TME in protocol.js.
//
// Same shape as the WEASEL flasher's transport.js.

import { FrameParser, isOurs, RPL, NAK_REASON, DemoTme } from './protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DAISY_VID = 0x0483;   // STMicroelectronics: the Seed's USB serial and its DFU bootloader

export class SerialTransport {
  static get supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }

  // Ports this site already has permission for that look like a Daisy Seed.
  static async knownPorts() {
    if (!SerialTransport.supported) return [];
    try {
      const ports = await navigator.serial.getPorts();
      return ports.filter((p) => (p.getInfo().usbVendorId || 0) === DAISY_VID);
    } catch (e) {
      return [];
    }
  }

  constructor() {
    this.kind = 'usb serial';
    this.onFrame = () => {};
    this.onClose = () => {};
    this.port = null;
    this.reader = null;
    this.closing = false;
  }

  // Ask the person to pick the port (filtered to STMicroelectronics).
  // `port`: one this site was already allowed to use (navigator.serial.getPorts()),
  // which opens without a popup, so moving between pages reconnects by itself.
  async open({ anyDevice = false, port = null } = {}) {
    const filters = anyDevice ? [] : [{ usbVendorId: DAISY_VID }];
    this.port = port || await navigator.serial.requestPort({ filters });
    await this.port.open({ baudRate: 115200, bufferSize: 4096 });
    // Some CDC stacks only send while DTR is set.
    try { await this.port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch (e) { /* not supported */ }
    const info = this.port.getInfo();
    this.name = info.usbVendorId
      ? `USB serial ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId || 0).toString(16).padStart(4, '0')}`
      : 'USB serial';
    this.parser = new FrameParser((f) => { if (isOurs(f)) this.onFrame(f); });
    this.readLoop();
  }

  async readLoop() {
    while (this.port && this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.parser.push(value);
        }
      } catch (e) {
        // Unplugged, or a framing glitch; fall through and see if the port is still there.
      } finally {
        try { this.reader.releaseLock(); } catch (e) { /* ignore */ }
      }
      if (!this.closing) await sleep(50);
      if (!this.port || !this.port.readable) break;
    }
    if (!this.closing) this.onClose();
  }

  async send(bytes) {
    const writer = this.port.writable.getWriter();
    try { await writer.write(Uint8Array.from(bytes)); } finally { writer.releaseLock(); }
  }

  async close() {
    this.closing = true;
    try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
    try { await this.port.close(); } catch (e) { /* ignore */ }
    this.port = null;
  }
}

export class DemoTransport {
  constructor(device = new DemoTme()) {
    this.kind = 'demo';
    this.name = 'Simulated 4-TME';
    this.onFrame = () => {};
    this.onClose = () => {};
    this.device = device;
    this.device.onReply = (f) => setTimeout(() => this.onFrame(f), 6);
  }
  async open() {}
  async send(bytes) { setTimeout(() => this.device.receive(Array.from(bytes)), 3); }
  async close() {}
}

// One request at a time: send a frame, wait for the matching reply (or a NAK).
export class Link {
  constructor(transport) {
    this.t = transport;
    this.queue = Promise.resolve();
    this.waiting = null;
    this.t.onFrame = (f) => this.frame(f);
  }

  frame(f) {
    const w = this.waiting;
    if (!w) return;
    const cmd = f[4];
    if (cmd === RPL.NAK && f[5] === w.cmd) {
      this.waiting = null;
      const e = new Error(`4-TME refused: ${NAK_REASON[f[6]] || 'reason ' + f[6]}`);
      e.nak = f[6];
      w.reject(e);
    } else if (cmd === w.expect) {
      this.waiting = null;
      w.resolve(Array.from(f.slice(5, -1)));
    }
  }

  request(frame, expect, timeoutMs = 800) {
    const run = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting && this.waiting.timer === timer) this.waiting = null;
        const e = new Error('4-TME did not answer');
        e.timeout = true;
        reject(e);
      }, timeoutMs);
      this.waiting = {
        cmd: frame[4], expect, timer,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.t.send(frame).catch((e) => { clearTimeout(timer); this.waiting = null; reject(e); });
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  // A request that retries while the flash is busy finishing a save (NAK 6).
  async requestPatient(frame, expect, { tries = 12, wait = 80, timeoutMs } = {}) {
    for (let i = 0; ; i++) {
      try {
        return await this.request(frame, expect, timeoutMs);
      } catch (e) {
        if (e.nak !== 6 || i >= tries) throw e;
        await sleep(wait);
      }
    }
  }
}
