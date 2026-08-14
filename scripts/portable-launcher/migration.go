// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var windowsPackageName = regexp.MustCompile(
	`(?i)^smartperfetto-v(\d+)\.(\d+)\.(\d+)-windows-x64$`,
)

type migrationReceipt struct {
	SchemaVersion int    `json:"schemaVersion"`
	Source        string `json:"source"`
	MigratedAt    string `json:"migratedAt"`
}

func migrateLegacyWindowsData(
	packageRoot string,
	dirs runtimeDirs,
	options launchOptions,
) (runtimeDirs, error) {
	if runtime.GOOS != "windows" {
		return dirs, nil
	}
	if os.Getenv("SMARTPERFETTO_PORTABLE_MODE") == "1" ||
		os.Getenv("SMARTPERFETTO_PORTABLE_DATA_DIR") != "" {
		return dirs, migrateLegacyData(packageRoot, dirs.dataDir, options)
	}
	home, homeErr := os.UserHomeDir()
	fallback, err := resolveWindowsFallbackDataRoot(os.Getenv, home, homeErr)
	if err != nil {
		return dirs, err
	}
	if strings.EqualFold(filepath.Clean(dirs.dataDir), filepath.Clean(fallback)) {
		return dirs, migrateLegacyData(packageRoot, dirs.dataDir, options)
	}
	return preparePreferredWindowsRuntimeDirs(
		packageRoot,
		dirs,
		fallback,
		options,
		os.Stderr,
	)
}

func migrateLegacyData(
	packageRoot string,
	destination string,
	options launchOptions,
) error {
	return migrateLegacyDataWithAutomaticSource(
		packageRoot,
		destination,
		options,
		"",
	)
}

func migrateLegacyDataWithAutomaticSource(
	packageRoot string,
	destination string,
	options launchOptions,
	automaticSource string,
) error {
	if os.Getenv("SMARTPERFETTO_PORTABLE_MODE") == "1" ||
		os.Getenv("SMARTPERFETTO_PORTABLE_DATA_DIR") != "" {
		if options.migrateFrom != "" {
			return fmt.Errorf(
				"--migrate-from cannot be used with SMARTPERFETTO_PORTABLE_MODE or SMARTPERFETTO_PORTABLE_DATA_DIR; no data was migrated",
			)
		}
		return nil
	}
	if info, err := os.Lstat(destination); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
			return fmt.Errorf("data destination is not a safe directory: %s", destination)
		}
		if options.migrateFrom != "" {
			return fmt.Errorf(
				"cannot use --migrate-from because the data destination already exists: %s; no data was migrated and the existing destination was preserved; back up and move the destination before retrying",
				destination,
			)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect data destination %s: %w", destination, err)
	}

	source := automaticSource
	explicit := false
	if source == "" {
		var err error
		source, explicit, err = findMigrationSource(packageRoot, options.migrateFrom)
		if err != nil {
			return err
		}
	}
	if source == "" {
		return nil
	}
	if err := assertSafeMigrationDirectory(source); err != nil {
		return fmt.Errorf("cannot migrate legacy data from %s: %w", source, err)
	}

	parent := filepath.Dir(destination)
	stage := filepath.Join(
		parent,
		fmt.Sprintf(".SmartPerfetto-migration-%d", os.Getpid()),
	)
	if err := assertDisjointMigrationPaths(source, destination, stage); err != nil {
		return err
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create data parent %s: %w", parent, err)
	}
	if _, err := os.Lstat(stage); err == nil {
		return fmt.Errorf("migration staging path already exists: %s", stage)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect migration staging path: %w", err)
	}
	if err := copyMigrationTree(source, stage); err != nil {
		_ = os.RemoveAll(stage)
		hint := ""
		if explicit {
			hint = " (check --migrate-from)"
		}
		return fmt.Errorf(
			"copy legacy data from %s: %w; the old data was preserved%s",
			source,
			err,
			hint,
		)
	}
	receiptBytes, err := json.MarshalIndent(migrationReceipt{
		SchemaVersion: 1,
		Source:        source,
		MigratedAt:    time.Now().UTC().Format(time.RFC3339),
	}, "", "  ")
	if err != nil {
		_ = os.RemoveAll(stage)
		return err
	}
	if err := os.WriteFile(
		filepath.Join(stage, ".migration-receipt.json"),
		append(receiptBytes, '\n'),
		0o600,
	); err != nil {
		_ = os.RemoveAll(stage)
		return fmt.Errorf("write migration receipt: %w", err)
	}
	if err := activateMigrationDirectory(stage, destination); err != nil {
		_ = os.RemoveAll(stage)
		return fmt.Errorf(
			"activate migrated data at %s: %w; the old data was preserved",
			destination,
			err,
		)
	}
	fmt.Printf("Migrated legacy SmartPerfetto data from %s to %s. The old copy was preserved.\n", source, destination)
	return nil
}

