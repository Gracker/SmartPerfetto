// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const (
	gracefulShutdownTimeout = 15 * time.Second
	forcedShutdownTimeout   = 5 * time.Second
	portReleaseTimeout      = 10 * time.Second
)

type processResult struct {
	ExitCode int    `json:"exitCode"`
	Success  bool   `json:"success"`
	Error    string `json:"error,omitempty"`
}

type serviceExit struct {
	name   string
	result processResult
}

type serviceLifecycleReceipt struct {
	Name              string        `json:"name"`
	PID               int           `json:"pid"`
	GracefulRequested bool          `json:"gracefulRequested"`
	Escalated         bool          `json:"escalated"`
	ShutdownError     string        `json:"shutdownError,omitempty"`
	Result            processResult `json:"result"`
}

type portLifecycleReceipt struct {
	Backend  int  `json:"backend"`
	Frontend int  `json:"frontend"`
	Released bool `json:"released"`
}

type lifecycleReceipt struct {
	SchemaVersion int                       `json:"schemaVersion"`
	Version       string                    `json:"version"`
	GitCommit     string                    `json:"gitCommit"`
	PackageTarget string                    `json:"packageTarget"`
	Containment   string                    `json:"containment"`
	ExitReason    string                    `json:"exitReason"`
	Success       bool                      `json:"success"`
	Ports         portLifecycleReceipt      `json:"ports"`
	Services      []serviceLifecycleReceipt `json:"services"`
	FinishedAt    string                    `json:"finishedAt"`
}

type serviceStopResult struct {
	gracefulRequested bool
	escalated         bool
	shutdownError     string
	result            processResult
}

func (proc *serviceProcess) recordResult(err error) {
	result := processResult{
		ExitCode: proc.cmd.ProcessState.ExitCode(),
		Success:  err == nil && proc.cmd.ProcessState.Success(),
	}
	if err != nil {
		result.Error = err.Error()
	}
	proc.mu.Lock()
	proc.result = result
	proc.mu.Unlock()
	close(proc.done)
}

func (proc *serviceProcess) currentResult() processResult {
	proc.mu.RLock()
	defer proc.mu.RUnlock()
	return proc.result
}

func waitForService(proc *serviceProcess, exitCh chan<- serviceExit) {
	<-proc.done
	exitCh <- serviceExit{name: proc.name, result: proc.currentResult()}
}

func waitForServiceTimeout(proc *serviceProcess, timeout time.Duration) bool {
	if proc == nil {
		return true
	}
	if timeout <= 0 {
		select {
		case <-proc.done:
			return true
		default:
			return false
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-proc.done:
		return true
	case <-timer.C:
		return false
	}
}

func stopService(proc *serviceProcess) serviceStopResult {
	if proc == nil {
		return serviceStopResult{result: processResult{ExitCode: 0, Success: true}}
	}
	if waitForServiceTimeout(proc, 0) {
		return serviceStopResult{result: proc.currentResult()}
	}

	result := serviceStopResult{gracefulRequested: true}
	if err := writeShutdownRequest(proc.shutdownFile); err != nil {
		result.shutdownError = err.Error()
	}
	if result.shutdownError == "" && waitForServiceTimeout(proc, gracefulShutdownTimeout) {
		result.result = proc.currentResult()
		return result
	}

	result.escalated = true
	if err := forceStopService(proc); err != nil && result.shutdownError == "" {
		result.shutdownError = err.Error()
	}
	if !waitForServiceTimeout(proc, forcedShutdownTimeout) {
		if result.shutdownError == "" {
			result.shutdownError = fmt.Sprintf("%s did not exit after forced shutdown", proc.name)
		}
		result.result = processResult{
			ExitCode: -1,
			Success:  false,
			Error:    result.shutdownError,
		}
		return result
	}
	result.result = proc.currentResult()
	return result
}

func serviceStoppedSuccessfully(proc *serviceProcess, stopped serviceStopResult) bool {
	if proc == nil {
		return true
	}
	return stopped.result.Success &&
		!stopped.escalated &&
		stopped.shutdownError == ""
}

func writeShutdownRequest(path string) error {
	if path == "" {
		return fmt.Errorf("no private shutdown path configured")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("request graceful shutdown through %s: %w", path, err)
	}
	if _, err := file.WriteString("shutdown\n"); err != nil {
		_ = file.Close()
		return fmt.Errorf("write graceful shutdown request: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close graceful shutdown request: %w", err)
	}
	return nil
}

func waitForShutdownFile(path string, ready chan<- struct{}, stop <-chan struct{}) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() {
				select {
				case ready <- struct{}{}:
				default:
				}
				return
			}
		}
	}
}

