// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build windows

package main

import (
	"os"
	"testing"
)

func TestSnapshotProcessesContainsCurrentProcess(t *testing.T) {
	entries, err := snapshotProcesses()
	if err != nil {
		t.Fatalf("snapshot processes: %v", err)
	}

	currentProcessID := uint32(os.Getpid())
	for _, entry := range entries {
		if entry.processID == currentProcessID {
			return
		}
	}
	t.Fatalf("snapshot did not contain current process %d", currentProcessID)
}