func preparePreferredWindowsRuntimeDirs(
	packageRoot string,
	dirs runtimeDirs,
	fallbackDataDir string,
	options launchOptions,
	notices io.Writer,
) (runtimeDirs, error) {
	if options.migrateFrom != "" {
		return dirs, migrateLegacyData(packageRoot, dirs.dataDir, options)
	}

	destinationExists, destinationEmpty, destinationErr := inspectMigrationDirectory(dirs.dataDir)
	if destinationErr == nil && destinationExists && !destinationEmpty {
		fmt.Fprintf(
			notices,
			"NOTICE: Preferred Windows data directory %s already contains data; automatic sources were not merged or overwritten.\n",
			dirs.dataDir,
		)
		return dirs, nil
	}
	if destinationErr == nil && destinationExists && destinationEmpty {
		if err := os.Remove(dirs.dataDir); err != nil {
			destinationErr = fmt.Errorf("remove empty preferred data directory %s: %w", dirs.dataDir, err)
		}
	}

	automaticSource := ""
	if destinationErr == nil {
		fallbackExists, fallbackEmpty, err := inspectMigrationDirectory(fallbackDataDir)
		if err != nil {
			destinationErr = fmt.Errorf("inspect fallback Windows data directory %s: %w", fallbackDataDir, err)
		} else if fallbackExists && !fallbackEmpty {
			automaticSource = fallbackDataDir
		}
	}

	migrationErr := destinationErr
	if migrationErr == nil {
		migrationErr = migrateLegacyDataWithAutomaticSource(
			packageRoot,
			dirs.dataDir,
			options,
			automaticSource,
		)
	}
	if migrationErr == nil {
		return dirs, nil
	}

	fallbackDirs := runtimeDirs{
		dataDir: fallbackDataDir,
		logsDir: filepath.Join(fallbackDataDir, "logs"),
	}
	fmt.Fprintf(
		notices,
		"WARNING: Could not prepare preferred Windows data directory %s: %v. Continuing with fallback data directory %s; existing C data was preserved.\n",
		dirs.dataDir,
		migrationErr,
		fallbackDataDir,
	)
	if err := migrateLegacyData(packageRoot, fallbackDataDir, launchOptions{}); err != nil {
		return dirs, fmt.Errorf(
			"prepare preferred Windows data directory: %v; prepare fallback data directory: %w",
			migrationErr,
			err,
		)
	}
	return fallbackDirs, nil
}

func inspectMigrationDirectory(root string) (exists bool, empty bool, err error) {
	info, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
		return true, false, fmt.Errorf("path is a symlink, reparse point, or non-directory")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return true, false, err
	}
	return true, len(entries) == 0, nil
}

func activateMigrationDirectory(stage string, destination string) error {
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("migration destination appeared before activation: %s", destination)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect migration destination before activation: %w", err)
	}
	return os.Rename(stage, destination)
}

func findMigrationSource(packageRoot string, configured string) (string, bool, error) {
	if configured != "" {
		absolute, err := filepath.Abs(configured)
		if err != nil {
			return "", true, fmt.Errorf("resolve --migrate-from: %w", err)
		}
		if data, ok := existingPackageDataDir(absolute); ok {
			return data, true, nil
		}
		if info, err := os.Stat(absolute); err == nil && info.IsDir() {
			return absolute, true, nil
		}
		return "", true, fmt.Errorf("--migrate-from does not contain a readable data directory: %s", configured)
	}

	currentData := filepath.Join(packageRoot, "data")
	if info, err := os.Stat(currentData); err == nil && info.IsDir() {
		return currentData, false, nil
	}
	currentMatch := windowsPackageName.FindStringSubmatch(filepath.Base(packageRoot))
	if currentMatch == nil {
		return "", false, nil
	}
	var currentVersion [3]int
	for index := range currentVersion {
		currentVersion[index], _ = strconv.Atoi(currentMatch[index+1])
	}
	parent := filepath.Dir(packageRoot)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return "", false, nil
	}
	type migrationCandidate struct {
		path    string
		version [3]int
	}
	candidates := make([]migrationCandidate, 0)
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == filepath.Base(packageRoot) {
			continue
		}
		match := windowsPackageName.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		data, ok := existingPackageDataDir(filepath.Join(parent, entry.Name()))
		if !ok {
			continue
		}
		var parsed [3]int
		for index := range parsed {
			parsed[index], _ = strconv.Atoi(match[index+1])
		}
		if !versionLess(parsed, currentVersion) {
			continue
		}
		candidates = append(candidates, migrationCandidate{
			path:    data,
			version: parsed,
		})
	}
	for index := 1; index < len(candidates); index++ {
		for previous := index; previous > 0; previous-- {
			left := candidates[previous-1]
			right := candidates[previous]
			if !versionLess(left.version, right.version) {
				break
			}
			candidates[previous-1], candidates[previous] = right, left
		}
	}
	if len(candidates) > 0 {
		return candidates[0].path, false, nil
	}
	return "", false, nil
}

