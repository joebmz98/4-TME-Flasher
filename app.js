// The connection bar shared by the sound editor and the settings page:
// connect / try demo / disconnect, a quiet reconnect to the port this site
// already knows (so moving between pages stays connected), and a STATUS poll
// the page listens to.
//
// Expects these ids in the page: connLed, connTitle, connDetail, connectBtn,
// demoBtn, disconnectBtn. Adds `body.offline` while nothing is connected.

import { msg, CMD, RPL, PROTOCOL, decodeStatus, decodeInfo } from './protocol.js';
import { SerialTransport, DemoTransport, Link } from './transport.js';

const $ = (id) => document.getElementById(id);
const OFFLINE_TEXT = 'Plug 4-TME in with a micro-USB data cable, let it start up, then connect. Needs Chrome or Edge on a computer and 4-TME firmware v16 or later.';

export const isDemo = () => new URLSearchParams(location.search).has('demo');

// Keep ?demo on links between the tool pages, so the demo carries over.
export function keepDemoInLinks() {
  if (!isDemo()) return;
  document.querySelectorAll('a[data-tool]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href.includes('?')) a.setAttribute('href', href.replace(/(#.*)?$/, (h) => '?demo' + h));
  });
}

export function createConnection({ setStatus, onConnect = async () => {}, onStatus = () => {}, onDisconnect = () => {}, pollMs = 150 }) {
  let transport = null;
  let link = null;
  let pollTimer = null;
  let connected = false;
  let misses = 0;
  let info = null;

  function show(on, t = null) {
    connected = on;
    document.body.classList.toggle('offline', !on);
    $('connLed').className = 'led' + (on ? (t.kind === 'demo' ? ' demo' : ' on') : '');
    $('connectBtn').hidden = on;
    $('demoBtn').hidden = on;
    $('disconnectBtn').hidden = !on;
    $('disconnectBtn').textContent = on && t.kind === 'demo' ? 'Stop demo' : 'Disconnect';
    if (on) {
      $('connTitle').textContent = t.kind === 'demo' ? 'Demo 4-TME' : 'Connected to 4-TME';
      $('connDetail').textContent = t.kind === 'demo'
        ? 'A simulated 4-TME playing an arpeggio. Nothing is sent to real hardware.'
        : `Firmware ${info.version} · ${t.name}${info.flashOk ? '' : ' · no SPI flash found: presets and settings are not saved'}`;
    } else {
      $('connTitle').textContent = 'Not connected';
      $('connDetail').textContent = OFFLINE_TEXT;
    }
  }

  async function hello() {
    const i = decodeInfo(await link.request(msg(CMD.INFO), RPL.INFO, 1200));
    if (i.protocol !== PROTOCOL) {
      throw new Error(`This 4-TME speaks editor protocol ${i.protocol}; this page speaks ${PROTOCOL}. Update the firmware or reload the page.`);
    }
    return i;
  }

  async function poll() {
    if (!connected) return;
    if (!document.hidden) {
      try {
        const st = decodeStatus(await link.request(msg(CMD.STATUS), RPL.STATUS));
        misses = 0;
        if (connected) $('connLed').classList.remove('err');
        await onStatus(st);
      } catch (e) {
        if (!e.timeout) { fail(e); }
        else if (++misses >= 6) { fail(e); return; }
        else $('connLed').classList.add('err');
      }
    }
    if (connected) pollTimer = setTimeout(poll, pollMs);
  }

  async function connect(kind, { port = null, quiet = false } = {}) {
    if (kind === 'serial' && !SerialTransport.supported) {
      return setStatus('Web Serial is not available here. Use Chrome or Edge on a computer, with this page in its own tab.', 'error');
    }
    const t = kind === 'demo' ? new DemoTransport() : new SerialTransport();
    link = new Link(t);
    transport = t;
    t.onClose = () => { if (transport === t) { stop(); setStatus('4-TME disconnected.', 'error'); } };
    try {
      if (!quiet) setStatus(kind === 'serial' ? "Choose 4-TME's USB serial port in the popup" : 'Starting the demo');
      await t.open({ port });
      info = await hello();
      if (kind === 'demo') window.demoTme = t.device;    // for poking at it from the console
      show(true, t);
      await onConnect(link, info, t);
      setStatus(kind === 'demo' ? 'Demo: a simulated 4-TME. Nothing is sent anywhere.' : 'Connected.', 'ok');
      misses = 0;
      poll();
    } catch (e) {
      const wasConnected = connected;
      transport = null;
      if (wasConnected) stop();
      await t.close().catch(() => {});
      if (quiet) { setStatus(''); return; }
      if (e.name === 'NotFoundError' && /No port selected|No device/i.test(e.message)) return setStatus('No port chosen.');
      if (e.name === 'SecurityError') return setStatus('The browser blocked access. If this page is embedded in another site, open it in its own tab.', 'error');
      if (e.name === 'NetworkError' || e.name === 'InvalidStateError') return setStatus('Could not open the port. Close the Arduino serial monitor or any other app using it, then try again.', 'error');
      setStatus(e.timeout ? '4-TME did not answer. The editor needs firmware v16 or later: update it with the firmware flasher, built with USB support set to CDC.' : e.message, 'error');
    }
  }

  function stop() {
    clearTimeout(pollTimer);
    show(false);
    onDisconnect();
  }

  async function disconnect(text = 'Disconnected.') {
    const t = transport;
    transport = null;
    stop();
    if (t) await t.close().catch(() => {});
    setStatus(text);
  }

  function fail(e) {
    if (e && e.timeout) { disconnect('4-TME stopped answering. Check the cable, then connect again.'); return; }
    setStatus((e && e.message) || String(e), 'error');
  }

  $('connectBtn').addEventListener('click', () => connect('serial'));
  $('demoBtn').addEventListener('click', () => connect('demo'));
  $('disconnectBtn').addEventListener('click', () => disconnect());
  show(false);

  // On load: the demo if asked for, otherwise reopen the one port this site
  // already has permission for (no popup), so switching pages stays connected.
  (async () => {
    if (isDemo()) return connect('demo');
    const ports = await SerialTransport.knownPorts();
    if (ports.length === 1) {
      setStatus('Reconnecting to 4-TME…');
      await connect('serial', { port: ports[0], quiet: true });
    }
  })();

  return {
    get connected() { return connected; },
    get kind() { return transport ? transport.kind : null; },
    get info() { return info; },
    get link() { return link; },
    request: (frame, rpl, timeout) => link.request(frame, rpl, timeout),
    patient: (frame, rpl, opts) => link.requestPatient(frame, rpl, opts),
    fail,
  };
}

// Status line under the connection bar.
export function makeStatus(el) {
  const keepTogether = (s) => s.replace(/ (\S+)$/, ' $1');
  let timer = null;
  return (text, kind = '') => {
    clearTimeout(timer);
    el.textContent = text ? keepTogether(text) : '';
    el.className = 'status-line' + (kind ? ' ' + kind : '');
    el.hidden = !text;
    if (kind === 'ok') timer = setTimeout(() => { el.hidden = true; }, 4000);
  };
}

// Save a text file the person can keep.
export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
