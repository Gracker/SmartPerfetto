// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveWindowsRuntimeDirsPrefersReadyDDrive(t *testing.T) {
	fallback := filepath.Join("C:", "Users", "tester", "AppData", "Local", "SmartPerfetto")
	preferred := filepath.Join("D:", "SmartPerfettoData")
	dirs, err := resolveRuntimeDirsForOSWithWindowsPreference(
		"windows",
		filepath.Join("C:", "Apps", "SmartPerfetto"),
		func(key string) string {
			if key == "LOCALAPPDATA" {
				return filepath.Dir(fallback)
			}
			return ""
		},
		"",
		errors.New("no home"),
		func(gotFallback string) string {
			if gotFallback != fallback {
				t.Fatalf("unexpected Windows fallback root: %q", gotFallback)
			}
			return preferred
		},
	)
	if err != nil {
		t.Fatalf("resolve preferred Windows runtime directories: %v", err)
	}
	if dirs.dataDir != preferred || dirs.logsDir != filepath.Join(preferred, "logs") {
		t.Fatalf("unexpected preferred Windows runtime directories: %#v", dirs)
	}
}

func TestResolveWindowsRuntimeDirsKeepsExplicitPortableDataOverride(t *testing.T) {
	explicit := filepath.Join("E:", "UserSelectedData")
	preferenceCalls := 0
	dirs, err := resolveRuntimeDirsForOSWithWindowsPreference(
		"windows",
		filepath.Join("C:", "Apps", "SmartPerfetto"),
		func(key string) string {
			if key == "SMARTPERFETTO_PORTABLE_DATA_DIR" {
				return explicit
			}
			return ""
		},
		"",
		errors.New("no home"),
		func(fallback string) string {
			preferenceCalls++
			return filepath.Join("D:", "SmartPerfettoData")
		},
	)
	if err != nil {
		t.Fatalf("resolve explicit Windows runtime directories: %v", err)
	}
	if preferenceCalls != 0 {
		t.Fatalf("Windows default preference should not run for an explicit override: %d", preferenceCalls)
	}
	if dirs.dataDir != explicit || dirs.logsDir != filepath.Join(explicit, "logs") {
		t.Fatalf("unexpected explicit Windows runtime directories: %#v", dirs)
	}
}

