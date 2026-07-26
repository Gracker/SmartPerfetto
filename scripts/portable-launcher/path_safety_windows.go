// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

const fileAttributeReparsePoint = 0x400

func isReparsePoint(path string) bool {
	pathPointer, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return true
	}
	attributes, _, _ := syscall.NewLazyDLL("kernel32.dll").
		NewProc("GetFileAttributesW").
		Call(uintptr(unsafe.Pointer(pathPointer)))
	return attributes != ^uintptr(0) && attributes&fileAttributeReparsePoint != 0
}
