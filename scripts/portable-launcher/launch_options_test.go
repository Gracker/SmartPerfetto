// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseLaunchOptionsSupportsAutomationContract(t *testing.T) {
	root := t.TempDir()
	shutdownFile := filepath.Join(root, "shutdown")
	receipt := filepath.Join(root, "receipt.json")

	options, err := parseLaunchOptions([]string{
		"--non-interactive",
		"--shutdown-file", shutdownFile,
		"--lifecycle-receipt", receipt,
		"--migrate-from", "old-package",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !options.nonInteractive ||
		options.shutdownFile != shutdownFile ||
		options.lifecycleReceipt != receipt ||
		options.migrateFrom != "old-package" {
		t.Fatalf("unexpected launcher options: %#v", options)
	}
}

func TestParseLaunchOptionsRejectsRelativeAutomationPaths(t *testing.T) {
	for _, args := range [][]string{
		{"--shutdown-file", "relative"},
		{"--lifecycle-receipt", "relative.json"},
	} {
		if _, err := parseLaunchOptions(args); err == nil {
			t.Fatalf("expected relative path to fail: %#v", args)
		}
	}
}

func TestValidateLaunchControlPathsRequiresFreshPaths(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, "existing")
	if err := os.WriteFile(existing, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateLaunchControlPaths(launchOptions{shutdownFile: existing}); err == nil {
		t.Fatal("existing shutdown path should be rejected")
	}
	if err := validateLaunchControlPaths(launchOptions{
		shutdownFile:     filepath.Join(root, "shutdown"),
		lifecycleReceipt: filepath.Join(root, "receipt.json"),
	}); err != nil {
		t.Fatalf("fresh control paths should be accepted: %v", err)
	}
	samePath := filepath.Join(root, "same")
	if err := validateLaunchControlPaths(launchOptions{
		shutdownFile:     samePath,
		lifecycleReceipt: samePath,
	}); err == nil {
		t.Fatal("shutdown and lifecycle receipt paths must be distinct")
	}
}

func TestArgumentsRequestNonInteractiveBeforeFullParse(t *testing.T) {
	if !argumentsRequestNonInteractive([]string{"--unknown", "--non-interactive"}) {
		t.Fatal("non-interactive mode should be detected before parse errors are reported")
	}
}
