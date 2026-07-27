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
	destination string,
	options launchOptions,
) error {
	if runtime.GOOS != "windows" {
		return nil
	}
	return migrateLegacyData(packageRoot, destination, options)
}

func migrateLegacyData(
	packageRoot string,
	destination string,
	options launchOptions,
) error {
	if os.Getenv("SMARTPERFETTO_PORTABLE_MODE") == "1" ||
		os.Getenv("SMARTPERFETTO_PORTABLE_DATA_DIR") != "" {
		return nil
	}
	if info, err := os.Lstat(destination); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
			return fmt.Errorf("data destination is not a safe directory: %s", destination)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect data destination %s: %w", destination, err)
	}

	source, explicit, err := findMigrationSource(packageRoot, options.migrateFrom)
	if err != nil {
		return err
	}
	if source == "" {
		return nil
	}
	if err := assertSafeMigrationDirectory(source); err != nil {
		return fmt.Errorf("cannot migrate legacy data from %s: %w", source, err)
	}

	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create data parent %s: %w", parent, err)
	}
	stage := filepath.Join(
		parent,
		fmt.Sprintf(".SmartPerfetto-migration-%d", os.Getpid()),
	)
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
	if err := os.Rename(stage, destination); err != nil {
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

func findMigrationSource(packageRoot string, configured string) (string, bool, error) {
	if configured != "" {
		absolute, err := filepath.Abs(configured)
		if err != nil {
			return "", true, fmt.Errorf("resolve --migrate-from: %w", err)
		}
		if info, err := os.Stat(filepath.Join(absolute, "data")); err == nil && info.IsDir() {
			return filepath.Join(absolute, "data"), true, nil
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
		data := filepath.Join(parent, entry.Name(), "data")
		if info, err := os.Stat(data); err == nil && info.IsDir() {
			var parsed [3]int
			for index := range parsed {
				parsed[index], _ = strconv.Atoi(match[index+1])
			}
			candidates = append(candidates, migrationCandidate{
				path:    data,
				version: parsed,
			})
		}
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
		target := filepath.Join(destination, relative)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("refusing to copy non-regular file: %s", current)
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
