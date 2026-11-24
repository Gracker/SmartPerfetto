#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

"""Expose the pinned upstream website's full SQL docs as JSON."""

import importlib.util
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys


def build_pfsql(perfetto_root):
    # Match the upstream website generator's standalone host build.
    out = perfetto_root / ".pfsql-docs"
    subprocess.run([sys.executable, "tools/install-build-deps", "--no-dev-tools"],
                   cwd=perfetto_root, check=True)
    subprocess.run([sys.executable, "tools/gn", "gen", str(out),
                    "--args=is_debug=false"], cwd=perfetto_root, check=True)
    subprocess.run([sys.executable, "tools/ninja", "-C", str(out), "pfsql"],
                   cwd=perfetto_root, check=True)
    return str(out / ("pfsql.exe" if os.name == "nt" else "pfsql"))


def main():
    perfetto_root, input_list, output = map(Path, sys.argv[1:])
    sys.path.insert(0, str(perfetto_root))
    source = perfetto_root / "infra/perfetto.dev/src/gen_stdlib_docs_md.py"
    spec = importlib.util.spec_from_file_location("perfetto_full_docs", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sql_files = input_list.read_text(encoding="utf-8").splitlines()
    stdlib_root = os.path.commonpath(sql_files)
    # Reuse the upstream formatter before its Markdown-only prelude merging.
    parse_modules = module.parse_all_modules
    kwargs = {}
    if "pfsql_binary" in inspect.signature(parse_modules).parameters:
        kwargs["pfsql_binary"] = build_pfsql(perfetto_root)
    docs = module._stdlib_docs(parse_modules(stdlib_root, **kwargs))
    output.write_text(json.dumps(docs), encoding="utf-8")


if __name__ == "__main__":
    main()
