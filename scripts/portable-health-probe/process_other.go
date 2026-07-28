// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build !windows

package main

import "errors"

func snapshotProcesses() ([]processEntry, error) {
	return nil, errors.New("process snapshots are supported only on Windows")
}
