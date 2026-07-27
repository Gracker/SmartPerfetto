#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2024-2026 Gracker (Chris)
# This file is part of SmartPerfetto. See LICENSE for details.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <output-root> <package-name> <archive-path>" >&2
  exit 2
fi

output_root="$1"
package_name="$2"
archive_path="$3"

if [ ! -d "$output_root" ]; then
  echo "ERROR: portable archive output root does not exist: $output_root" >&2
  exit 1
fi
if [ "$package_name" = "." ] || [ "$package_name" = ".." ] ||
  [ "$(basename "$package_name")" != "$package_name" ] ||
  [ ! -d "$output_root/$package_name" ]; then
  echo "ERROR: portable archive package name is invalid: $package_name" >&2
  exit 1
fi
if [ -d "$archive_path" ]; then
  echo "ERROR: portable archive path is a directory: $archive_path" >&2
  exit 1
fi
archive_parent="$(dirname "$archive_path")"
if [ ! -d "$archive_parent" ]; then
  echo "ERROR: portable archive parent does not exist: $archive_parent" >&2
  exit 1
fi
archive_path="$(cd "$archive_parent" && pwd -P)/$(basename "$archive_path")"

(
  cd "$output_root"
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive_path" -- "$package_name"
)
