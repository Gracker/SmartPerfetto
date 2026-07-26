// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveWindowsRuntimeDirsUsesLocalAppData(t *testing.T) {
	env := map[string]string{"LOCALAPPDATA": filepath.Join("C:", "Users", "tester", "AppData", "Local")}
	dirs, err := resolveRuntimeDirsForOS(
		"windows",
		filepath.Join("D:", "SmartPerfetto"),
		func(key string) string { return env[key] },
		"",
		errors.New("no home"),
	)
	if err != nil {
		t.Fatalf("resolve runtime directories: %v", err)
	}
	want := filepath.Join(env["LOCALAPPDATA"], "SmartPerfetto")
	if dirs.dataDir != want || dirs.logsDir != filepath.Join(want, "logs") {
		t.Fatalf("unexpected Windows runtime directories: %#v", dirs)
	}
}

func TestResolveTruePortableRuntimeDirsStaysInsidePackage(t *testing.T) {
	root := t.TempDir()
	dirs, err := resolveRuntimeDirsForOS(
		"windows",
		root,
		func(key string) string {
			if key == "SMARTPERFETTO_PORTABLE_MODE" {
				return "1"
			}
			return ""
		},
		"",
		errors.New("no home"),
	)
	if err != nil {
		t.Fatalf("resolve runtime directories: %v", err)
	}
	if dirs.dataDir != filepath.Join(root, "data") ||
		dirs.logsDir != filepath.Join(root, "logs") {
		t.Fatalf("unexpected true-portable directories: %#v", dirs)
	}
}

func TestMigrateLegacyDataCopiesAtomicallyAndPreservesSource(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	oldPackage := filepath.Join(root, "smartperfetto-v1.2.2-windows-x64")
	oldData := filepath.Join(oldPackage, "data")
	if err := os.MkdirAll(filepath.Join(oldData, "providers"), 0o755); err != nil {
		t.Fatal(err)
	}
	oldFile := filepath.Join(oldData, "providers", "profiles.json")
	if err := os.WriteFile(oldFile, []byte("preserved"), 0o600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "LocalAppData", "SmartPerfetto")

	if err := migrateLegacyData(
		filepath.Join(root, "smartperfetto-v1.3.0-windows-x64"),
		destination,
		launchOptions{migrateFrom: oldPackage},
	); err != nil {
		t.Fatalf("migrate legacy data: %v", err)
	}

	copied, err := os.ReadFile(filepath.Join(destination, "providers", "profiles.json"))
	if err != nil || string(copied) != "preserved" {
		t.Fatalf("copied data mismatch: %q, %v", copied, err)
	}
	if _, err := os.Stat(filepath.Join(destination, ".migration-receipt.json")); err != nil {
		t.Fatalf("migration receipt missing: %v", err)
	}
	if _, err := os.Stat(oldFile); err != nil {
		t.Fatalf("source data was not preserved: %v", err)
	}
}

func TestMigrateLegacyDataRejectsSymlinkContent(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	source := filepath.Join(root, "old-data")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(source, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	destination := filepath.Join(root, "new-data")
	if err := migrateLegacyData(
		filepath.Join(root, "current"),
		destination,
		launchOptions{migrateFrom: source},
	); err == nil {
		t.Fatal("expected migration with a symlink to fail")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("destination should not have been activated: %v", err)
	}
}

func TestMigrateLegacyDataDoesNotOverwriteExistingDestination(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	source := filepath.Join(root, "old-data")
	destination := filepath.Join(root, "existing-data")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(source, "provider.json"),
		[]byte("old"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(destination, "provider.json")
	if err := os.WriteFile(marker, []byte("current"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyData(
		filepath.Join(root, "current"),
		destination,
		launchOptions{migrateFrom: source},
	); err != nil {
		t.Fatalf("existing destination should be preserved: %v", err)
	}
	content, err := os.ReadFile(marker)
	if err != nil || string(content) != "current" {
		t.Fatalf("existing destination was changed: %q, %v", content, err)
	}
}

func TestMigrateLegacyDataPortableOverrideBypassesMigration(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", filepath.Join(t.TempDir(), "portable"))
	root := t.TempDir()
	destination := filepath.Join(root, "destination")
	if err := migrateLegacyData(
		filepath.Join(root, "current"),
		destination,
		launchOptions{migrateFrom: filepath.Join(root, "missing")},
	); err != nil {
		t.Fatalf("portable override should bypass migration: %v", err)
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("migration should not create the default destination: %v", err)
	}
}

func TestFindMigrationSourceSelectsHighestSemanticVersion(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{
		"smartperfetto-v1.9.0-windows-x64",
		"smartperfetto-v1.10.0-windows-x64",
		"smartperfetto-v2.0.0-macos-arm64",
		"unrelated",
	} {
		if err := os.MkdirAll(filepath.Join(root, name, "data"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	current := filepath.Join(root, "smartperfetto-v1.11.0-windows-x64")
	source, explicit, err := findMigrationSource(current, "")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "smartperfetto-v1.10.0-windows-x64", "data")
	if source != want || explicit {
		t.Fatalf("unexpected automatic migration source: %q, explicit=%v", source, explicit)
	}
}

func TestParseLaunchOptionsRequiresExplicitMigrationSource(t *testing.T) {
	t.Setenv("SMARTPERFETTO_MIGRATE_FROM", "")
	if _, err := parseLaunchOptions([]string{"--migrate-from"}); err == nil {
		t.Fatal("missing --migrate-from value should fail")
	}
	options, err := parseLaunchOptions([]string{"--migrate-from", "old-package"})
	if err != nil || options.migrateFrom != "old-package" {
		t.Fatalf("unexpected parsed migration source: %#v, %v", options, err)
	}
}
