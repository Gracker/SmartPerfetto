// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build !windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestLauncherStartupShutdownHelper(t *testing.T) {
	root := os.Getenv("SMARTPERFETTO_TEST_LAUNCHER_ROOT")
	if root == "" {
		return
	}
	executablePath = func() (string, error) {
		return filepath.Join(root, "SmartPerfetto"), nil
	}
	options := launchOptions{
		nonInteractive:   true,
		shutdownFile:     os.Getenv("SMARTPERFETTO_TEST_SHUTDOWN_FILE"),
		lifecycleReceipt: os.Getenv("SMARTPERFETTO_TEST_RECEIPT_FILE"),
	}
	if err := runLauncher(options); err != nil {
		t.Fatal(err)
	}
}

func TestLauncherRuntimePreflightFailsBeforeBackendStart(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{
		filepath.Join(root, "runtime", "node", "bin"),
		filepath.Join(root, "bin"),
		filepath.Join(root, "backend", "dist"),
		filepath.Join(root, "frontend"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	marker := filepath.Join(root, "backend-started")
	nodeScript := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "dyld: macOS 13.5 or later is required" >&2
  exit 86
fi
: > "$SMARTPERFETTO_TEST_BACKEND_MARKER"
`
	if err := os.WriteFile(
		filepath.Join(root, "runtime", "node", "bin", "node"),
		[]byte(nodeScript),
		0o755,
	); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{
		filepath.Join(root, "bin", "trace_processor_shell"),
		filepath.Join(root, "backend", "dist", "index.js"),
		filepath.Join(root, "frontend", "server.js"),
	} {
		if err := os.WriteFile(file, []byte("fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	backendListener, backendPort := reserveTestPort(t)
	frontendListener, frontendPort := reserveTestPort(t)
	if err := backendListener.Close(); err != nil {
		t.Fatal(err)
	}
	if err := frontendListener.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMARTPERFETTO_BACKEND_PORT", backendPort)
	t.Setenv("SMARTPERFETTO_FRONTEND_PORT", frontendPort)
	t.Setenv("SMARTPERFETTO_TEST_BACKEND_MARKER", marker)
	dataDir := filepath.Join(root, "runtime-data")
	logsDir := filepath.Join(root, "runtime-logs")
	t.Setenv("SMARTPERFETTO_PORTABLE_DATA_DIR", dataDir)
	t.Setenv("SMARTPERFETTO_PORTABLE_LOG_DIR", logsDir)

	originalExecutablePath := executablePath
	t.Cleanup(func() {
		executablePath = originalExecutablePath
	})
	executablePath = func() (string, error) {
		return filepath.Join(root, "SmartPerfetto"), nil
	}

	err := runLauncher(launchOptions{nonInteractive: true})
	if err == nil ||
		!strings.Contains(err.Error(), "runtime self-check failed") ||
		!strings.Contains(err.Error(), "exit status 86") {
		t.Fatalf("expected runtime preflight failure, got %v", err)
	}
	if _, statErr := os.Stat(marker); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("backend started despite failed runtime preflight: %v", statErr)
	}
	for _, dir := range []string{dataDir, logsDir} {
		if _, statErr := os.Stat(dir); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("runtime directory was created before preflight completed: %s", dir)
		}
	}
}

func TestLauncherStopsStartedBackendWhenStartupIsInterrupted(t *testing.T) {
	for _, mode := range []string{"signal", "shutdown-file"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			for _, dir := range []string{
				filepath.Join(root, "runtime", "node", "bin"),
				filepath.Join(root, "bin"),
				filepath.Join(root, "backend", "dist"),
				filepath.Join(root, "frontend"),
			} {
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			nodeFixture := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "v24.18.0"
  exit 0
fi
while [ ! -f "$SMARTPERFETTO_SHUTDOWN_FILE" ]; do
  sleep 0.02
done
exit 0
`
			if err := os.WriteFile(
				filepath.Join(root, "runtime", "node", "bin", "node"),
				[]byte(nodeFixture),
				0o755,
			); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(
				filepath.Join(root, "bin", "trace_processor_shell"),
				[]byte("fixture"),
				0o755,
			); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(
				filepath.Join(root, "backend", "dist", "index.js"),
				[]byte("// fixture\n"),
				0o644,
			); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(
				filepath.Join(root, "frontend", "server.js"),
				[]byte("process.exit(0);\n"),
				0o644,
			); err != nil {
				t.Fatal(err)
			}

			backendPort := reserveLauncherIntegrationPort(t)
			frontendPort := reserveLauncherIntegrationPort(t)
			shutdownFile := filepath.Join(root, "launcher.shutdown")
			receiptFile := filepath.Join(root, "receipt.json")
			testBinary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			command := exec.Command(testBinary, "-test.run=^TestLauncherStartupShutdownHelper$")
			command.Env = append(os.Environ(),
				"SMARTPERFETTO_TEST_LAUNCHER_ROOT="+root,
				"SMARTPERFETTO_TEST_SHUTDOWN_FILE="+shutdownFile,
				"SMARTPERFETTO_TEST_RECEIPT_FILE="+receiptFile,
				"SMARTPERFETTO_BACKEND_PORT="+backendPort,
				"SMARTPERFETTO_FRONTEND_PORT="+frontendPort,
				"SMARTPERFETTO_PORTABLE_DATA_DIR="+filepath.Join(root, "data"),
				"SMARTPERFETTO_PORTABLE_LOG_DIR="+filepath.Join(root, "logs"),
			)
			stdout, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			command.Stderr = command.Stdout
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			var backendPID int
			t.Cleanup(func() {
				if command.ProcessState == nil {
					_ = command.Process.Kill()
				}
				if backendPID > 0 {
					_ = syscall.Kill(-backendPID, syscall.SIGKILL)
				}
			})

			started := make(chan int, 1)
			go func() {
				scanner := bufio.NewScanner(stdout)
				reported := false
				for scanner.Scan() {
					line := scanner.Text()
					if !reported && strings.HasPrefix(line, "Started backend (PID ") {
						var pid int
						if _, err := fmt.Sscanf(line, "Started backend (PID %d),", &pid); err == nil {
							started <- pid
							reported = true
						}
					}
				}
			}()
			select {
			case backendPID = <-started:
			case <-time.After(30 * time.Second):
				_ = command.Process.Kill()
				t.Fatal("launcher did not start the backend fixture")
			}

			if mode == "signal" {
				if err := command.Process.Signal(syscall.SIGTERM); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(shutdownFile, []byte("shutdown\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			waitDone := make(chan error, 1)
			go func() {
				waitDone <- command.Wait()
			}()
			select {
			case err := <-waitDone:
				if err != nil {
					backendLog, _ := os.ReadFile(filepath.Join(root, "logs", "backend.log"))
					receiptPayload, _ := os.ReadFile(receiptFile)
					t.Fatalf(
						"launcher did not exit cleanly: %v\nbackend log:\n%s\nreceipt:\n%s",
						err,
						backendLog,
						receiptPayload,
					)
				}
			case <-time.After(30 * time.Second):
				_ = command.Process.Kill()
				t.Fatal("launcher did not exit after startup interruption")
			}

			if processExists(backendPID) {
				t.Fatalf("backend PID %d survived launcher exit", backendPID)
			}
			payload, err := os.ReadFile(receiptFile)
			if err != nil {
				t.Fatal(err)
			}
			var receipt lifecycleReceipt
			if err := json.Unmarshal(payload, &receipt); err != nil {
				t.Fatal(err)
			}
			if !receipt.Success || len(receipt.Services) != 1 ||
				receipt.Services[0].Name != "backend" ||
				!receipt.Services[0].Result.Success {
				t.Fatalf("startup interruption receipt is not successful: %#v", receipt)
			}
			if mode == "signal" && !strings.HasPrefix(receipt.ExitReason, "signal:") {
				t.Fatalf("unexpected signal exit reason: %q", receipt.ExitReason)
			}
			if mode == "shutdown-file" && receipt.ExitReason != "shutdown-file" {
				t.Fatalf("unexpected shutdown-file exit reason: %q", receipt.ExitReason)
			}
		})
	}
}

func reserveLauncherIntegrationPort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp4", net.JoinHostPort(ipv4LoopbackHost, "0"))
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return strconv.Itoa(port)
}

func processExists(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}
