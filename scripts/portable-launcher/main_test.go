// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestResolveServicePortsFallsBackWhenDefaultFrontendPortIsBusy(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("SMARTPERFETTO_BACKEND_PORT", "")
	t.Setenv("SMARTPERFETTO_FRONTEND_PORT", "")

	listener, err := net.Listen(
		"tcp4",
		net.JoinHostPort(ipv4LoopbackHost, defaultFrontendPort),
	)
	if err != nil {
		t.Logf("default frontend port %s is already unavailable: %v", defaultFrontendPort, err)
	} else {
		defer listener.Close()
	}

	backendPort, frontendPort, err := resolveServicePorts()
	if err != nil {
		t.Fatalf("resolve service ports: %v", err)
	}
	if backendPort == frontendPort {
		t.Fatalf("backend and frontend ports should differ, got %s", backendPort)
	}
	if frontendPort == defaultFrontendPort {
		t.Fatalf("expected busy default frontend port to be replaced")
	}
}

func TestResolveServicePortsRejectsBusyExplicitFrontendPort(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("SMARTPERFETTO_BACKEND_PORT", "")

	listener, port := reserveTestPort(t)
	defer listener.Close()
	t.Setenv("SMARTPERFETTO_FRONTEND_PORT", port)

	_, _, err := resolveServicePorts()
	if err == nil {
		t.Fatalf("expected busy explicit frontend port to be rejected")
	}
	if !strings.Contains(err.Error(), "frontend port "+port) {
		t.Fatalf("expected actionable frontend port error, got %q", err.Error())
	}
}

func TestLoopbackHTTPURLUsesExplicitIPv4Address(t *testing.T) {
	got := loopbackHTTPURL(defaultBackendPort, "/health")
	want := "http://127.0.0.1:3000/health"
	if got != want {
		t.Fatalf("loopback HTTP URL mismatch: got %q, want %q", got, want)
	}
}

func TestPortAvailabilityMatchesTheActualLoopbackBind(t *testing.T) {
	otherInterface, err := net.Listen("tcp4", "127.0.0.2:0")
	if err != nil {
		t.Skipf("secondary loopback address is unavailable: %v", err)
	}
	defer otherInterface.Close()
	port := strconv.Itoa(otherInterface.Addr().(*net.TCPAddr).Port)
	if !isPortAvailable(port) {
		t.Fatalf("listener on another interface must not block 127.0.0.1:%s", port)
	}
}

func TestWaitForHTTPConnectsToIPv4OnlyListener(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on IPv4 loopback: %v", err)
	}

	server := &http.Server{
		Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"status":"OK"}`))
		}),
	}
	go func() {
		_ = server.Serve(listener)
	}()
	t.Cleanup(func() {
		_ = server.Close()
	})

	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("expected TCP address, got %T", listener.Addr())
	}
	url := loopbackHTTPURL(strconv.Itoa(tcpAddr.Port), "/health")
	if err := waitForHTTP(url, time.Second); err != nil {
		t.Fatalf("wait for IPv4-only HTTP service: %v", err)
	}
}

func TestWaitForHealthRequiresTwoHundredResponseAndExpectedPayload(t *testing.T) {
	tests := []struct {
		name        string
		statusCode  int
		body        string
		location    string
		expectation healthExpectation
	}{
		{
			name:        "redirect",
			statusCode:  http.StatusPermanentRedirect,
			body:        `{"status":"OK","version":"1.2.3"}`,
			location:    "/health-ok",
			expectation: healthExpectation{status: "OK", version: "1.2.3"},
		},
		{
			name:        "wrong version",
			statusCode:  http.StatusOK,
			body:        `{"status":"OK","version":"old"}`,
			expectation: healthExpectation{status: "OK", version: "1.2.3"},
		},
		{
			name:        "error status",
			statusCode:  http.StatusOK,
			body:        `{"status":"ERROR","version":"1.2.3"}`,
			expectation: healthExpectation{status: "OK", version: "1.2.3"},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			server := http.Server{
				Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
					response.Header().Set("Content-Type", "application/json")
					if testCase.location != "" {
						response.Header().Set("Location", testCase.location)
					}
					response.WriteHeader(testCase.statusCode)
					_, _ = response.Write([]byte(testCase.body))
				}),
			}
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			go func() {
				_ = server.Serve(listener)
			}()
			t.Cleanup(func() {
				_ = server.Close()
			})
			port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
			err = waitForHealth(
				loopbackHTTPURL(port, "/health"),
				150*time.Millisecond,
				testCase.expectation,
			)
			if err == nil {
				t.Fatal("invalid health response should not become ready")
			}
		})
	}
}

func TestWaitForServiceHealthFailsImmediatelyWhenProcessExits(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := http.Server{
		Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"status":"STARTING"}`))
		}),
	}
	go func() {
		_ = server.Serve(listener)
	}()
	t.Cleanup(func() {
		_ = server.Close()
	})

	proc := &serviceProcess{
		name:    "backend",
		logPath: "/tmp/smartperfetto-test/backend.log",
		done:    make(chan struct{}),
	}
	go func() {
		time.Sleep(20 * time.Millisecond)
		proc.mu.Lock()
		proc.result = processResult{ExitCode: 7, Error: "exit status 7"}
		proc.mu.Unlock()
		close(proc.done)
	}()

	startedAt := time.Now()
	err = waitForServiceHealth(
		proc,
		loopbackHTTPURL(strconv.Itoa(listener.Addr().(*net.TCPAddr).Port), "/health"),
		5*time.Second,
		healthExpectation{status: "OK"},
	)
	if err == nil || !strings.Contains(err.Error(), "backend exited before readiness (code 7)") {
		t.Fatalf("expected early process exit, got %v", err)
	}
	if !strings.Contains(err.Error(), proc.logPath) {
		t.Fatalf("expected backend log path in readiness error, got %v", err)
	}
	if elapsed := time.Since(startedAt); elapsed >= time.Second {
		t.Fatalf("early process exit took too long to surface: %s", elapsed)
	}
}

