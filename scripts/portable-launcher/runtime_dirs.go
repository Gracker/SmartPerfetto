// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func resolveRuntimeDirs(packageRoot string) (runtimeDirs, error) {
	home, homeErr := os.UserHomeDir()
	return resolveRuntimeDirsForOS(runtime.GOOS, packageRoot, os.Getenv, home, homeErr)
}

func resolveRuntimeDirsForOS(
	goos string,
	packageRoot string,
	getenv func(string) string,
	home string,
	homeErr error,
) (runtimeDirs, error) {
	if data := getenv("SMARTPERFETTO_PORTABLE_DATA_DIR"); data != "" {
		logs := getenv("SMARTPERFETTO_PORTABLE_LOG_DIR")
		if logs == "" {
			logs = filepath.Join(data, "logs")
		}
		return runtimeDirs{dataDir: data, logsDir: logs}, nil
	}
	if getenv("SMARTPERFETTO_PORTABLE_MODE") == "1" {
		return runtimeDirs{
			dataDir: filepath.Join(packageRoot, "data"),
			logsDir: filepath.Join(packageRoot, "logs"),
		}, nil
	}
	if homeErr != nil && goos != "windows" {
		return runtimeDirs{}, homeErr
	}

	switch goos {
	case "windows":
		localAppData := getenv("LOCALAPPDATA")
		if localAppData == "" {
			if homeErr != nil || home == "" {
				return runtimeDirs{}, fmt.Errorf("LOCALAPPDATA and the user home directory are unavailable")
			}
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		data := filepath.Join(localAppData, "SmartPerfetto")
		return runtimeDirs{dataDir: data, logsDir: filepath.Join(data, "logs")}, nil
	case "darwin":
		return runtimeDirs{
			dataDir: filepath.Join(home, "Library", "Application Support", "SmartPerfetto"),
			logsDir: filepath.Join(home, "Library", "Logs", "SmartPerfetto"),
		}, nil
	default:
		dataHome := getenv("XDG_DATA_HOME")
		if dataHome == "" {
			dataHome = filepath.Join(home, ".local", "share")
		}
		stateHome := getenv("XDG_STATE_HOME")
		if stateHome == "" {
			stateHome = filepath.Join(home, ".local", "state")
		}
		return runtimeDirs{
			dataDir: filepath.Join(dataHome, "smartperfetto"),
			logsDir: filepath.Join(stateHome, "smartperfetto", "logs"),
		}, nil
	}
}
