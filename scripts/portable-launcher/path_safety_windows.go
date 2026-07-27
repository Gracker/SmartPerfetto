// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build windows

package main

import (
	"os"
	"syscall"
)

const fileAttributeReparsePoint = 0x400

func isReparsePoint(info os.FileInfo) bool {
	attributes, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok || attributes == nil {
		return true
	}
	return attributes.FileAttributes&fileAttributeReparsePoint != 0
}
