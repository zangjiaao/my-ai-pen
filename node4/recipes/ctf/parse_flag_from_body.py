#!/usr/bin/env python3
"""Extract flag{...} candidates from a text file (stdin or path). No network."""
import re
import sys

def main() -> None:
    if len(sys.argv) > 1:
        data = open(sys.argv[1], "r", errors="replace").read()
    else:
        data = sys.stdin.read()
    flags = sorted(set(re.findall(r"flag\{[A-Za-z0-9_\-]{4,}\}", data)))
    for f in flags:
        print(f)
    print(f"# count={len(flags)}", file=sys.stderr)

if __name__ == "__main__":
    main()
