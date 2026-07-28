// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRunReturnsBoundedCanonicalEnvelope(t *testing.T) {
	server := loopbackServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Accept") != "application/json" {
			t.Errorf("unexpected Accept header: %q", request.Header.Get("Accept"))
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, `{"status":"OK","version":"fixture-version"}`)
	}))

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run(
		[]string{"portable-health-probe", server.URL + "/health", "2000"},
		&stdout,
		&stderr,
	)

	if exitCode != 0 {
		t.Fatalf("run returned %d: %s", exitCode, stderr.String())
	}
	parts := strings.Split(stdout.String(), "\n")
	if len(parts) != 2 || parts[0] != "200" {
		t.Fatalf("unexpected response envelope: %q", stdout.String())
	}
	body, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode response body: %v", err)
	}
	if got, want := string(body), `{"status":"OK","version":"fixture-version"}`; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestProbeDisablesProxyAndRedirects(t *testing.T) {
	var followed bool
	server := loopbackServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/redirect" {
			response.Header().Set("Location", "/followed")
			response.WriteHeader(http.StatusFound)
			return
		}
		followed = true
		response.WriteHeader(http.StatusOK)
	}))
	t.Setenv("ALL_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("NO_PROXY", "")

	statusCode, _, err := probe(server.URL+"/redirect", 2*time.Second)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if statusCode != http.StatusFound {
		t.Fatalf("status = %d, want %d", statusCode, http.StatusFound)
	}
	if followed {
		t.Fatal("probe followed a redirect")
	}
}

func TestProbeRejectsOversizedResponse(t *testing.T) {
	server := loopbackServer(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write(bytes.Repeat([]byte{'x'}, responseLimit+1))
	}))

	_, _, err := probe(server.URL+"/health", 2*time.Second)
	if err == nil || !strings.Contains(err.Error(), "health response exceeded") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunRejectsUntrustedInput(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "missing arguments", args: []string{"portable-health-probe"}},
		{name: "snapshot arguments", args: []string{"portable-health-probe", "process-snapshot", "123"}},
		{name: "hostname", args: []string{"portable-health-probe", "http://localhost:3000/health", "1000"}},
		{name: "no port", args: []string{"portable-health-probe", "http://127.0.0.1/health", "1000"}},
		{name: "invalid port", args: []string{"portable-health-probe", "http://127.0.0.1:65536/health", "1000"}},
		{name: "credentials", args: []string{"portable-health-probe", "http://user@127.0.0.1:3000/health", "1000"}},
		{name: "fragment", args: []string{"portable-health-probe", "http://127.0.0.1:3000/health#x", "1000"}},
		{name: "zero timeout", args: []string{"portable-health-probe", "http://127.0.0.1:3000/health", "0"}},
		{name: "excessive timeout", args: []string{"portable-health-probe", "http://127.0.0.1:3000/health", "60001"}},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			if exitCode := run(testCase.args, &stdout, &stderr); exitCode == 0 {
				t.Fatalf("run unexpectedly succeeded: %q", stdout.String())
			}
			if stderr.Len() == 0 {
				t.Fatal("run returned no diagnostic")
			}
		})
	}
}

func TestFormatProcessSnapshotProducesCanonicalRows(t *testing.T) {
	output, err := formatProcessSnapshot([]processEntry{
		{processID: 0, parentProcessID: 0},
		{processID: 42, parentProcessID: 7},
		{processID: 99, parentProcessID: 42},
	}, 42)
	if err != nil {
		t.Fatalf("format process snapshot: %v", err)
	}
	if got, want := string(output), "0 0\n42 7\n99 42\n"; got != want {
		t.Fatalf("snapshot = %q, want %q", got, want)
	}
}

func TestFormatProcessSnapshotRejectsIncompleteEvidence(t *testing.T) {
	tests := []struct {
		name    string
		entries []processEntry
		selfPID uint32
	}{
		{name: "empty", selfPID: 42},
		{
			name: "duplicate PID",
			entries: []processEntry{
				{processID: 42, parentProcessID: 7},
				{processID: 42, parentProcessID: 8},
			},
			selfPID: 42,
		},
		{
			name: "helper PID absent",
			entries: []processEntry{
				{processID: 7, parentProcessID: 1},
			},
			selfPID: 42,
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := formatProcessSnapshot(
				testCase.entries,
				testCase.selfPID,
			); err == nil {
				t.Fatal("formatProcessSnapshot unexpectedly succeeded")
			}
		})
	}
}

func loopbackServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	return server
}
