// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

func TestMigrateLegacyBackendSecretStoreData(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	oldPackage := filepath.Join(root, "smartperfetto-v1.4.0-windows-x64")
	oldBackendData := filepath.Join(oldPackage, "backend", "data")
	oldSecrets := filepath.Join(oldPackage, "backend", "data", "secrets")
	if err := os.MkdirAll(oldSecrets, 0o755); err != nil {
		t.Fatal(err)
	}
	legacyFiles := map[string]string{
		"provider-secrets.enc.json": "encrypted-provider-state",
		".master-key.dpapi":         "dpapi-protected-master-key",
	}
	for name, content := range legacyFiles {
		if err := os.WriteFile(filepath.Join(oldSecrets, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(
		filepath.Join(oldBackendData, "providers.json"),
		[]byte("legacy-provider-state"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "LocalAppData", "SmartPerfetto")

	if err := migrateLegacyData(
		filepath.Join(root, "smartperfetto-v1.5.0-windows-x64"),
		destination,
		launchOptions{},
	); err != nil {
		t.Fatalf("migrate legacy backend SecretStore data: %v", err)
	}

	for name, want := range legacyFiles {
		copied, err := os.ReadFile(filepath.Join(destination, "providers", "secrets", name))
		if err != nil || string(copied) != want {
			t.Fatalf("copied legacy SecretStore file %s mismatch: %q, %v", name, copied, err)
		}
		if _, err := os.Stat(filepath.Join(oldSecrets, name)); err != nil {
			t.Fatalf("legacy SecretStore source %s was not preserved: %v", name, err)
		}
	}
	providerState, err := os.ReadFile(filepath.Join(destination, "providers", "providers.json"))
	if err != nil || string(providerState) != "legacy-provider-state" {
		t.Fatalf("copied legacy Provider state mismatch: %q, %v", providerState, err)
	}
}

func TestMigrateLegacyDataIgnoresCurrentPackageStaticBackendData(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	current := filepath.Join(root, "smartperfetto-v1.5.0-windows-x64")
	if err := os.MkdirAll(filepath.Join(current, "backend", "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(current, "backend", "data", "perfetto-sql-index.json"),
		[]byte("tracked package payload"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	oldData := filepath.Join(root, "smartperfetto-v1.4.0-windows-x64", "data")
	if err := os.MkdirAll(filepath.Join(oldData, "providers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(oldData, "providers", "providers.json"),
		[]byte("real legacy state"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "LocalAppData", "SmartPerfetto")

	if err := migrateLegacyData(current, destination, launchOptions{}); err != nil {
		t.Fatalf("migrate legacy sibling data: %v", err)
	}
	copied, err := os.ReadFile(filepath.Join(destination, "providers", "providers.json"))
	if err != nil || string(copied) != "real legacy state" {
		t.Fatalf("automatic discovery selected package payload instead of legacy state: %q, %v", copied, err)
	}
	if _, err := os.Stat(filepath.Join(destination, "perfetto-sql-index.json")); !os.IsNotExist(err) {
		t.Fatalf("current package static backend data must not be migrated: %v", err)
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

func TestMigrateLegacyDataRejectsExplicitMigrationToExistingDestination(t *testing.T) {
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
	); err == nil {
		t.Fatal("explicit migration to an existing destination should fail")
	}
	content, err := os.ReadFile(marker)
	if err != nil || string(content) != "current" {
		t.Fatalf("existing destination was changed: %q, %v", content, err)
	}
	sourceContent, err := os.ReadFile(filepath.Join(source, "provider.json"))
	if err != nil || string(sourceContent) != "old" {
		t.Fatalf("migration source was changed: %q, %v", sourceContent, err)
	}
}

func TestMigrateLegacyDataRejectsSourceContainingDestinationAndStage(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	source := filepath.Join(root, "LocalAppData")
	destination := filepath.Join(source, "SmartPerfetto")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(source, "existing-user-data.json")
	if err := os.WriteFile(marker, []byte("preserved"), 0o600); err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(
		filepath.Dir(destination),
		fmt.Sprintf(".SmartPerfetto-migration-%d", os.Getpid()),
	)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		t.Fatal(err)
	}

	err := migrateLegacyData(
		filepath.Join(root, "current"),
		destination,
		launchOptions{migrateFrom: source},
	)
	if err == nil || !strings.Contains(err.Error(), "must not overlap") {
		t.Fatalf("expected overlap rejection before walking source, got: %v", err)
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("destination should not have been created: %v", err)
	}
	content, err := os.ReadFile(marker)
	if err != nil || string(content) != "preserved" {
		t.Fatalf("migration source was changed: %q, %v", content, err)
	}
}

func TestMigrateLegacyDataRejectsDestinationAliasInsideSource(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	source := filepath.Join(root, "real-data")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "local-app-data-alias")
	if err := os.Symlink(source, alias); err != nil {
		t.Skipf("directory symlinks unavailable: %v", err)
	}
	destination := filepath.Join(alias, "SmartPerfetto")
	stage := filepath.Join(
		filepath.Dir(destination),
		fmt.Sprintf(".SmartPerfetto-migration-%d", os.Getpid()),
	)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		t.Fatal(err)
	}

	err := migrateLegacyData(
		filepath.Join(root, "current"),
		destination,
		launchOptions{migrateFrom: source},
	)
	if err == nil || !strings.Contains(err.Error(), "must not overlap") {
		t.Fatalf("expected physical alias overlap rejection, got: %v", err)
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("destination should not have been created: %v", err)
	}
}

func TestMigrationTargetRelativePathHandlesWindowsLayoutCaseInsensitively(t *testing.T) {
	source := filepath.Join(t.TempDir(), "BACKEND", "DATA")
	for relative, want := range map[string]string{
		"PROVIDERS.JSON":                     filepath.Join("providers", "PROVIDERS.JSON"),
		filepath.Join("Secrets", "key.json"): filepath.Join("providers", "Secrets", "key.json"),
	} {
		if got := migrationTargetRelativePath(source, relative); got != want {
			t.Fatalf("migration target for %q: got %q, want %q", relative, got, want)
		}
	}
}

func TestMigrateLegacyDataKeepsExistingDestinationDuringAutomaticDiscovery(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	current := filepath.Join(root, "smartperfetto-v1.3.0-windows-x64")
	if err := os.MkdirAll(filepath.Join(current, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "existing-data")
	if err := os.MkdirAll(destination, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(destination, "provider.json")
	if err := os.WriteFile(marker, []byte("current"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyData(current, destination, launchOptions{}); err != nil {
		t.Fatalf("automatic migration should preserve an existing destination: %v", err)
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
		launchOptions{},
	); err != nil {
		t.Fatalf("portable override should bypass migration: %v", err)
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("migration should not create the default destination: %v", err)
	}
}

func TestMigrateLegacyDataRejectsExplicitSourceWithPortableOverride(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", filepath.Join(t.TempDir(), "portable"))
	root := t.TempDir()
	destination := filepath.Join(root, "destination")
	if err := migrateLegacyData(
		filepath.Join(root, "current"),
		destination,
		launchOptions{migrateFrom: filepath.Join(root, "old")},
	); err == nil {
		t.Fatal("explicit migration with a portable override should fail")
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

func TestFindMigrationSourceDoesNotImportFromSameOrNewerVersion(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{
		"smartperfetto-v1.8.0-windows-x64",
		"smartperfetto-v1.10.0-windows-x64",
	} {
		if err := os.MkdirAll(filepath.Join(root, name, "data"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	current := filepath.Join(root, "smartperfetto-v1.9.0-windows-x64")
	source, explicit, err := findMigrationSource(current, "")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "smartperfetto-v1.8.0-windows-x64", "data")
	if source != want || explicit {
		t.Fatalf("unexpected downgrade-safe migration source: %q, explicit=%v", source, explicit)
	}
}

func TestFindMigrationSourceReturnsNoneWhenOnlyNewerVersionsExist(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(root, "smartperfetto-v1.10.0-windows-x64", "data"),
		0o755,
	); err != nil {
		t.Fatal(err)
	}
	current := filepath.Join(root, "smartperfetto-v1.9.0-windows-x64")
	source, explicit, err := findMigrationSource(current, "")
	if err != nil {
		t.Fatal(err)
	}
	if source != "" || explicit {
		t.Fatalf("newer siblings must not be auto-migrated: %q, explicit=%v", source, explicit)
	}
}

func TestFindMigrationSourceSkipsSiblingDiscoveryForUnversionedPackage(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(root, "smartperfetto-v1.8.0-windows-x64", "data"),
		0o755,
	); err != nil {
		t.Fatal(err)
	}
	source, explicit, err := findMigrationSource(filepath.Join(root, "current"), "")
	if err != nil {
		t.Fatal(err)
	}
	if source != "" || explicit {
		t.Fatalf("unversioned package should not auto-migrate a sibling: %q, explicit=%v", source, explicit)
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
