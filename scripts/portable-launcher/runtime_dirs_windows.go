// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	windowsDriveRemovable = 2
	windowsDriveFixed     = 3
	windowsPreferredData  = `D:\SmartPerfettoData`
)

var getDriveTypeW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDriveTypeW")

func resolvePreferredWindowsDataRoot(fallback string) string {
	if preferredWindowsDataRootUsable(
		windowsPreferredData,
		windowsDriveType,
		probeWindowsDataRootWritable,
	) {
		return windowsPreferredData
	}
	return fallback
}

func preferredWindowsDataRootUsable(
	root string,
	driveType func(string) uint32,
	writable func(string) bool,
) bool {
	volume := filepath.VolumeName(root)
	if len(volume) != 2 || volume[1] != ':' {
		return false
	}
	driveRoot := volume + `\`
	return driveType(driveRoot) == windowsDriveFixed && writable(root)
}

func windowsDriveType(root string) uint32 {
	rootUTF16, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return 0
	}
	result, _, _ := getDriveTypeW.Call(uintptr(unsafe.Pointer(rootUTF16)))
	return uint32(result)
}

func probeWindowsDataRootWritable(root string) bool {
	if err := assertNoWindowsReparsePointAncestor(root); err != nil {
		return false
	}
	probeParent := root
	if info, err := os.Lstat(root); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
			return false
		}
	} else if os.IsNotExist(err) {
		probeParent = filepath.Dir(root)
	} else {
		return false
	}
	probeDir, err := os.MkdirTemp(probeParent, ".smartperfetto-write-probe-")
	if err != nil {
		return false
	}
	probeFile := filepath.Join(probeDir, "probe")
	writeErr := os.WriteFile(probeFile, []byte("probe"), 0o600)
	removeErr := os.RemoveAll(probeDir)
	return writeErr == nil && removeErr == nil
}