func TestResolveWindowsRuntimeDirsUsesLocalAppData(t *testing.T) {
	env := map[string]string{"LOCALAPPDATA": filepath.Join("C:", "Users", "tester", "AppData", "Local")}
	dirs, err := resolveRuntimeDirsForOSWithWindowsPreference(
		"windows",
		filepath.Join("D:", "SmartPerfetto"),
		func(key string) string { return env[key] },
		"",
		errors.New("no home"),
		func(fallback string) string { return fallback },
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

func TestPreparePreferredWindowsRuntimeDirsMigratesLocalAppDataToD(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	fallback := filepath.Join(root, "LocalAppData", "SmartPerfetto")
	preferred := filepath.Join(root, "D-drive", "SmartPerfettoData")
	oldFile := filepath.Join(fallback, "providers", "profiles.json")
	if err := os.MkdirAll(filepath.Dir(oldFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(oldFile, []byte("preserved-c-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	dirs := runtimeDirs{dataDir: preferred, logsDir: filepath.Join(preferred, "logs")}

	resolved, err := preparePreferredWindowsRuntimeDirs(
		filepath.Join(root, "current-package"),
		dirs,
		fallback,
		launchOptions{},
		&bytes.Buffer{},
	)
	if err != nil {
		t.Fatalf("prepare preferred Windows data root: %v", err)
	}
	if resolved != dirs {
		t.Fatalf("unexpected resolved runtime directories: %#v", resolved)
	}
	copied, err := os.ReadFile(filepath.Join(preferred, "providers", "profiles.json"))
	if err != nil || string(copied) != "preserved-c-data" {
		t.Fatalf("copied C data mismatch: %q, %v", copied, err)
	}
	receipt, err := os.ReadFile(filepath.Join(preferred, ".migration-receipt.json"))
	if err != nil || !strings.Contains(string(receipt), fallback) {
		t.Fatalf("migration receipt does not bind the C source: %q, %v", receipt, err)
	}
	if _, err := os.Stat(oldFile); err != nil {
		t.Fatalf("C source data was not preserved: %v", err)
	}
}

func TestPreparePreferredWindowsRuntimeDirsMigratesIntoExistingEmptyDDirectory(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	fallback := filepath.Join(root, "LocalAppData", "SmartPerfetto")
	preferred := filepath.Join(root, "D-drive", "SmartPerfettoData")
	if err := os.MkdirAll(fallback, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fallback, "session.json"), []byte("c-session"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(preferred, 0o755); err != nil {
		t.Fatal(err)
	}
	dirs := runtimeDirs{dataDir: preferred, logsDir: filepath.Join(preferred, "logs")}

	resolved, err := preparePreferredWindowsRuntimeDirs(
		filepath.Join(root, "current-package"),
		dirs,
		fallback,
		launchOptions{},
		&bytes.Buffer{},
	)
	if err != nil {
		t.Fatalf("prepare empty preferred Windows data root: %v", err)
	}
	if resolved != dirs {
		t.Fatalf("unexpected resolved runtime directories: %#v", resolved)
	}
	content, err := os.ReadFile(filepath.Join(preferred, "session.json"))
	if err != nil || string(content) != "c-session" {
		t.Fatalf("empty D directory did not receive C data: %q, %v", content, err)
	}
}

func TestPreparePreferredWindowsRuntimeDirsNeverMergesNonemptyDDirectory(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	fallback := filepath.Join(root, "LocalAppData", "SmartPerfetto")
	preferred := filepath.Join(root, "D-drive", "SmartPerfettoData")
	if err := os.MkdirAll(fallback, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fallback, "c-only.json"), []byte("c-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(preferred, 0o755); err != nil {
		t.Fatal(err)
	}
	dMarker := filepath.Join(preferred, "d-only.json")
	if err := os.WriteFile(dMarker, []byte("d-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	notices := &bytes.Buffer{}
	dirs := runtimeDirs{dataDir: preferred, logsDir: filepath.Join(preferred, "logs")}

	resolved, err := preparePreferredWindowsRuntimeDirs(
		filepath.Join(root, "current-package"),
		dirs,
		fallback,
		launchOptions{},
		notices,
	)
	if err != nil {
		t.Fatalf("preserve nonempty preferred Windows data root: %v", err)
	}
	if resolved != dirs {
		t.Fatalf("unexpected resolved runtime directories: %#v", resolved)
	}
	if _, err := os.Stat(filepath.Join(preferred, "c-only.json")); !os.IsNotExist(err) {
		t.Fatalf("C data must not be merged into nonempty D: %v", err)
	}
	content, err := os.ReadFile(dMarker)
	if err != nil || string(content) != "d-data" {
		t.Fatalf("existing D data changed: %q, %v", content, err)
	}
	if !strings.Contains(notices.String(), "not merged") {
		t.Fatalf("missing non-merge notice: %q", notices.String())
	}
}

func TestPreparePreferredWindowsRuntimeDirsFallsBackToCWhenAutomaticMigrationFails(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	fallback := filepath.Join(root, "LocalAppData", "SmartPerfetto")
	preferred := filepath.Join(root, "D-drive", "SmartPerfettoData")
	if err := os.MkdirAll(fallback, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fallback, "preserved.json"), []byte("c-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(fallback, "unsafe-link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	notices := &bytes.Buffer{}
	dirs := runtimeDirs{dataDir: preferred, logsDir: filepath.Join(preferred, "logs")}

	resolved, err := preparePreferredWindowsRuntimeDirs(
		filepath.Join(root, "current-package"),
		dirs,
		fallback,
		launchOptions{},
		notices,
	)
	if err != nil {
		t.Fatalf("automatic D migration should fall back to C: %v", err)
	}
	want := runtimeDirs{dataDir: fallback, logsDir: filepath.Join(fallback, "logs")}
	if resolved != want {
		t.Fatalf("automatic migration did not fall back to C: got %#v, want %#v", resolved, want)
	}
	if !strings.Contains(notices.String(), "WARNING") || !strings.Contains(notices.String(), fallback) {
		t.Fatalf("missing migration fallback warning: %q", notices.String())
	}
	if _, err := os.Stat(preferred); !os.IsNotExist(err) {
		t.Fatalf("failed D migration should not activate a destination: %v", err)
	}
	stages, err := filepath.Glob(filepath.Join(filepath.Dir(preferred), ".SmartPerfetto-migration-*"))
	if err != nil || len(stages) != 0 {
		t.Fatalf("failed D migration left staging data: %v, %v", stages, err)
	}
}

func TestPreparePreferredWindowsRuntimeDirsKeepsExplicitMigrationFailure(t *testing.T) {
	t.Setenv("SMARTPERFETTO_PORTABLE_MODE", "")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", "")
	root := t.TempDir()
	fallback := filepath.Join(root, "LocalAppData", "SmartPerfetto")
	preferred := filepath.Join(root, "D-drive", "SmartPerfettoData")
	explicitSource := filepath.Join(root, "explicit-source")
	if err := os.MkdirAll(explicitSource, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(explicitSource, "unsafe-link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	dirs := runtimeDirs{dataDir: preferred, logsDir: filepath.Join(preferred, "logs")}

	resolved, err := preparePreferredWindowsRuntimeDirs(
		filepath.Join(root, "current-package"),
		dirs,
		fallback,
		launchOptions{migrateFrom: explicitSource},
		&bytes.Buffer{},
	)
	if err == nil {
		t.Fatal("explicit migration failure must not be hidden by C fallback")
	}
	if resolved != dirs {
		t.Fatalf("explicit migration failure unexpectedly changed directories: %#v", resolved)
	}
}

func TestActivateMigrationDirectoryNeverReplacesConcurrentDestination(t *testing.T) {
	root := t.TempDir()
	stage := filepath.Join(root, "stage")
	destination := filepath.Join(root, "destination")
	if err := os.MkdirAll(stage, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "migrated.json"), []byte("migrated"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(destination, "concurrent.json")
	if err := os.WriteFile(marker, []byte("concurrent"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := activateMigrationDirectory(stage, destination); err == nil {
		t.Fatal("activation should reject a destination created after the empty check")
	}
	content, err := os.ReadFile(marker)
	if err != nil || string(content) != "concurrent" {
		t.Fatalf("concurrent destination was replaced: %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(stage, "migrated.json")); err != nil {
		t.Fatalf("failed activation should leave stage for caller cleanup: %v", err)
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