func existingPackageDataDir(packageRoot string) (string, bool) {
	for _, candidate := range []string{
		filepath.Join(packageRoot, "data"),
		filepath.Join(packageRoot, "backend", "data"),
	} {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate, true
		}
	}
	return "", false
}

func isLegacyBackendDataRoot(root string) bool {
	return strings.EqualFold(filepath.Base(root), "data") &&
		strings.EqualFold(filepath.Base(filepath.Dir(root)), "backend")
}

func migrationTargetRelativePath(sourceRoot string, relative string) string {
	if !isLegacyBackendDataRoot(sourceRoot) || relative == "." {
		return relative
	}
	relativeFolded := strings.ToLower(relative)
	if strings.EqualFold(relative, "providers.json") ||
		strings.HasPrefix(relativeFolded, "providers.json.") ||
		strings.EqualFold(relative, "secrets") ||
		strings.HasPrefix(relativeFolded, "secrets"+string(filepath.Separator)) {
		return filepath.Join("providers", relative)
	}
	return filepath.Join("backend", relative)
}

func versionLess(left [3]int, right [3]int) bool {
	for index := range left {
		if left[index] != right[index] {
			return left[index] < right[index]
		}
	}
	return false
}

func assertSafeMigrationDirectory(root string) error {
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
		return fmt.Errorf("source root is a symlink, reparse point, or non-directory")
	}
	return nil
}

func canonicalMigrationPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	canonical := filepath.Clean(absolute)
	missingComponents := make([]string, 0)
	for current := canonical; ; current = filepath.Dir(current) {
		if _, err := os.Lstat(current); err == nil {
			resolved, err := filepath.EvalSymlinks(current)
			if err != nil {
				return "", err
			}
			for index := len(missingComponents) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missingComponents[index])
			}
			canonical = filepath.Clean(resolved)
			break
		} else if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("cannot resolve existing ancestor for %s", path)
		}
		missingComponents = append(missingComponents, filepath.Base(current))
	}
	if runtime.GOOS == "windows" {
		canonical = strings.ToLower(canonical)
	}
	return canonical, nil
}

func assertNoWindowsReparsePointAncestor(path string) error {
	if runtime.GOOS != "windows" {
		return nil
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for current := filepath.Clean(absolute); ; current = filepath.Dir(current) {
		if info, err := os.Lstat(current); err == nil {
			if isReparsePoint(info) {
				return fmt.Errorf("path contains a reparse-point ancestor: %s", current)
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
	}
}

func migrationPathContains(ancestor string, candidate string) (bool, error) {
	relative, err := filepath.Rel(ancestor, candidate)
	if err != nil {
		if !strings.EqualFold(filepath.VolumeName(ancestor), filepath.VolumeName(candidate)) {
			return false, nil
		}
		return false, err
	}
	return relative == "." || (relative != ".." &&
		!filepath.IsAbs(relative) &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))), nil
}

func migrationPathsOverlap(left string, right string) (bool, error) {
	leftCanonical, err := canonicalMigrationPath(left)
	if err != nil {
		return false, err
	}
	rightCanonical, err := canonicalMigrationPath(right)
	if err != nil {
		return false, err
	}
	leftContainsRight, err := migrationPathContains(leftCanonical, rightCanonical)
	if err != nil || leftContainsRight {
		return leftContainsRight, err
	}
	return migrationPathContains(rightCanonical, leftCanonical)
}

func assertDisjointMigrationPaths(source string, destination string, stage string) error {
	for _, path := range []string{source, destination, stage} {
		if err := assertNoWindowsReparsePointAncestor(path); err != nil {
			return fmt.Errorf("migration paths must not use reparse-point aliases: %w; no data was migrated", err)
		}
	}
	for _, pair := range [][2]string{
		{source, destination},
		{source, stage},
		{destination, stage},
	} {
		overlaps, err := migrationPathsOverlap(pair[0], pair[1])
		if err != nil {
			return fmt.Errorf("resolve migration paths: %w", err)
		}
		if overlaps {
			return fmt.Errorf(
				"migration source, destination, and staging paths must not overlap: %s and %s; no data was migrated",
				pair[0],
				pair[1],
			)
		}
	}
	return nil
}

func copyMigrationTree(source string, destination string) error {
	return filepath.Walk(source, func(current string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, current)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("unsafe source path: %s", current)
		}
		if info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
			return fmt.Errorf("refusing to copy symlink or reparse point: %s", current)
		}
		target := filepath.Join(
			destination,
			migrationTargetRelativePath(source, relative),
		)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("refusing to copy non-regular file: %s", current)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return copyMigrationFile(current, target, info.Mode().Perm())
	})
}

func copyMigrationFile(source string, destination string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
