#!/bin/sh
# Compiles firmware-src/4-tme-fw/TmeEditor.h for this computer, with a
# stand-in for the sketch's hooks and the USB serial faked, then runs it
# against protocol.js. Needs g++ (no Daisy libraries).
set -e
cd "$(dirname "$0")"
g++ -std=gnu++17 -Wall -Wextra -Werror -Wno-unused-parameter -Istub -I../../firmware-src/4-tme-fw harness.cpp -o harness
node run-firmware-tests.mjs
