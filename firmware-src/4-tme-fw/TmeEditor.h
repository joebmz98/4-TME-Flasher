// ********************** //
// 4-TME editor link      //
// sound, presets and     //
// settings over USB from //
// the web editor         //
// ********************** //
//
// Protocol: see protocol.js in the 4-TME-Flasher repo. Frames are
//   F0 7D 34 54 <cmd> <data...> F7
// carried over the Daisy Seed's USB port as a CDC serial port.
//
// Arduino IDE: Tools > USB support > "CDC (generic 'Serial' supersede U(S)ART)"
// (or "CDC (no generic 'Serial')"); either way SerialUSB is the USB port.
// MIDI keeps using Serial1 (DIN in on D30).
//
// This file only speaks the protocol. Everything it reads or changes goes
// through the tmeHook...() functions, which the sketch defines (bottom of
// 4-tme-fw.ino): the same code paths as the panel, so the SPI flash, the
// last-state ring and the OLED stay in charge of the sketch.

#pragma once

#include <stdint.h>
#include <string.h>

#ifndef TME_EDITOR_SERIAL
#define TME_EDITOR_SERIAL SerialUSB
#endif

// ---- implemented by the sketch ----
// results for the preset hooks: 0 = done, otherwise a NAK reason below
enum TmeResult : uint8_t { TME_OK = 0, TME_NO_FLASH = 5, TME_BUSY = 6, TME_EMPTY = 7 };

uint8_t tmeHookFlags();                                  // bit0 flash found, bit1 flash busy, bit2 settings unsaved, bit3 sound unsaved
void    tmeHookGetSettings(uint8_t *s);                  // 4 bytes: MIDI channel (0 = omni, 1-16), LEDS 0-2, display timeout 0-4, values 0/1
void    tmeHookSetSettings(const uint8_t *s);            // already clamped; apply now, save soon
void    tmeHookResetSettings();
int16_t tmeHookParamMax(uint8_t id);
int16_t tmeHookGetParam(uint8_t voice, uint8_t id);
void    tmeHookSetParam(uint8_t voice, uint8_t id, int16_t value);   // already clamped
void    tmeHookSoundChanged(uint8_t voice, uint8_t id, bool readout);  // after a batch of SetParam calls
uint8_t tmeHookSelVoice();
uint8_t tmeHookMuteMask();
void    tmeHookSetVoices(uint8_t selVoice, uint8_t muteMask);
bool    tmeHookPresetInfo(uint8_t slot, char *name);     // from the directory in RAM; name = 5 chars
uint8_t tmeHookReadPreset(uint8_t slot, char *name, int16_t *params);   // params = [voice][param], 64 values
uint8_t tmeHookLoadPreset(uint8_t slot);
uint8_t tmeHookSavePreset(uint8_t slot, const char *name);              // the current sound
uint8_t tmeHookWritePreset(uint8_t slot, const char *name, const int16_t *params);
uint8_t tmeHookClearPreset(uint8_t slot);
void    tmeHookInitSound();
void    tmeHookVoices(uint8_t *gates, uint8_t *env, uint8_t *lfo);      // env, lfo: 4 bytes 0-127
void    tmeHookBootloader();

