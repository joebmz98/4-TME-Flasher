# 4-TME-Flasher

Web tools for **4-TME**, the .axs instruments 4-voice poly synth (Daisy Seed,
STM32H750): a sound and preset editor, the settings menu, and a firmware
flasher. Nothing to install. They run in **Chrome or Edge on a computer** and
need a micro-USB data cable into the Seed.

Same 1-bit pixel look as the DCLK and MC8P MkII web tools; the flasher is the
WEASEL one (Daisy Seed / H750 DfuSe).

| Page | Opens | Talks to 4-TME over | 4-TME needs to be |
| --- | --- | --- | --- |
| **Sound & presets** | `editor.html` | Web Serial (USB CDC) + SysEx frames | Running, firmware v16 or later |
| **Settings** | `settings.html` | Web Serial (USB CDC) + SysEx frames | Running, firmware v16 or later |
| **Update firmware** | `index.html#flash` | WebUSB, to the STM32 ROM DFU bootloader | In DFU mode |

Connect once and the other pages reconnect by themselves (Chrome remembers the
port). **Try demo** runs any page against a simulated 4-TME playing an
arpeggio; add `?demo` to an address to start in the demo.

## Sound & presets (`editor.html`)

- **Screen:** a pixel-for-pixel copy of the 128x32 OLED: the planets art
  (shape = wave, size = level + envelope, fill = cutoff, spikes = resonance,
  spin = LFO rate, position = pan / tune), the parameter readout while a knob
  turns (respects the VALUES setting), and the SAVED / LOADED messages. Same
  Picopixel bitmaps and drawing rules as the firmware (`oled.js` is a port of
  `drawArt()` / `drawUI()`).
- **Voices:** click a voice to edit it (the panel's voice buttons; 4-TME's
  selected voice follows). **Shift** is the SHIFT key: pick a group and every
  knob moves each voice in it by the same amount. **Mute** = BACK + voice
  button. The orange LEDs follow each voice's envelope like the panel's.
- **Knobs:** all 16 encoders, grouped Oscillator / Filter / Envelope / LFO /
  VCA; big knobs where the panel has Moog-style knobs, trimmers for the RV09s.
  Drag, scroll or arrow keys; double-click = INIT value. Values read exactly as
  on the OLED. Cutoff CV is shown but disabled (`PARAM_MAX` 0 in the firmware).
- **Voice tools:** copy a voice to others, init a voice, randomise (playable
  ranges).
- **Presets:** the 32 slots in 4-TME's SPI flash. Load, save (5-character
  name, A-Z 0-9 dash space), overwrite and clear (both click twice), INIT
  sound. A dot marks the slot the current sound matches. **Back up all**
  writes a readable JSON file (values by name); **Restore** writes those slots
  back.
- Turning an encoder on 4-TME moves the knob here; edits from the page show on
  4-TME's screen like turning its encoder. 4-TME keeps the sound through
  power-off by itself (last-state ring, 2 s after the last change).
- Offline, the knobs edit a draft; on connect you choose to send it or keep
  4-TME's sound.

## Settings (`settings.html`)

The SETTINGS menu: MIDI in channel (omni / 1-16), LEDS (low / mid / high, with
a preview), VALUES (readout on / off), DISPLAY timeout (off / 1 / 5 / 10 / 30
min), reset to defaults. Changes apply at once; 4-TME saves them 0.5 s later,
as when confirming in the menu. Plus a MIDI in monitor (note, channel,
velocity, activity, which voice each note went to).

## Protocol

`F0 7D 34 54 <cmd> <data...> F7` (7D = non-commercial ID, `34 54` = "4T"),
over the Seed's USB port as a serial port. Bytes outside a frame are ignored,
so debug prints don't get in the way. Replies are `cmd | 0x40`; parameter
values are 14-bit (lo, hi). The full table is at the top of `protocol.js`.

| Cmd | Request | Reply |
| --- | --- | --- |
| `01` | INFO | `41` protocol, voices, params, presets, name length, flash found, version |
| `02` / `03` | GET / SET_SETTINGS `<4>` | `42` channel, LEDS, display, values |
| `04` / `06` | GET / SET_SOUND `<130>` | `44` selected voice, mutes, 4 x 16 values |
| `05` | SET_PARAM `<voice mask> <param> <lo> <hi>` | `45` param + all 4 voices' value |
| `07` | STATUS | `47` flags, checksums, MIDI monitor, gates, envelopes, LFOs |
| `08` | SET_VOICES `<selected> <mutes>` | `48` |
| `09` / `0A` | GET_PRESETS / GET_PRESET `<slot>` | `49` list / `4A` name + values |
| `0B` | LOAD_PRESET `<slot>` | `44` |
| `0C` / `0D` | SAVE_PRESET `<slot> <name>` / WRITE_PRESET `<slot> <name> <values>` | `49` |
| `0E` | CLEAR_PRESET `<slot> "CLR"` | `49` |
| `0F` / `10` | INIT_SOUND `"INI"` / RESET_SETTINGS `"DEF"` | `44` / `42` |
| `11` | BOOTLOADER `"DFU"` | `51`, then the Seed restarts in DFU mode |
| | refused | `7F <cmd> <reason>` (busy flash = 6: the pages retry) |

