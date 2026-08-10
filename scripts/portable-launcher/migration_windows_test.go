// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMigrateLegacyDataRejectsDestinationJunctionInsideSource(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	source := filepath.Join(root, "real-data")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(root, "local-app-data-junction")
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", junction, source).CombinedOutput(); err != nil {
		t.Skipf("directory junctions unavailable: %v (%s)", err, strings.TrimSpace(string(output)))
	}
	destination := filepath.Join(junction, "SmartPerfetto")

	err := migrateLegacyData(
		filepath.Join(root, "current"),
		destination,
		launchOptions{migrateFrom: source},
	)
	if err == nil || !strings.Contains(err.Error(), "reparse-point aliases") {
		t.Fatalf("expected junction ancestor rejection, got: %v", err)
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("destination should not have been created: %v", err)
	}
}