namespace tme {

static const char *const FW_VERSION = "16.0";
static const uint8_t PROTOCOL = 1;
static const uint8_t VOICES = 4;
static const uint8_t PARAMS = 16;
static const uint8_t PRESETS = 32;
static const uint8_t NAME_LEN = 5;
static const uint8_t SETTINGS_COUNT = 4;
static const uint8_t SETTINGS_MAX[SETTINGS_COUNT] = { 16, 2, 4, 1 };
static const char NAME_CHARS[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ";

class Editor {
 public:
  void begin() { TME_EDITOR_SERIAL.begin(115200); }

  // from the MIDI handlers, for the page's MIDI monitor
  void noteIn(uint8_t channel, uint8_t note, uint8_t velocity) {
    lastNote_ = note & 0x7F;
    lastChannel_ = (channel - 1) & 0x0F;
    lastVelocity_ = velocity & 0x7F;
    anyNote_ = true;
    activity();
  }
  void activity() { activity_ = (activity_ + 1) & 0x7F; }

  // ---- call from loop() ----
  void poll() {
    // a few frames per pass at most, so MIDI and the encoders are never kept waiting
    for (int budget = 512; budget > 0 && TME_EDITOR_SERIAL.available() > 0; budget--) {
      int c = TME_EDITOR_SERIAL.read();
      if (c < 0) break;
      uint8_t b = (uint8_t)c;
      if (b == 0xF0) { len_ = 0; buf_[len_++] = b; inFrame_ = true; continue; }
      if (!inFrame_) continue;  // anything between frames is ignored
      if (b == 0xF7) {
        inFrame_ = false;
        if (len_ < sizeof(buf_)) { buf_[len_++] = b; handle(buf_, len_); }
        continue;
      }
      if ((b & 0x80) || len_ >= sizeof(buf_) - 1) { inFrame_ = false; continue; }
      buf_[len_++] = b;
    }
  }

  // Same checksum as protocol.js checksum().
  static uint8_t sum(const uint8_t *b, uint16_t n, uint8_t c = 0) {
    for (uint16_t i = 0; i < n; i++) c = (uint8_t)((c * 3 + b[i] + 1) & 0x7F);
    return c;
  }

 private:
  enum : uint8_t {
    CMD_INFO = 0x01, CMD_GET_SETTINGS, CMD_SET_SETTINGS, CMD_GET_SOUND, CMD_SET_PARAM, CMD_SET_SOUND,
    CMD_STATUS, CMD_SET_VOICES, CMD_GET_PRESETS, CMD_GET_PRESET, CMD_LOAD_PRESET, CMD_SAVE_PRESET,
    CMD_WRITE_PRESET, CMD_CLEAR_PRESET, CMD_INIT_SOUND, CMD_RESET_SETTINGS, CMD_BOOTLOADER,
    RPL_NAK = 0x7F,
    NAK_UNKNOWN = 1, NAK_LENGTH = 2, NAK_MAGIC = 3, NAK_RANGE = 4,
  };
  static const uint16_t PARAM_BYTES = VOICES * PARAMS * 2;   // 128
  static const uint16_t SOUND_BYTES = 2 + PARAM_BYTES;       // 130

  // ---- replies ----
  void start(uint8_t cmd) { k_ = 0; out_[k_++] = 0xF0; out_[k_++] = 0x7D; out_[k_++] = 0x34; out_[k_++] = 0x54; out_[k_++] = cmd; }
  void put(uint8_t b) { if (k_ < sizeof(out_) - 1) out_[k_++] = b & 0x7F; }
  void put14(int16_t v) { put((uint8_t)(v & 0x7F)); put((uint8_t)((v >> 7) & 0x7F)); }
  void end() { out_[k_++] = 0xF7; TME_EDITOR_SERIAL.write(out_, k_); }

  void nak(uint8_t cmd, uint8_t reason) { start(RPL_NAK); put(cmd); put(reason); end(); }

  static int16_t get14(const uint8_t *p) { return (int16_t)((p[0] & 0x7F) | ((p[1] & 0x7F) << 7)); }
  static int16_t clampParam(uint8_t id, int16_t v) {
    int16_t mx = tmeHookParamMax(id);
    return v < 0 ? 0 : (v > mx ? mx : v);
  }

  static void cleanName(const uint8_t *in, char *out) {
    for (uint8_t i = 0; i < NAME_LEN; i++) {
      char c = (char)in[i];
      if (c >= 'a' && c <= 'z') c = (char)(c - 32);
      out[i] = (c != 0 && strchr(NAME_CHARS, c)) ? c : ' ';
    }
  }

  void settings(uint8_t *s) {
    memset(s, 0, SETTINGS_COUNT);
    tmeHookGetSettings(s);
    for (uint8_t i = 0; i < SETTINGS_COUNT; i++) if (s[i] > SETTINGS_MAX[i]) s[i] = SETTINGS_MAX[i];
  }
  void sendSettings() {
    uint8_t s[SETTINGS_COUNT];
    settings(s);
    start(0x42);
    for (uint8_t i = 0; i < SETTINGS_COUNT; i++) put(s[i]);
    end();
  }

  // sound = selected voice, mute mask, then [voice][param] values
  template <typename F> void eachSoundByte(F f) {
    f(tmeHookSelVoice() & 0x03);
    f(tmeHookMuteMask() & 0x0F);
    for (uint8_t v = 0; v < VOICES; v++)
      for (uint8_t id = 0; id < PARAMS; id++) {
        int16_t x = tmeHookGetParam(v, id);
        f((uint8_t)(x & 0x7F));
        f((uint8_t)((x >> 7) & 0x7F));
      }
  }
  void sendSound() { start(0x44); eachSoundByte([this](uint8_t b) { put(b); }); end(); }
  uint8_t soundSum() { uint8_t c = 0; eachSoundByte([&c](uint8_t b) { c = sum(&b, 1, c); }); return c; }

  template <typename F> void eachPresetListByte(F f) {
    f(PRESETS);
    char name[NAME_LEN];
    for (uint8_t i = 0; i < PRESETS; i++) {
      bool used = tmeHookPresetInfo(i, name);
      f(used ? 1 : 0);
      for (uint8_t c = 0; c < NAME_LEN; c++) f(used ? (uint8_t)name[c] & 0x7F : ' ');
    }
  }
  void sendPresetList() { start(0x49); eachPresetListByte([this](uint8_t b) { put(b); }); end(); }
  uint8_t presetSum() { uint8_t c = 0; eachPresetListByte([&c](uint8_t b) { c = sum(&b, 1, c); }); return c; }

  void sendStatus() {
    uint8_t s[SETTINGS_COUNT];
    settings(s);
    uint8_t gates = 0, env[VOICES] = { 0 }, lfo[VOICES] = { 64, 64, 64, 64 };
    tmeHookVoices(&gates, env, lfo);
    uint8_t flags = tmeHookFlags() & 0x0F;
    if (anyNote_) flags |= 0x10;
    start(0x47);
    put(flags);
    put(soundSum());
    put(sum(s, SETTINGS_COUNT));
    put(presetSum());
    put(activity_);
    put(lastNote_); put(lastChannel_); put(lastVelocity_);
    put(gates & 0x0F);
    for (uint8_t v = 0; v < VOICES; v++) put(env[v]);
    for (uint8_t v = 0; v < VOICES; v++) put(lfo[v]);
    end();
  }

  // NAK if the hook failed, otherwise the reply
  bool fail(uint8_t cmd, uint8_t result) {
    if (result == TME_OK) return false;
    nak(cmd, result);
    return true;
  }

  void handle(const uint8_t *f, uint16_t n) {
    if (n < 6 || f[1] != 0x7D || f[2] != 0x34 || f[3] != 0x54) return;  // someone else's SysEx
    uint8_t cmd = f[4];
    const uint8_t *p = f + 5;
    uint16_t pn = n - 6;
    auto magic = [&](uint16_t at, uint8_t a, uint8_t b, uint8_t c) {
      return pn >= at + 3 && p[at] == a && p[at + 1] == b && p[at + 2] == c;
    };

    switch (cmd) {
      case CMD_INFO: {
        uint8_t flags = tmeHookFlags();
        start(0x41);
        put(PROTOCOL); put(VOICES); put(PARAMS); put(PRESETS); put(NAME_LEN); put(flags & 1);
        for (const char *c = FW_VERSION; *c; c++) put((uint8_t)*c);
        end();
        break;
      }

      case CMD_GET_SETTINGS: sendSettings(); break;
      case CMD_SET_SETTINGS: {
        if (pn != SETTINGS_COUNT) { nak(cmd, NAK_LENGTH); break; }
        uint8_t s[SETTINGS_COUNT];
        for (uint8_t i = 0; i < SETTINGS_COUNT; i++) s[i] = p[i] > SETTINGS_MAX[i] ? SETTINGS_MAX[i] : p[i];
        tmeHookSetSettings(s);
        sendSettings();
        break;
      }
      case CMD_RESET_SETTINGS:
        if (!magic(0, 0x44, 0x45, 0x46)) { nak(cmd, NAK_MAGIC); break; }
        tmeHookResetSettings();
        sendSettings();
        break;

      case CMD_GET_SOUND: sendSound(); break;
      case CMD_SET_PARAM: {
        if (pn != 4) { nak(cmd, NAK_LENGTH); break; }
        uint8_t mask = p[0] & 0x0F, id = p[1];
        if (!mask || id >= PARAMS) { nak(cmd, NAK_RANGE); break; }
        int16_t v = clampParam(id, get14(p + 2));
        uint8_t first = 0xFF;
        for (uint8_t i = 0; i < VOICES; i++)
          if ((mask >> i) & 1) { tmeHookSetParam(i, id, v); if (first == 0xFF) first = i; }
        tmeHookSoundChanged(first, id, true);
        start(0x45);
        put(id);
        for (uint8_t i = 0; i < VOICES; i++) put14(tmeHookGetParam(i, id));
        end();
        break;
      }
      case CMD_SET_SOUND: {
        if (pn != SOUND_BYTES) { nak(cmd, NAK_LENGTH); break; }
        for (uint8_t v = 0; v < VOICES; v++)
          for (uint8_t id = 0; id < PARAMS; id++)
            tmeHookSetParam(v, id, clampParam(id, get14(p + 2 + (v * PARAMS + id) * 2)));
        tmeHookSetVoices(p[0] & 0x03, p[1] & 0x0F);
        tmeHookSoundChanged(0, 0, false);
        sendSound();
        break;
      }
      case CMD_SET_VOICES:
        if (pn != 2) { nak(cmd, NAK_LENGTH); break; }
        tmeHookSetVoices(p[0] > 3 ? 3 : p[0], p[1] & 0x0F);
        start(0x48); put(tmeHookSelVoice()); put(tmeHookMuteMask()); end();
        break;
      case CMD_INIT_SOUND:
        if (!magic(0, 0x49, 0x4E, 0x49)) { nak(cmd, NAK_MAGIC); break; }
        tmeHookInitSound();
        sendSound();
        break;

      case CMD_STATUS: sendStatus(); break;

      case CMD_GET_PRESETS: sendPresetList(); break;
      case CMD_GET_PRESET: {
        if (pn != 1) { nak(cmd, NAK_LENGTH); break; }
        if (p[0] >= PRESETS) { nak(cmd, NAK_RANGE); break; }
        char name[NAME_LEN];
        int16_t params[VOICES * PARAMS];
        uint8_t r = tmeHookReadPreset(p[0], name, params);
        if (r != TME_OK && r != TME_EMPTY) { nak(cmd, r); break; }
        start(0x4A);
        put(p[0]);
        put(r == TME_OK ? 1 : 0);
        if (r == TME_OK) {
          for (uint8_t c = 0; c < NAME_LEN; c++) put((uint8_t)name[c]);
          for (uint8_t i = 0; i < VOICES * PARAMS; i++) put14(clampParam(i % PARAMS, params[i]));
        }
        end();
        break;
      }
      case CMD_LOAD_PRESET:
        if (pn != 1) { nak(cmd, NAK_LENGTH); break; }
        if (p[0] >= PRESETS) { nak(cmd, NAK_RANGE); break; }
        if (fail(cmd, tmeHookLoadPreset(p[0]))) break;
        sendSound();
        break;
      case CMD_SAVE_PRESET: {
        if (pn != 1 + NAME_LEN) { nak(cmd, NAK_LENGTH); break; }
        if (p[0] >= PRESETS) { nak(cmd, NAK_RANGE); break; }
        char name[NAME_LEN];
        cleanName(p + 1, name);
        if (fail(cmd, tmeHookSavePreset(p[0], name))) break;
        sendPresetList();
        break;
      }
      case CMD_WRITE_PRESET: {
        if (pn != 1 + NAME_LEN + PARAM_BYTES) { nak(cmd, NAK_LENGTH); break; }
        if (p[0] >= PRESETS) { nak(cmd, NAK_RANGE); break; }
        char name[NAME_LEN];
        cleanName(p + 1, name);
        int16_t params[VOICES * PARAMS];
        for (uint8_t i = 0; i < VOICES * PARAMS; i++) params[i] = clampParam(i % PARAMS, get14(p + 1 + NAME_LEN + i * 2));
        if (fail(cmd, tmeHookWritePreset(p[0], name, params))) break;
        sendPresetList();
        break;
      }
      case CMD_CLEAR_PRESET:
        if (pn != 4) { nak(cmd, NAK_LENGTH); break; }
        if (p[0] >= PRESETS) { nak(cmd, NAK_RANGE); break; }
        if (!magic(1, 0x43, 0x4C, 0x52)) { nak(cmd, NAK_MAGIC); break; }
        if (fail(cmd, tmeHookClearPreset(p[0]))) break;
        sendPresetList();
        break;

      case CMD_BOOTLOADER:
        if (!magic(0, 0x44, 0x46, 0x55)) { nak(cmd, NAK_MAGIC); break; }
        start(0x51); end();
        TME_EDITOR_SERIAL.flush();
        delay(100);                     // let the reply leave before USB drops
        tmeHookBootloader();
        break;

      default: nak(cmd, NAK_UNKNOWN); break;
    }
  }

  uint8_t buf_[160];                   // longest request: WRITE_PRESET, 140 bytes
  uint16_t len_ = 0;
  bool inFrame_ = false;
  uint8_t out_[208];                   // longest reply: the preset list, 199 bytes
  uint16_t k_ = 0;

  uint8_t lastNote_ = 0, lastChannel_ = 0, lastVelocity_ = 0, activity_ = 0;
  bool anyNote_ = false;
};

}  // namespace tme