func waitForPortsReleased(backendPort string, frontendPort string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if portReleased(backendPort) && portReleased(frontendPort) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return portReleased(backendPort) && portReleased(frontendPort)
}

func portReleased(port string) bool {
	listener, err := net.Listen("tcp4", net.JoinHostPort(ipv4LoopbackHost, port))
	if err != nil {
		return false
	}
	return listener.Close() == nil
}

func buildServiceReceipt(proc *serviceProcess, stopped serviceStopResult) serviceLifecycleReceipt {
	name := ""
	pid := 0
	if proc != nil {
		name = proc.name
		if proc.cmd != nil && proc.cmd.Process != nil {
			pid = proc.cmd.Process.Pid
		}
	}
	return serviceLifecycleReceipt{
		Name:              name,
		PID:               pid,
		GracefulRequested: stopped.gracefulRequested,
		Escalated:         stopped.escalated,
		ShutdownError:     stopped.shutdownError,
		Result:            stopped.result,
	}
}

func writeLifecycleReceipt(path string, receipt lifecycleReceipt) error {
	if path == "" {
		return nil
	}
	payload, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		return fmt.Errorf("encode lifecycle receipt: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".smartperfetto-lifecycle-*.json")
	if err != nil {
		return fmt.Errorf("create lifecycle receipt: %w", err)
	}
	temporaryPath := temporary.Name()
	removeTemporary := true
	defer func() {
		_ = temporary.Close()
		if removeTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("secure lifecycle receipt: %w", err)
	}
	if _, err := temporary.Write(append(payload, '\n')); err != nil {
		return fmt.Errorf("write lifecycle receipt: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync lifecycle receipt: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close lifecycle receipt: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("activate lifecycle receipt: %w", err)
	}
	removeTemporary = false
	return nil
}

func lifecycleReceiptFor(
	reason string,
	success bool,
	backendPort string,
	frontendPort string,
	portsReleased bool,
	backend *serviceProcess,
	backendStop serviceStopResult,
	frontend *serviceProcess,
	frontendStop serviceStopResult,
) lifecycleReceipt {
	backendPortNumber, _ := parsePortNumber(backendPort)
	frontendPortNumber, _ := parsePortNumber(frontendPort)
	services := make([]serviceLifecycleReceipt, 0, 2)
	if backend != nil {
		services = append(services, buildServiceReceipt(backend, backendStop))
	}
	if frontend != nil {
		services = append(services, buildServiceReceipt(frontend, frontendStop))
	}
	return lifecycleReceipt{
		SchemaVersion: 2,
		Version:       version,
		GitCommit:     gitCommit,
		PackageTarget: packageTarget,
		Containment:   processContainmentMode,
		ExitReason:    reason,
		Success:       success,
		Ports: portLifecycleReceipt{
			Backend:  backendPortNumber,
			Frontend: frontendPortNumber,
			Released: portsReleased,
		},
		Services:   services,
		FinishedAt: time.Now().UTC().Format(time.RFC3339),
	}
}

func parsePortNumber(value string) (int, error) {
	return strconv.Atoi(value)
}
