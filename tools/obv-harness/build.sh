#!/bin/sh
# Builds tools/obv-harness/build/obv-harness from the pinned OBV sources.
set -eu
cd "$(dirname "$0")"
[ -d src-obv ] || ./fetch.sh
S=src-obv/src/openboardview
mkdir -p build
cc -O1 -w -c "$S"/Crypto/des.c -o build/des.o
cc -O1 -w -c src-obv/src/mpc/mpc.c -o build/mpc.o
c++ -std=c++17 -O1 -w -DWITH_STD_FILESYSTEM \
  -Iinclude -Iinclude/build-generated -I"$S" -I"$S/FileFormats" -Isrc-obv/src -Isrc-obv/src/filesystem/include -Itvw -Itvw/tebo \
  harness.cpp \
  "$S"/FileFormats/BRDFileBase.cpp "$S"/FileFormats/BRDFile.cpp "$S"/FileFormats/BRD2File.cpp "$S"/FileFormats/BDVFile.cpp \
  "$S"/FileFormats/ASCFile.cpp "$S"/FileFormats/BVRFile.cpp "$S"/FileFormats/BVR3File.cpp "$S"/FileFormats/CADFile.cpp \
  "$S"/FileFormats/CSTFile.cpp "$S"/FileFormats/FZFile.cpp "$S"/FileFormats/CAEFile.cpp "$S"/FileFormats/XZZPCBFile.cpp \
  "$S"/FileFormats/GenCADFile.cpp "$S"/utils.cpp tvw/TVWFile.cpp tvw/tebo/TeboBoard.cpp \
  build/des.o build/mpc.o \
  -lz -o build/obv-harness
echo "built tools/obv-harness/build/obv-harness"
