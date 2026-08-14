// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build windows

package main

import "testing"

func TestPreferredWindowsDataRootRequiresFixedWritableDrive(t *testing.T) {
	root := `D:\SmartPerfettoData`
	writableCalls := 0
	if !preferredWindowsDataRootUsable(
		root,
		func(driveRoot string) uint32 {
			if driveRoot != `D:\` {
				t.Fatalf("unexpected drive root: %q", driveRoot)
			}
			return windowsDriveFixed
		},
		func(target string) bool {
			writableCalls++
			return target == root
		},
	) {
		t.Fatal("fixed writable D drive should be preferred")
	}
	if writableCalls != 1 {
		t.Fatalf("unexpected writable probe count: %d", writableCalls)
	}
}

func TestPreferredWindowsDataRootRejectsRemovableDriveBeforeWriteProbe(t *testing.T) {
	writableCalls := 0
	if preferredWindowsDataRootUsable(
		`D:\SmartPerfettoData`,
		func(string) uint32 { return windowsDriveRemovable },
		func(string) bool {
			writableCalls++
			return true
		},
	) {
		t.Fatal("removable D drive must not be selected automatically")
	}
	if writableCalls != 0 {
		t.Fatalf("removable drive should not be probed for writes: %d", writableCalls)
	}
}

func TestPreferredWindowsDataRootRejectsUnwritableFixedDrive(t *testing.T) {
	if preferredWindowsDataRootUsable(
		`D:\SmartPerfettoData`,
		func(string) uint32 { return windowsDriveFixed },
		func(string) bool { return false },
	) {
		t.Fatal("unwritable fixed D drive must not be selected automatically")
	}
}
