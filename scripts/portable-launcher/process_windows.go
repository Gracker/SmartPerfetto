// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

func configureServiceCommand(cmd *exec.Cmd) {}

func forceStopService(proc *serviceProcess) error {
	if proc == nil || proc.cmd == nil || proc.cmd.Process == nil {
		return nil
	}
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		systemRoot = os.Getenv("WINDIR")
	}
	if systemRoot == "" || !filepath.IsAbs(systemRoot) {
		return fmt.Errorf("SystemRoot is required to locate taskkill.exe")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	taskkill := filepath.Join(systemRoot, "System32", "taskkill.exe")
	return exec.CommandContext(
		ctx,
		taskkill,
		"/T",
		"/F",
		"/PID",
		strconv.Itoa(proc.cmd.Process.Pid),
	).Run()
}
