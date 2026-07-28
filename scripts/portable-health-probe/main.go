// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	maxProbeTimeout       = 60 * time.Second
	responseLimit         = 64 * 1024
	maxSnapshotEntries    = 65_536
	maxSnapshotOutputSize = 8 * 1024 * 1024
)

type processEntry struct {
	processID       uint32
	parentProcessID uint32
}

func main() {
	os.Exit(run(os.Args, os.Stdout, os.Stderr))
}

func run(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 2 && args[1] == "process-snapshot" {
		return runProcessSnapshot(stdout, stderr)
	}
	if len(args) != 3 {
		fmt.Fprintln(
			stderr,
			"usage: portable-health-probe <loopback-url> <timeout-ms> | process-snapshot",
		)
		return 2
	}

	timeoutMilliseconds, err := strconv.ParseInt(args[2], 10, 32)
	if err != nil || timeoutMilliseconds < 1 ||
		timeoutMilliseconds > int64(maxProbeTimeout/time.Millisecond) {
		fmt.Fprintln(stderr, "probe timeout must be an integer from 1 to 60000 milliseconds")
		return 2
	}

	statusCode, body, err := probe(args[1], time.Duration(timeoutMilliseconds)*time.Millisecond)
	if err != nil {
		fmt.Fprintf(stderr, "health probe failed: %v\n", err)
		return 1
	}

	if _, err := fmt.Fprintf(
		stdout,
		"%d\n%s",
		statusCode,
		base64.StdEncoding.EncodeToString(body),
	); err != nil {
		fmt.Fprintf(stderr, "write health response: %v\n", err)
		return 1
	}
	return 0
}

func runProcessSnapshot(stdout io.Writer, stderr io.Writer) int {
	entries, err := snapshotProcesses()
	if err != nil {
		fmt.Fprintf(stderr, "process snapshot failed: %v\n", err)
		return 1
	}
	output, err := formatProcessSnapshot(entries, uint32(os.Getpid()))
	if err != nil {
		fmt.Fprintf(stderr, "process snapshot failed: %v\n", err)
		return 1
	}
	if _, err := stdout.Write(output); err != nil {
		fmt.Fprintf(stderr, "write process snapshot: %v\n", err)
		return 1
	}
	return 0
}

func formatProcessSnapshot(entries []processEntry, selfProcessID uint32) ([]byte, error) {
	if len(entries) == 0 {
		return nil, errors.New("process snapshot is empty")
	}
	if len(entries) > maxSnapshotEntries {
		return nil, fmt.Errorf(
			"process snapshot exceeded %d entries",
			maxSnapshotEntries,
		)
	}

	seen := make(map[uint32]struct{}, len(entries))
	selfFound := false
	var output bytes.Buffer
	for _, entry := range entries {
		if _, duplicate := seen[entry.processID]; duplicate {
			return nil, fmt.Errorf(
				"process snapshot contains duplicate PID %d",
				entry.processID,
			)
		}
		seen[entry.processID] = struct{}{}
		if entry.processID == selfProcessID {
			selfFound = true
		}
		if _, err := fmt.Fprintf(
			&output,
			"%d %d\n",
			entry.processID,
			entry.parentProcessID,
		); err != nil {
			return nil, fmt.Errorf("format process snapshot: %w", err)
		}
		if output.Len() > maxSnapshotOutputSize {
			return nil, fmt.Errorf(
				"process snapshot exceeded %d bytes",
				maxSnapshotOutputSize,
			)
		}
	}
	if !selfFound {
		return nil, fmt.Errorf(
			"process snapshot does not contain helper PID %d",
			selfProcessID,
		)
	}
	return output.Bytes(), nil
}

func probe(rawURL string, timeout time.Duration) (int, []byte, error) {
	target, err := validateLoopbackURL(rawURL)
	if err != nil {
		return 0, nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	dialer := &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
	}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           loopbackDialContext(dialer),
		DisableCompression:    true,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          1,
		MaxIdleConnsPerHost:   1,
		ResponseHeaderTimeout: timeout,
		TLSHandshakeTimeout:   timeout,
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return 0, nil, fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Accept", "application/json")

	response, err := client.Do(request)
	if err != nil {
		return 0, nil, fmt.Errorf("request %s: %w", target.Redacted(), err)
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if err != nil {
		return 0, nil, fmt.Errorf("read response: %w", err)
	}
	if len(body) > responseLimit {
		return 0, nil, fmt.Errorf("health response exceeded %d bytes", responseLimit)
	}
	return response.StatusCode, body, nil
}

func validateLoopbackURL(rawURL string) (*url.URL, error) {
	target, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse URL: %w", err)
	}
	if target.Scheme != "http" ||
		target.Hostname() != "127.0.0.1" ||
		target.Port() == "" ||
		target.User != nil ||
		target.Fragment != "" {
		return nil, errors.New("probe requires a plain IPv4 loopback URL with an explicit port")
	}
	if strings.ContainsAny(target.RequestURI(), "\r\n") {
		return nil, errors.New("probe URL contains an invalid request target")
	}
	port, err := strconv.ParseUint(target.Port(), 10, 16)
	if err != nil || port == 0 {
		return nil, errors.New("probe URL contains an invalid port")
	}
	return target, nil
}

func loopbackDialContext(dialer *net.Dialer) func(
	context.Context,
	string,
	string,
) (net.Conn, error) {
	return func(ctx context.Context, _ string, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil || host != "127.0.0.1" {
			return nil, fmt.Errorf("refusing non-loopback dial target %q", address)
		}
		return dialer.DialContext(ctx, "tcp4", address)
	}
}
