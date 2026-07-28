// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build windows

package main

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

func snapshotProcesses() ([]processEntry, error) {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer func() {
		if snapshot != syscall.InvalidHandle {
			_ = syscall.CloseHandle(snapshot)
		}
	}()

	var current syscall.ProcessEntry32
	current.Size = uint32(unsafe.Sizeof(current))
	if err := syscall.Process32First(snapshot, &current); err != nil {
		return nil, fmt.Errorf("Process32First: %w", err)
	}

	entries := make([]processEntry, 0, 256)
	for {
		if len(entries) >= maxSnapshotEntries {
			return nil, fmt.Errorf(
				"process snapshot exceeded %d entries",
				maxSnapshotEntries,
			)
		}
		entries = append(entries, processEntry{
			processID:       current.ProcessID,
			parentProcessID: current.ParentProcessID,
		})

		err := syscall.Process32Next(snapshot, &current)
		if err == nil {
			continue
		}
		if errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
			break
		}
		return nil, fmt.Errorf("Process32Next: %w", err)
	}

	if err := syscall.CloseHandle(snapshot); err != nil {
		return nil, fmt.Errorf("CloseHandle(process snapshot): %w", err)
	}
	snapshot = syscall.InvalidHandle
	return entries, nil
}
