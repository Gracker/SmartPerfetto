// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStopServiceUsesPrivateGracefulShutdownFile(t *testing.T) {
	shutdownFile := filepath.Join(t.TempDir(), "backend.shutdown")
	proc := &serviceProcess{
		name:         "backend",
		shutdownFile: shutdownFile,
		done:         make(chan struct{}),
	}
	go func() {
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(shutdownFile); err == nil {
				proc.mu.Lock()
				proc.result = processResult{ExitCode: 0, Success: true}
				proc.mu.Unlock()
				close(proc.done)
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()

	result := stopService(proc)
	if !result.gracefulRequested || result.escalated || result.shutdownError != "" {
		t.Fatalf("unexpected graceful shutdown result: %#v", result)
	}
	if !result.result.Success || result.result.ExitCode != 0 {
		t.Fatalf("unexpected child result: %#v", result.result)
	}
}

func TestWaitForShutdownFileObservesAutomationRequest(t *testing.T) {
	shutdownFile := filepath.Join(t.TempDir(), "launcher.shutdown")
	ready := make(chan struct{}, 1)
	stop := make(chan struct{})
	go waitForShutdownFile(shutdownFile, ready, stop)
	if err := os.WriteFile(shutdownFile, []byte("shutdown\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	select {
	case <-ready:
	case <-time.After(time.Second):
		close(stop)
		t.Fatal("shutdown file was not observed")
	}
	close(stop)
}

func TestWaitForShutdownFileIgnoresDirectoriesAndSymlinks(t *testing.T) {
	root := t.TempDir()
	shutdownFile := filepath.Join(root, "launcher.shutdown")
	if err := os.Mkdir(shutdownFile, 0o700); err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{}, 1)
	stop := make(chan struct{})
	go waitForShutdownFile(shutdownFile, ready, stop)
	select {
	case <-ready:
		close(stop)
		t.Fatal("directory must not be accepted as a shutdown request")
	case <-time.After(250 * time.Millisecond):
	}
	if err := os.Remove(shutdownFile); err != nil {
		close(stop)
		t.Fatal(err)
	}
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("shutdown\n"), 0o600); err != nil {
		close(stop)
		t.Fatal(err)
	}
	if err := os.Symlink(target, shutdownFile); err == nil {
		select {
		case <-ready:
			close(stop)
			t.Fatal("symlink must not be accepted as a shutdown request")
		case <-time.After(250 * time.Millisecond):
		}
		if err := os.Remove(shutdownFile); err != nil {
			close(stop)
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(shutdownFile, []byte("shutdown\n"), 0o600); err != nil {
		close(stop)
		t.Fatal(err)
	}
	select {
	case <-ready:
	case <-time.After(time.Second):
		close(stop)
		t.Fatal("regular shutdown file was not observed")
	}
	close(stop)
}

func TestWriteLifecycleReceiptIsFreshStructuredEvidence(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "receipt.json")
	receipt := lifecycleReceipt{
		SchemaVersion: 2,
		Version:       "1.2.3",
		GitCommit:     "abc",
		PackageTarget: "linux-x64",
		Containment:   "service-process-groups",
		ExitReason:    "shutdown-file",
		Success:       true,
		FinishedAt:    time.Now().UTC().Format(time.RFC3339),
	}
	if err := writeLifecycleReceipt(path, receipt); err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var decoded lifecycleReceipt
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.SchemaVersion != 2 ||
		decoded.Version != "1.2.3" ||
		decoded.Containment != "service-process-groups" ||
		decoded.ExitReason != "shutdown-file" ||
		!decoded.Success {
		t.Fatalf("unexpected lifecycle receipt: %#v", decoded)
	}
}
