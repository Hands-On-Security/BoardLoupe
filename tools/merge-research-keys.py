#!/usr/bin/env python3
"""Build a local BoardScope keyfile from private format notes.

The output must stay outside version control. No key material is printed.
"""

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def schedule(text: str) -> str:
    match = re.search(r"^words:\s*```(?:text)?\s*\n(.*?)\n```", text, re.M | re.S | re.I)
    if not match:
        raise ValueError("missing words block")
    words = re.findall(r"(?i)\b(?:0x)?([0-9a-f]{8})\b", match.group(1))
    if len(words) != 44:
        raise ValueError(f"expected 44 words, found {len(words)}")
    return " ".join(words)


def metadata(text: str) -> str:
    text = re.sub(r"^words:\s*```(?:text)?\s*\n.*?\n```", "", text, flags=re.M | re.S | re.I)
    text = re.sub(r"(?im)^key_hex:.*$", "key_hex: [stored in keys]", text)
    # Avoid duplicating schedule values mentioned in prose.
    text = re.sub(r"(?i)\b(?:0x)?[0-9a-f]{8,}\b", "[key value]", text)
    return text.strip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("notes", type=Path, help="directory containing private *.key.md format notes")
    ap.add_argument("output", type=Path, help="ignored local *.keys.json output")
    args = ap.parse_args()
    if not args.output.name.endswith(".keys.json"):
        ap.error("output must end in .keys.json so .gitignore covers it")
    if args.output.exists():
        ap.error("output exists; remove it explicitly before regenerating")

    docs = {name: (args.notes / f"{name}.key.md").read_text() for name in ("fz", "cae", "xzz-pcb", "bdv-asc", "tvw")}
    xzz = re.search(r"(?im)^key_hex:\s*(?:0x)?([0-9a-f]{16})\s*$", docs["xzz-pcb"])
    if not xzz:
        raise ValueError("missing XZZ key_hex")
    output = {
        "boardscope_keystore": 1,
        "created": datetime.now(timezone.utc).isoformat(),
        "keys": [
            {"format": "fz", "key": schedule(docs["fz"])},
            {"format": "cae", "key": schedule(docs["cae"])},
            {"format": "xzz", "key": xzz.group(1)},
        ],
        "metadata": {name: metadata(text) for name, text in docs.items()},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n")
    args.output.chmod(0o600)
    print("Created local keyfile with 3 importable keys and 5 note sections.")


if __name__ == "__main__":
    main()
