// Host build of TmeEditor.h with a stand-in for the 4-TME sketch: the hook
// functions keep the same state the sketch does (params, presets in "flash",
// settings) with the same rules (clamping, busy while a sector is written).
// run-firmware-tests.mjs drives it with frames made by protocol.js.
#include "Arduino.h"
#include "TmeEditor.h"
#include <cstdio>
#include <string>

FakeUsbSerial SerialUSB;

static const int16_t PARAM_MAX[16] = { 240, 150, 96, 100, 98, 100, 100, 100, 0, 100, 100, 100, 100, 100, 100, 100 };
static const int16_t PARAM_DEFAULT[16] = { 120, 50, 48, 0, 98, 0, 50, 0, 0, 0, 42, 50, 42, 59, 50, 80 };
static int16_t param[4][16];
static uint8_t selVoice = 0, muteMask = 0;
static uint8_t settings[4] = { 0, 1, 2, 1 };
static bool flashOk = true;
static int busyPolls = 0;                 // a write keeps the flash busy for this many polls
static bool presetUsed[32];
static char presetName[32][5];
static int16_t presetParams[32][64];
static bool settingsPending = false, stateDirty = false;
static int lastReadoutVoice = -1, lastReadoutId = -1, boots = 0, toasts = 0;

uint8_t tmeHookFlags() { return (flashOk ? 1 : 0) | (busyPolls > 0 ? 2 : 0) | (settingsPending ? 4 : 0) | (stateDirty ? 8 : 0); }
void tmeHookGetSettings(uint8_t *s) { memcpy(s, settings, 4); }
void tmeHookSetSettings(const uint8_t *s) { memcpy(settings, s, 4); settingsPending = true; }
void tmeHookResetSettings() { const uint8_t d[4] = { 0, 1, 2, 1 }; tmeHookSetSettings(d); }
int16_t tmeHookParamMax(uint8_t id) { return id < 16 ? PARAM_MAX[id] : 0; }
int16_t tmeHookGetParam(uint8_t v, uint8_t id) { return param[v][id]; }
void tmeHookSetParam(uint8_t v, uint8_t id, int16_t x) { param[v][id] = x; }
void tmeHookSoundChanged(uint8_t v, uint8_t id, bool readout) { stateDirty = true; if (readout) { lastReadoutVoice = v; lastReadoutId = id; } }
uint8_t tmeHookSelVoice() { return selVoice; }
uint8_t tmeHookMuteMask() { return muteMask; }
void tmeHookSetVoices(uint8_t s, uint8_t m) { selVoice = s; muteMask = m; stateDirty = true; }
bool tmeHookPresetInfo(uint8_t slot, char *name) { if (!presetUsed[slot]) return false; memcpy(name, presetName[slot], 5); return true; }
static uint8_t check() { return !flashOk ? TME_NO_FLASH : busyPolls > 0 ? TME_BUSY : TME_OK; }
uint8_t tmeHookReadPreset(uint8_t slot, char *name, int16_t *p) {
  if (uint8_t r = check()) return r;
  if (!presetUsed[slot]) return TME_EMPTY;
  memcpy(name, presetName[slot], 5); memcpy(p, presetParams[slot], sizeof presetParams[slot]); return TME_OK;
}
uint8_t tmeHookLoadPreset(uint8_t slot) {
  if (uint8_t r = check()) return r;
  if (!presetUsed[slot]) return TME_EMPTY;
  for (int i = 0; i < 64; i++) param[i / 16][i % 16] = presetParams[slot][i];
  stateDirty = true; toasts++; return TME_OK;
}
uint8_t tmeHookWritePreset(uint8_t slot, const char *name, const int16_t *p) {
  if (uint8_t r = check()) return r;
  presetUsed[slot] = true; memcpy(presetName[slot], name, 5); memcpy(presetParams[slot], p, sizeof presetParams[slot]);
  busyPolls = 2; return TME_OK;
}
uint8_t tmeHookSavePreset(uint8_t slot, const char *name) {
  int16_t p[64];
  for (int i = 0; i < 64; i++) p[i] = param[i / 16][i % 16];
  uint8_t r = tmeHookWritePreset(slot, name, p);
  if (!r) toasts++;
  return r;
}
uint8_t tmeHookClearPreset(uint8_t slot) { if (uint8_t r = check()) return r; presetUsed[slot] = false; busyPolls = 2; return TME_OK; }
void tmeHookInitSound() { for (int v = 0; v < 4; v++) memcpy(param[v], PARAM_DEFAULT, sizeof PARAM_DEFAULT); stateDirty = true; }
void tmeHookVoices(uint8_t *gates, uint8_t *env, uint8_t *lfo) { *gates = 0x05; for (int v = 0; v < 4; v++) { env[v] = (uint8_t)(v * 40); lfo[v] = (uint8_t)(127 - v * 40); } }
void tmeHookBootloader() { boots++; }

int main() {
  for (int v = 0; v < 4; v++) memcpy(param[v], PARAM_DEFAULT, sizeof PARAM_DEFAULT);
  tme::Editor ed;
  ed.begin();
  char line[8192];
  while (fgets(line, sizeof line, stdin)) {
    std::string l(line);
    if (l.rfind("NOFLASH", 0) == 0) { flashOk = false; printf("ok\n"); fflush(stdout); continue; }
    if (l.rfind("NOTE", 0) == 0) { int c, n, v; sscanf(line + 5, "%d %d %d", &c, &n, &v); ed.noteIn(c, n, v); printf("ok\n"); fflush(stdout); continue; }
    if (l.rfind("STATE", 0) == 0) {
      printf("readout=%d,%d boots=%d toasts=%d busy=%d\n", lastReadoutVoice, lastReadoutId, boots, toasts, busyPolls); fflush(stdout); continue;
    }
    SerialUSB.in.clear(); SerialUSB.pos = 0; SerialUSB.out.clear();
    unsigned v; const char *p = line;
    int k; while (sscanf(p, "%x%n", &v, &k) == 1) { SerialUSB.in.push_back((uint8_t)v); p += k; }
    ed.poll();
    for (uint8_t b : SerialUSB.out) printf("%02x ", b);
    printf("|\n"); fflush(stdout);
    if (busyPolls > 0) busyPolls--;   // a write finishes over the next couple of frames
  }
}
