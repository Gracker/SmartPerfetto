// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestResolveServicePortsFallsBackWhenDefaultFrontendPortIsBusy(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("SMARTPERFETTO_BACKEND_PORT", "")
	t.Setenv("SMARTPERFETTO_FRONTEND_PORT", "")

	listener, err := net.Listen("tcp", ":"+defaultFrontendPort)
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

func TestWaitForHTTPConnectsToIPv4OnlyListener(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on IPv4 loopback: %v", err)
	}

	server := &http.Server{
		Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusOK)
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

func reserveTestPort(t *testing.T) (net.Listener, string) {
	t.Helper()
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("reserve test port: %v", err)
	}
	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("expected TCP address, got %T", listener.Addr())
	}
	return listener, strconv.Itoa(tcpAddr.Port)
}
