#!/bin/sh
# Fetches the pinned OpenBoardView sources (MIT) used as the reference
# implementation for differential tests. Not shipped; only used by tests.
set -eu
cd "$(dirname "$0")"
OBV_COMMIT=cc76e697c85efd2285134dfe2df0b7809e4a49d0   # master, 2026-09-05
TVW_PR_COMMIT=de96645                                # OpenBoardView PR #366 (TVW reader, eagleview-derived)
if [ ! -d src-obv/.git ]; then
  git clone --quiet https://github.com/OpenBoardView/OpenBoardView.git src-obv
fi
cd src-obv
git fetch --quiet origin "$OBV_COMMIT" || true
git fetch --quiet origin pull/366/head:pr366
git checkout --quiet "$OBV_COMMIT"
git submodule update --init --depth 1 src/utf8 src/mpc src/filesystem >/dev/null
mkdir -p ../tvw
for f in TVWFile.cpp TVWFile.h tebo/Box2.hpp tebo/Common.hpp tebo/Fixed32.hpp tebo/StreamReader.hpp tebo/TeboBoard.cpp tebo/TeboBoard.hpp tebo/Vector2.hpp; do
  mkdir -p "../tvw/$(dirname "$f")"
  git show "$TVW_PR_COMMIT:src/openboardview/FileFormats/$f" > "../tvw/$f"
done
python3 utilities/generate_grammar_header.py src/openboardview/FileFormats/GenCADFileBnf.h ../include/build-generated/GenCADFileGrammar.h
echo "fetched OBV $OBV_COMMIT + TVW PR $TVW_PR_COMMIT"