func TestWaitForServiceHealthTimeoutIncludesLogPath(t *testing.T) {
	listener, port := reserveTestPort(t)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	proc := &serviceProcess{
		name:    "backend",
		logPath: "/tmp/smartperfetto-test/backend-timeout.log",
		done:    make(chan struct{}),
	}

	err := waitForServiceHealth(
		proc,
		loopbackHTTPURL(port, "/health"),
		20*time.Millisecond,
		healthExpectation{status: "OK"},
	)
	if err == nil || !strings.Contains(err.Error(), proc.logPath) {
		t.Fatalf("expected timeout to include backend log path, got %v", err)
	}
}

func TestReadinessExitErrorUsesEachServiceLogPath(t *testing.T) {
	for _, name := range []string{"backend", "frontend"} {
		t.Run(name, func(t *testing.T) {
			logPath := "/tmp/smartperfetto-test/" + name + ".log"
			proc := &serviceProcess{
				name:    name,
				logPath: logPath,
				done:    make(chan struct{}),
				result:  processResult{ExitCode: 9, Error: "signal: killed"},
			}
			close(proc.done)

			err := readinessExitError(proc)
			if err == nil ||
				!strings.Contains(err.Error(), name+" exited before readiness") ||
				!strings.Contains(err.Error(), logPath) {
				t.Fatalf("expected %s readiness error with log path, got %v", name, err)
			}
		})
	}
}

func TestProbeRuntimeVersionReportsSuccessAndFailureOutput(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("SMARTPERFETTO_RUNTIME_PROBE_HELPER", "success")
	got, err := probeRuntimeVersion(
		"bundled Node.js",
		executable,
		time.Second,
		"-test.run=^TestRuntimeProbeHelper$",
	)
	if err != nil {
		t.Fatalf("runtime version probe failed: %v", err)
	}
	if got != "v24.18.0" {
		t.Fatalf("unexpected runtime version output: %q", got)
	}

	t.Setenv("SMARTPERFETTO_RUNTIME_PROBE_HELPER", "failure")
	_, err = probeRuntimeVersion(
		"bundled Node.js",
		executable,
		time.Second,
		"-test.run=^TestRuntimeProbeHelper$",
	)
	if err == nil ||
		!strings.Contains(err.Error(), executable) ||
		!strings.Contains(err.Error(), "exit status 86") ||
		!strings.Contains(err.Error(), "macOS 13.5 or later is required") {
		t.Fatalf("expected actionable runtime failure output, got %v", err)
	}
}

func TestProbeRuntimeVersionRejectsMissingExecutable(t *testing.T) {
	missing := t.TempDir() + "/missing-node"
	_, err := probeRuntimeVersion(
		"bundled Node.js",
		missing,
		time.Second,
		"--version",
	)
	if err == nil ||
		!strings.Contains(err.Error(), missing) ||
		!strings.Contains(err.Error(), "runtime self-check failed") {
		t.Fatalf("expected missing runtime error with executable path, got %v", err)
	}
}

func TestProbeRuntimeVersionTimesOut(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMARTPERFETTO_RUNTIME_PROBE_HELPER", "timeout")

	_, err = probeRuntimeVersion(
		"bundled Node.js",
		executable,
		50*time.Millisecond,
		"-test.run=^TestRuntimeProbeHelper$",
	)
	if err == nil ||
		!strings.Contains(err.Error(), executable) ||
		!strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected runtime probe timeout, got %v", err)
	}
}

func TestLimitedRuntimeProbeOutput(t *testing.T) {
	output := &limitedRuntimeProbeOutput{}
	input := []byte(strings.Repeat("x", runtimeProbeMaxText+100))
	written, err := output.Write(input)
	if err != nil {
		t.Fatal(err)
	}
	if written != len(input) {
		t.Fatalf("bounded output reported %d written bytes, want %d", written, len(input))
	}
	got := output.String()
	if !strings.HasSuffix(got, "...[runtime output truncated]") {
		t.Fatalf("expected bounded runtime output, got suffix %q", got[len(got)-32:])
	}
	if len(got) >= len(input) {
		t.Fatalf("runtime output was not bounded")
	}
}

func TestRuntimeProbeHelper(t *testing.T) {
	switch os.Getenv("SMARTPERFETTO_RUNTIME_PROBE_HELPER") {
	case "":
		return
	case "success":
		fmt.Println("v24.18.0")
		os.Exit(0)
	case "failure":
		fmt.Fprintln(os.Stderr, "dyld: macOS 13.5 or later is required")
		os.Exit(86)
	case "timeout":
		time.Sleep(time.Second)
	default:
		t.Fatalf("unknown runtime probe helper mode")
	}
}

func reserveTestPort(t *testing.T) (net.Listener, string) {
	t.Helper()
	listener, err := net.Listen("tcp4", net.JoinHostPort(ipv4LoopbackHost, "0"))
	if err != nil {
		t.Fatalf("reserve test port: %v", err)
	}
	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("expected TCP address, got %T", listener.Addr())
	}
	return listener, strconv.Itoa(tcpAddr.Port)
}
