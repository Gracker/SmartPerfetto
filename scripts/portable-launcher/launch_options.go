// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type launchOptions struct {
	migrateFrom      string
	nonInteractive   bool
	shutdownFile     string
	lifecycleReceipt string
}

func parseLaunchOptions(args []string) (launchOptions, error) {
	options := launchOptions{migrateFrom: os.Getenv("SMARTPERFETTO_MIGRATE_FROM")}
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--migrate-from":
			value, next, err := launcherOptionValue(args, index)
			if err != nil {
				return launchOptions{}, fmt.Errorf("--migrate-from requires an old package directory")
			}
			options.migrateFrom = value
			index = next
		case "--non-interactive":
			options.nonInteractive = true
		case "--shutdown-file":
			value, next, err := launcherOptionValue(args, index)
			if err != nil {
				return launchOptions{}, fmt.Errorf("--shutdown-file requires an absolute path")
			}
			if !filepath.IsAbs(value) {
				return launchOptions{}, fmt.Errorf("--shutdown-file requires an absolute path, got %q", value)
			}
			options.shutdownFile = filepath.Clean(value)
			index = next
		case "--lifecycle-receipt":
			value, next, err := launcherOptionValue(args, index)
			if err != nil {
				return launchOptions{}, fmt.Errorf("--lifecycle-receipt requires an absolute path")
			}
			if !filepath.IsAbs(value) {
				return launchOptions{}, fmt.Errorf("--lifecycle-receipt requires an absolute path, got %q", value)
			}
			options.lifecycleReceipt = filepath.Clean(value)
			index = next
		default:
			return launchOptions{}, fmt.Errorf("unknown launcher option %q", args[index])
		}
	}
	return options, nil
}

func launcherOptionValue(args []string, index int) (string, int, error) {
	if index+1 >= len(args) || strings.TrimSpace(args[index+1]) == "" {
		return "", index, fmt.Errorf("missing option value")
	}
	return args[index+1], index + 1, nil
}

func argumentsRequestNonInteractive(args []string) bool {
	for _, arg := range args {
		if arg == "--non-interactive" {
			return true
		}
	}
	return false
}

func validateLaunchControlPaths(options launchOptions) error {
	paths := []struct {
		flag  string
		value string
	}{
		{flag: "--shutdown-file", value: options.shutdownFile},
		{flag: "--lifecycle-receipt", value: options.lifecycleReceipt},
	}
	seen := make(map[string]string, len(paths))
	for _, controlPath := range paths {
		flag := controlPath.flag
		value := controlPath.value
		if value == "" {
			continue
		}
		if _, err := os.Lstat(value); err == nil {
			return fmt.Errorf("%s path must not already exist: %s", flag, value)
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect %s path %s: %w", flag, value, err)
		}
		parent := filepath.Dir(value)
		info, err := os.Stat(parent)
		if err != nil {
			return fmt.Errorf("%s parent directory is not accessible: %s: %w", flag, parent, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("%s parent is not a directory: %s", flag, parent)
		}
		resolvedParent, err := filepath.EvalSymlinks(parent)
		if err != nil {
			return fmt.Errorf("resolve %s parent directory %s: %w", flag, parent, err)
		}
		canonical := filepath.Join(resolvedParent, filepath.Base(value))
		if runtime.GOOS == "windows" {
			canonical = strings.ToLower(canonical)
		}
		if previousFlag, exists := seen[canonical]; exists {
			return fmt.Errorf("%s and %s must use distinct paths", previousFlag, flag)
		}
		seen[canonical] = flag
	}
	return nil
}
