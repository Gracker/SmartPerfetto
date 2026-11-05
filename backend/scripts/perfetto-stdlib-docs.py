#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

"""Expose the pinned upstream website's full SQL docs as JSON."""

import importlib.util
import json
import os
from pathlib import Path
import sys


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
    docs = module._stdlib_docs(module.parse_all_modules(stdlib_root))
    output.write_text(json.dumps(docs), encoding="utf-8")


if __name__ == "__main__":
    main()
