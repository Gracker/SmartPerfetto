// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x00002000
)

type jobObjectBasicLimitInformation struct {
	perProcessUserTimeLimit int64
	perJobUserTimeLimit     int64
	limitFlags              uint32
	minimumWorkingSetSize   uintptr
	maximumWorkingSetSize   uintptr
	activeProcessLimit      uint32
	affinity                uintptr
	priorityClass           uint32
	schedulingClass         uint32
}

type jobObjectIOCounters struct {
	readOperationCount  uint64
	writeOperationCount uint64
	otherOperationCount uint64
	readTransferCount   uint64
	writeTransferCount  uint64
	otherTransferCount  uint64
}

type jobObjectExtendedLimitInformationValue struct {
	basicLimitInformation jobObjectBasicLimitInformation
	ioInfo                jobObjectIOCounters
	processMemoryLimit    uintptr
	jobMemoryLimit        uintptr
	peakProcessMemoryUsed uintptr
	peakJobMemoryUsed     uintptr
}

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	createJobObjectW             = kernel32.NewProc("CreateJobObjectW")
	setInformationJobObject      = kernel32.NewProc("SetInformationJobObject")
	assignProcessToJobObject     = kernel32.NewProc("AssignProcessToJobObject")
	launcherContainmentJobHandle syscall.Handle
)

func windowsCallError(operation string, callError error) error {
	if errno, ok := callError.(syscall.Errno); ok && errno == 0 {
		return fmt.Errorf("%s failed", operation)
	}
	return fmt.Errorf("%s failed: %w", operation, callError)
}

func establishLauncherContainment() (string, error) {
	job, _, callError := createJobObjectW.Call(0, 0)
	if job == 0 {
		return "", windowsCallError("CreateJobObjectW", callError)
	}
	jobHandle := syscall.Handle(job)
	fail := func(operation string, err error) (string, error) {
		_ = syscall.CloseHandle(jobHandle)
		return "", windowsCallError(operation, err)
	}

	information := jobObjectExtendedLimitInformationValue{}
	information.basicLimitInformation.limitFlags = jobObjectLimitKillOnJobClose
	result, _, callError := setInformationJobObject.Call(
		job,
		jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&information)),
		unsafe.Sizeof(information),
	)
	if result == 0 {
		return fail("SetInformationJobObject", callError)
	}

	currentProcess, err := syscall.GetCurrentProcess()
	if err != nil {
		_ = syscall.CloseHandle(jobHandle)
		return "", fmt.Errorf("GetCurrentProcess failed: %w", err)
	}
	result, _, callError = assignProcessToJobObject.Call(job, uintptr(currentProcess))
	if result == 0 {
		return fail("AssignProcessToJobObject", callError)
	}

	// Keep the job handle open for the launcher's entire lifetime. The operating
	// system closes it during process teardown, which atomically terminates any
	// service descendants that survived normal graceful cleanup.
	launcherContainmentJobHandle = jobHandle
	return "windows-job-object", nil
}