## Firmware side (`firmware-src/`)

`firmware-src/4-tme-fw/` is `src/4-tme-fw` from
[4-TME-PolySynth](https://github.com/joebmz98/4-TME-PolySynth) (prototype
v15.6) with the USB link added, as **v16.0**. `firmware-src/4-TME-FW-16.0.patch`
shows exactly what changed:

- `TmeEditor.h` (new): speaks the protocol. Everything it reads or changes
  goes through `tmeHook...()` functions at the bottom of the sketch, which use
  the panel's own code paths (`applyParam`, `loadPreset`, the background flash
  jobs, `requestSettingsSave`, `markStateDirty`, toasts, OLED readout), so
  nothing in flash is written differently from the panel.
- `4-tme-fw.ino`: `#include`, `editor.begin()` / `editor.poll()`, MIDI
  handlers feed the monitor, `startPresetSave()` split into
  `startPresetWrite()` so backups can be restored, and the hooks.

**Build:** Arduino IDE, Daisy Seed board,
**Tools > USB support > CDC (generic 'Serial' supersede U(S)ART)** and
**Tools > Optimize > Faster (-O2) with LTO**. With CDC on, `-O3` no longer fits
the 128 KB internal flash (overflows by ~19 KB with STM32 core 2.12.0 /
GCC 14); `-O2 LTO` is 122.6 KB (93%), `-Os` is 118.6 KB. MIDI stays on
`Serial1` (D30).

`firmware/4-tme-fw.ino.bin` (the release in `manifest.json`) is that sketch
built with STM32 core 2.12.0, DaisyDuino 1.7.0, MIDI 5.0.2, Adafruit GFX
1.13.0, SSD1306 2.5.17, `usb=CDCgen,opt=o2lto`. It has been compiled but not
yet run on a 4-TME, hence **beta**.

`npm run test:firmware` compiles `TmeEditor.h` on your computer with a
stand-in for the sketch's hooks and checks it against `protocol.js` (needs
g++ only).

## Update firmware (flasher)

1. Connect the Seed's micro-USB straight to the computer.
2. DFU mode: **hold BOOT, tap RESET, release BOOT**. Or, with v16 running,
   **Restart 4-TME into DFU mode** on the flasher page does it over USB.
3. Pick the firmware, click **Flash Firmware**, choose **DFU in FS Mode**.
4. Wait for **Done**.

Presets, settings and the last sound live in the W25Q64, which the flasher
never touches. `dfuse.js` is the WEASEL flasher's (H750: 32-byte flash words,
128 KB, Daisy-bootloader builds flagged, verify and repair).

Troubleshooting is on the page: Zadig/WinUSB on Windows, a udev rule on Linux,
`?block=256` for flaky links.

## Releasing new firmware

1. Build as above, **Sketch > Export Compiled Binary**, copy the `.bin` into
   `firmware/`.
2. Update `manifest.json` (`version`, `path`, `offset` `0x08000000`, optional
   `note`).
3. If the protocol changed, bump `PROTOCOL` in `protocol.js` and
   `TmeEditor.h`.
4. `npm test` (Node 18+, no packages) and `npm run test:firmware`, commit, push.

## Repo layout

| File | What it is |
| --- | --- |
| `index.html` | Start page and the flasher (`#flash`) |
| `editor.html` | Sound & presets |
| `settings.html` | Settings and MIDI monitor |
| `app.js` | Connection bar shared by the two editors |
| `protocol.js` | Protocol, parameter table and value text, simulated 4-TME |
| `transport.js` | Web Serial and demo transports, request/reply |
| `oled.js` | The OLED copy: Picopixel and the firmware's planet art |
| `dfuse.js` | STM32 DfuSe over WebUSB, with the H750 chip table |
| `theme.css` | The DCLK / MC8P pixel theme plus 4-TME parts (orange LEDs, planet) |
| `assets/` | Fonts (licences included), planet art and icons (`tools/make-art.py` draws them with the firmware's Bayer dither) |
| `firmware/`, `manifest.json` | The release |
| `firmware-src/` | 4-TME v16 with the USB link |
| `test/` | Simulated H750 ROM bootloader, flasher and protocol tests; host build of the firmware link |

## Hosting

GitHub Pages (Settings > Pages > Deploy from branch > `main` / root). WebUSB
and Web Serial need HTTPS, which Pages provides.
