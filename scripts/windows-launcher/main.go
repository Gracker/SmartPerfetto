// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	backendPort  = "3000"
	frontendPort = "10000"
)

var version = "dev"

type serviceProcess struct {
	name string
	cmd  *exec.Cmd
	log  *os.File
}

func main() {
	root, err := executableDir()
	if err != nil {
		fatal(err)
	}

	nodeExe := filepath.Join(root, "runtime", "node", "node.exe")
	traceProcessor := filepath.Join(root, "bin", "trace_processor_shell.exe")
	backendEntry := filepath.Join(root, "backend", "dist", "index.js")
	frontendEntry := filepath.Join(root, "frontend", "server.js")

	for _, required := range []string{nodeExe, traceProcessor, backendEntry, frontendEntry} {
		if _, err := os.Stat(required); err != nil {
			fatal(fmt.Errorf("required runtime file is missing: %s", required))
		}
	}

	logsDir := filepath.Join(root, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		fatal(err)
	}

	fmt.Println("SmartPerfetto Windows launcher")
	fmt.Printf("Version: %s\n", version)
	fmt.Printf("Package directory: %s\n", root)
	fmt.Printf("Frontend: http://localhost:%s\n", frontendPort)
	fmt.Printf("Backend:  http://localhost:%s\n", backendPort)
	fmt.Println()

	envPath := filepath.Join(root, "backend", ".env")
	if _, err := os.Stat(envPath); err != nil {
		fmt.Println("backend\\.env not found. The UI can still open, but AI analysis needs a provider profile or env credentials.")
		fmt.Println("To use env credentials, copy backend\\.env.example to backend\\.env and edit it, then restart SmartPerfetto.exe.")
		fmt.Println()
	}

	baseEnv := append([]string{}, os.Environ()...)
	pathEnv := fmt.Sprintf("%s%c%s", filepath.Join(root, "runtime", "node"), os.PathListSeparator, os.Getenv("PATH"))

	backendEnv := mergeEnv(baseEnv, map[string]string{
		"NODE_ENV":                      "production",
		"PORT":                          backendPort,
		"PATH":                          pathEnv,
		"TRACE_PROCESSOR_PATH":          traceProcessor,
		"SMARTPERFETTO_WINDOWS_PACKAGE": "1",
		"SMARTPERFETTO_OUTPUT_LANGUAGE": envOrDefault("SMARTPERFETTO_OUTPUT_LANGUAGE", "zh-CN"),
		"PROVIDER_DATA_DIR_OVERRIDE":    filepath.Join(root, "backend", "data"),
		"TRACE_PROCESSOR_DOWNLOAD_BASE": os.Getenv("TRACE_PROCESSOR_DOWNLOAD_BASE"),
		"TRACE_PROCESSOR_DOWNLOAD_URL":  os.Getenv("TRACE_PROCESSOR_DOWNLOAD_URL"),
		"SMARTPERFETTO_AGENT_RUNTIME":   os.Getenv("SMARTPERFETTO_AGENT_RUNTIME"),
		"SMARTPERFETTO_API_KEY":         os.Getenv("SMARTPERFETTO_API_KEY"),
		"SMARTPERFETTO_HOME":            filepath.Join(root, "data", "user"),
	})
	frontendEnv := mergeEnv(baseEnv, map[string]string{
		"PORT": frontendPort,
		"PATH": pathEnv,
	})

	backend, err := startService("backend", nodeExe, []string{backendEntry}, filepath.Join(root, "backend"), backendEnv, logsDir)
	if err != nil {
		fatal(err)
	}
	defer backend.closeLog()

	if err := waitForHTTP("http://localhost:"+backendPort+"/health", 90*time.Second); err != nil {
		stopService(backend)
		fatal(fmt.Errorf("backend did not become ready: %w", err))
	}

	frontend, err := startService("frontend", nodeExe, []string{frontendEntry}, filepath.Join(root, "frontend"), frontendEnv, logsDir)
	if err != nil {
		stopService(backend)
		fatal(err)
	}
	defer frontend.closeLog()

	if err := waitForHTTP("http://localhost:"+frontendPort+"/", 45*time.Second); err != nil {
		stopService(frontend)
		stopService(backend)
		fatal(fmt.Errorf("frontend did not become ready: %w", err))
	}

	url := "http://localhost:" + frontendPort
	fmt.Println()
	fmt.Println("SmartPerfetto is running.")
	fmt.Printf("Open: %s\n", url)
	fmt.Println("Keep this window open. Press Ctrl+C to stop.")
	fmt.Println()
	_ = openBrowser(url)

	exitCh := make(chan string, 2)
	go waitForService(backend, exitCh)
	go waitForService(frontend, exitCh)

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, os.Interrupt, syscall.SIGTERM)

	select {
	case sig := <-signalCh:
		fmt.Printf("\nReceived %s, stopping SmartPerfetto...\n", sig)
	case name := <-exitCh:
		fmt.Printf("\n%s exited; stopping SmartPerfetto...\n", name)
	}

	stopService(frontend)
	stopService(backend)
	fmt.Println("SmartPerfetto stopped.")
}

func executableDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Abs(filepath.Dir(exe))
}

func startService(name string, exe string, args []string, dir string, env []string, logsDir string) (*serviceProcess, error) {
	logPath := filepath.Join(logsDir, name+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}

	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	cmd.Env = env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = logFile.Close()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = logFile.Close()
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return nil, err
	}

	writer := io.MultiWriter(os.Stdout, logFile)
	go copyPrefixedOutput(name, stdout, writer)
	go copyPrefixedOutput(name, stderr, writer)

	fmt.Printf("Started %s (PID %d), log: %s\n", name, cmd.Process.Pid, logPath)
	return &serviceProcess{name: name, cmd: cmd, log: logFile}, nil
}

func copyPrefixedOutput(prefix string, reader io.Reader, writer io.Writer) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		fmt.Fprintf(writer, "[%s] %s\n", strings.ToUpper(prefix), scanner.Text())
	}
}

func waitForHTTP(url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := http.Client{Timeout: 2 * time.Second}
	var lastErr error

	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 500 {
				return nil
			}
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(time.Second)
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("timed out")
	}
	return lastErr
}

func waitForService(proc *serviceProcess, exitCh chan<- string) {
	err := proc.cmd.Wait()
	if err != nil {
		exitCh <- fmt.Sprintf("%s (%v)", proc.name, err)
		return
	}
	exitCh <- proc.name
}

func stopService(proc *serviceProcess) {
	if proc == nil || proc.cmd == nil || proc.cmd.Process == nil {
		return
	}

	pid := proc.cmd.Process.Pid
	if runtime.GOOS == "windows" {
		_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
		return
	}
	_ = proc.cmd.Process.Kill()
}

func (proc *serviceProcess) closeLog() {
	if proc != nil && proc.log != nil {
		_ = proc.log.Close()
	}
}

func openBrowser(url string) error {
	if runtime.GOOS == "windows" {
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	}
	return nil
}

func mergeEnv(base []string, overrides map[string]string) []string {
	result := make([]string, 0, len(base)+len(overrides))
	seen := make(map[string]bool, len(overrides))

	for key := range overrides {
		seen[strings.ToUpper(key)] = true
	}

	for _, item := range base {
		key := item
		if idx := strings.IndexByte(item, '='); idx >= 0 {
			key = item[:idx]
		}
		if seen[strings.ToUpper(key)] {
			continue
		}
		result = append(result, item)
	}

	for key, value := range overrides {
		if value == "" {
			continue
		}
		result = append(result, key+"="+value)
	}
	return result
}

func envOrDefault(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
	fmt.Fprintln(os.Stderr, "Press Enter to exit.")
	_, _ = fmt.Fscanln(os.Stdin)
	os.Exit(1)
}
