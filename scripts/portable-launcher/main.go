// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultBackendPort  = "3000"
	defaultFrontendPort = "10000"
	ipv4LoopbackHost    = "127.0.0.1"
	appName             = "SmartPerfetto"
	runtimeProbeTimeout = 10 * time.Second
	runtimeProbeMaxText = 8 * 1024
)

var (
	version                = "dev"
	gitCommit              = ""
	packageTarget          = ""
	signingMode            = "unsigned"
	processContainmentMode = "uninitialized"
	launcherNonInteractive = false
	executablePath         = os.Executable
)

type packageLayout struct {
	packageRoot   string
	resources     string
	nodeExe       string
	traceProc     string
	backendRoot   string
	frontendRoot  string
	backendEntry  string
	frontendEntry string
}

type runtimeDirs struct {
	dataDir string
	logsDir string
}

type serviceProcess struct {
	name         string
	cmd          *exec.Cmd
	log          *os.File
	logPath      string
	shutdownFile string
	done         chan struct{}
	mu           sync.RWMutex
	result       processResult
}

type portSetting struct {
	value    string
	envKey   string
	explicit bool
}

type launcherShutdownRequested struct {
	reason string
}

func (request launcherShutdownRequested) Error() string {
	return "launcher shutdown requested: " + request.reason
}

func resolveServicePorts() (string, string, error) {
	backend, err := resolvePortSetting("SMARTPERFETTO_BACKEND_PORT", "PORT", defaultBackendPort)
	if err != nil {
		return "", "", err
	}
	frontend, err := resolvePortSetting("SMARTPERFETTO_FRONTEND_PORT", "", defaultFrontendPort)
	if err != nil {
		return "", "", err
	}
	if backend.value == frontend.value {
		if backend.explicit && frontend.explicit {
			return "", "", fmt.Errorf("backend and frontend ports must be different (both are %s)", backend.value)
		}
		if !frontend.explicit {
			port, err := resolveAvailablePort("frontend", frontend, map[string]bool{backend.value: true})
			if err != nil {
				return "", "", err
			}
			frontend.value = port
		} else {
			port, err := resolveAvailablePort("backend", backend, map[string]bool{frontend.value: true})
			if err != nil {
				return "", "", err
			}
			backend.value = port
		}
	}
	backendPort, err := resolveAvailablePort("backend", backend, map[string]bool{frontend.value: true})
	if err != nil {
		return "", "", err
	}
	frontendPort, err := resolveAvailablePort("frontend", frontend, map[string]bool{backendPort: true})
	if err != nil {
		return "", "", err
	}
	return backendPort, frontendPort, nil
}

func resolvePortSetting(primaryKey string, fallbackKey string, defaultValue string) (portSetting, error) {
	value := os.Getenv(primaryKey)
	key := primaryKey
	explicit := value != ""
	if value == "" && fallbackKey != "" {
		value = os.Getenv(fallbackKey)
		key = fallbackKey
		explicit = value != ""
	}
	if value == "" {
		value = defaultValue
		key = primaryKey
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 || parsed > 65535 {
		return portSetting{}, fmt.Errorf("%s must be a TCP port in the range 1..65535, got %q", key, value)
	}
	return portSetting{value: strconv.Itoa(parsed), envKey: key, explicit: explicit}, nil
}

func resolveAvailablePort(serviceName string, setting portSetting, reserved map[string]bool) (string, error) {
	if !reserved[setting.value] && isPortAvailable(setting.value) {
		return setting.value, nil
	}
	if setting.explicit {
		return "", fmt.Errorf(
			"%s port %s is already in use or unavailable. Close the existing SmartPerfetto process, or set %s to a free port before launching",
			serviceName, setting.value, setting.envKey,
		)
	}
	port, err := findAvailablePort(setting.value, reserved)
	if err != nil {
		return "", fmt.Errorf("%s default port %s is unavailable and no fallback port could be found: %w", serviceName, setting.value, err)
	}
	fmt.Printf("%s default port %s is unavailable; using %s instead.\n", serviceName, setting.value, port)
	return port, nil
}

func findAvailablePort(preferred string, reserved map[string]bool) (string, error) {
	start, err := strconv.Atoi(preferred)
	if err != nil {
		return "", err
	}
	for port := start + 1; port <= 65535; port++ {
		candidate := strconv.Itoa(port)
		if reserved[candidate] || !isPortAvailable(candidate) {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("exhausted TCP port range above %s", preferred)
}

func isPortAvailable(port string) bool {
	listener, err := net.Listen("tcp4", net.JoinHostPort(ipv4LoopbackHost, port))
	if err != nil {
		return false
	}
	return listener.Close() == nil
}

func main() {
	args := os.Args[1:]
	launcherNonInteractive = argumentsRequestNonInteractive(args)
	options, err := parseLaunchOptions(args)
	if err != nil {
		fatal(err)
	}
	launcherNonInteractive = options.nonInteractive
	if err := validateLaunchControlPaths(options); err != nil {
		fatal(err)
	}
	if err := runLauncher(options); err != nil {
		fatal(err)
	}
}

func runLauncher(options launchOptions) (runErr error) {
	containmentMode, err := establishLauncherContainment()
	if err != nil {
		return fmt.Errorf("establish process containment: %w", err)
	}
	processContainmentMode = containmentMode

	backendPort, frontendPort, err := resolveServicePorts()
	if err != nil {
		return err
	}

	layout, err := resolveLayout()
	if err != nil {
		return err
	}

	for _, required := range []string{layout.nodeExe, layout.traceProc, layout.backendEntry, layout.frontendEntry} {
		if _, err := os.Stat(required); err != nil {
			return fmt.Errorf("required runtime file is missing: %s", required)
		}
	}
	nodeVersion, err := probeRuntimeVersion(
		"bundled Node.js",
		layout.nodeExe,
		runtimeProbeTimeout,
		"--version",
	)
	if err != nil {
		return err
	}

	dirs, err := resolveRuntimeDirs(layout.packageRoot)
	if err != nil {
		return err
	}
	if err := migrateLegacyWindowsData(layout.packageRoot, dirs.dataDir, options); err != nil {
		return err
	}
	for _, dir := range []string{
		dirs.dataDir,
		dirs.logsDir,
		filepath.Join(dirs.dataDir, "uploads"),
		filepath.Join(dirs.dataDir, "backend"),
		filepath.Join(dirs.dataDir, "providers"),
		filepath.Join(dirs.dataDir, "user"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	controlDir, err := os.MkdirTemp(dirs.logsDir, ".launcher-control-")
	if err != nil {
		return fmt.Errorf("create private launcher control directory: %w", err)
	}
	defer os.RemoveAll(controlDir)
	backendShutdownFile := filepath.Join(controlDir, "backend.shutdown")
	frontendShutdownFile := filepath.Join(controlDir, "frontend.shutdown")
	shutdownRequests := make(chan string, 1)
	controlStop := make(chan struct{})
	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		select {
		case signalValue := <-signalCh:
			select {
			case shutdownRequests <- "signal:" + signalValue.String():
			default:
			}
		case <-controlStop:
		}
	}()
	if options.shutdownFile != "" {
		shutdownFileReady := make(chan struct{}, 1)
		go waitForShutdownFile(options.shutdownFile, shutdownFileReady, controlStop)
		go func() {
			select {
			case <-shutdownFileReady:
				select {
				case shutdownRequests <- "shutdown-file":
				default:
				}
			case <-controlStop:
			}
		}()
	}
	defer func() {
		signal.Stop(signalCh)
		close(controlStop)
	}()

	fmt.Printf("%s launcher\n", appName)
	fmt.Printf("Version: %s\n", version)
	fmt.Printf("Package directory: %s\n", layout.packageRoot)
	fmt.Printf("Data directory: %s\n", dirs.dataDir)
	fmt.Printf("Logs directory: %s\n", dirs.logsDir)
	fmt.Printf("Bundled Node.js: %s\n", nodeVersion)
	frontendURL := loopbackHTTPURL(frontendPort, "")
	backendURL := loopbackHTTPURL(backendPort, "")
	fmt.Printf("Frontend: %s\n", frontendURL)
	fmt.Printf("Backend:  %s\n", backendURL)
	fmt.Println()

	envPath := envFilePath(dirs.dataDir)
	if _, err := os.Stat(envPath); err != nil {
		fmt.Println("No user env file found. The UI can still open, but AI analysis needs a Provider profile or env credentials.")
		fmt.Printf("To use env credentials, create %s and restart %s.\n", envPath, launcherName())
		fmt.Println()
	}

	baseEnv := append([]string{}, os.Environ()...)
	pathEnv := fmt.Sprintf("%s%c%s", nodeBinDir(layout.nodeExe), os.PathListSeparator, os.Getenv("PATH"))
	backendDataDir := filepath.Join(dirs.dataDir, "backend")

	backendEnv := mergeEnv(baseEnv, map[string]string{
		"NODE_ENV":                          "production",
		"PORT":                              backendPort,
		"SMARTPERFETTO_BACKEND_PORT":        backendPort,
		"SMARTPERFETTO_BIND_HOST":           ipv4LoopbackHost,
		"SMARTPERFETTO_FRONTEND_PORT":       frontendPort,
		"SMARTPERFETTO_BACKEND_PUBLIC_PORT": envOrDefault("SMARTPERFETTO_BACKEND_PUBLIC_PORT", backendPort),
		"SMARTPERFETTO_BACKEND_PUBLIC_URL":  os.Getenv("SMARTPERFETTO_BACKEND_PUBLIC_URL"),
		"SMARTPERFETTO_LOCK_SERVICE_PORTS":  "1",
		"PATH":                              pathEnv,
		"TRACE_PROCESSOR_PATH":              layout.traceProc,
		"SMARTPERFETTO_PACKAGE":             "1",
		"SMARTPERFETTO_DISTRIBUTION":        "portable",
		"SMARTPERFETTO_UPDATE_CHANNEL":      "stable",
		"SMARTPERFETTO_BUILD_COMMIT":        gitCommit,
		"SMARTPERFETTO_PACKAGE_TARGET":      packageTarget,
		"SMARTPERFETTO_SIGNING_MODE":        signingMode,
		"SMARTPERFETTO_PACKAGE_TARGET_OS":   runtime.GOOS,
		"SMARTPERFETTO_PACKAGE_TARGET_ARCH": runtime.GOARCH,
		"SMARTPERFETTO_OUTPUT_LANGUAGE":     envOrDefault("SMARTPERFETTO_OUTPUT_LANGUAGE", "zh-CN"),
		"SMARTPERFETTO_ENV_FILE":            envPath,
		"SMARTPERFETTO_HOME":                filepath.Join(dirs.dataDir, "user"),
		"SMARTPERFETTO_BACKEND_DATA_DIR":    backendDataDir,
		"SMARTPERFETTO_BACKEND_LOG_DIR":     dirs.logsDir,
		"UPLOAD_DIR":                        filepath.Join(dirs.dataDir, "uploads"),
		"PROVIDER_DATA_DIR_OVERRIDE":        filepath.Join(dirs.dataDir, "providers"),
		"SCENE_REPORT_DIR":                  filepath.Join(backendDataDir, "scene-reports"),
		"TRACE_PROCESSOR_DOWNLOAD_BASE":     os.Getenv("TRACE_PROCESSOR_DOWNLOAD_BASE"),
		"TRACE_PROCESSOR_DOWNLOAD_URL":      os.Getenv("TRACE_PROCESSOR_DOWNLOAD_URL"),
		"SMARTPERFETTO_AGENT_RUNTIME":       os.Getenv("SMARTPERFETTO_AGENT_RUNTIME"),
		"SMARTPERFETTO_API_KEY":             os.Getenv("SMARTPERFETTO_API_KEY"),
		"SMARTPERFETTO_SHUTDOWN_FILE":       backendShutdownFile,
	})
	frontendEnv := mergeEnv(baseEnv, map[string]string{
		"PORT":                              frontendPort,
		"SMARTPERFETTO_BACKEND_PORT":        backendPort,
		"SMARTPERFETTO_FRONTEND_PORT":       frontendPort,
		"SMARTPERFETTO_FRONTEND_BIND_HOST":  ipv4LoopbackHost,
		"SMARTPERFETTO_BACKEND_PUBLIC_PORT": envOrDefault("SMARTPERFETTO_BACKEND_PUBLIC_PORT", backendPort),
		"SMARTPERFETTO_BACKEND_PUBLIC_URL":  os.Getenv("SMARTPERFETTO_BACKEND_PUBLIC_URL"),
		"PATH":                              pathEnv,
		"SMARTPERFETTO_SHUTDOWN_FILE":       frontendShutdownFile,
	})

	var backend *serviceProcess
	var frontend *serviceProcess
	exitReason := "startup-error"
	expectedShutdown := false
	cleanupArmed := false
	defer func() {
		if !cleanupArmed {
			return
		}
		frontendStop := stopService(frontend)
		backendStop := stopService(backend)
		frontend.closeLog()
		backend.closeLog()
		portsReleased := waitForPortsReleased(backendPort, frontendPort, portReleaseTimeout)
		success := expectedShutdown &&
			serviceStoppedSuccessfully(frontend, frontendStop) &&
			serviceStoppedSuccessfully(backend, backendStop) &&
			portsReleased
		receipt := lifecycleReceiptFor(
			exitReason,
			success,
			backendPort,
			frontendPort,
			portsReleased,
			backend,
			backendStop,
			frontend,
			frontendStop,
		)
		if err := writeLifecycleReceipt(options.lifecycleReceipt, receipt); err != nil {
			if runErr == nil {
				runErr = err
			}
			return
		}
		if !success && runErr == nil {
			runErr = fmt.Errorf(
				"launcher lifecycle failed; inspect backend.log, frontend.log, and the lifecycle receipt",
			)
		}
		if success {
			fmt.Println("SmartPerfetto stopped.")
		}
	}()

	backend, err = startService("backend", layout.nodeExe, []string{layout.backendEntry}, layout.backendRoot, backendEnv, dirs.logsDir)
	if err != nil {
		return err
	}
	cleanupArmed = true
	backend.shutdownFile = backendShutdownFile

	if err := waitForServiceHealthOrShutdown(
		backend,
		loopbackHTTPURL(backendPort, "/health"),
		90*time.Second,
		healthExpectation{status: "OK", version: version},
		shutdownRequests,
	); err != nil {
		var requested launcherShutdownRequested
		if errors.As(err, &requested) {
			exitReason = requested.reason
			expectedShutdown = true
			return nil
		}
		exitReason = "startup-error:backend-readiness"
		return fmt.Errorf("backend did not become ready: %w", err)
	}

	frontend, err = startService("frontend", layout.nodeExe, []string{layout.frontendEntry}, layout.frontendRoot, frontendEnv, dirs.logsDir)
	if err != nil {
		exitReason = "startup-error:frontend-start"
		return err
	}
	frontend.shutdownFile = frontendShutdownFile

	if err := waitForServiceHealthOrShutdown(
		frontend,
		loopbackHTTPURL(frontendPort, "/health"),
		45*time.Second,
		healthExpectation{status: "OK"},
		shutdownRequests,
	); err != nil {
		var requested launcherShutdownRequested
		if errors.As(err, &requested) {
			exitReason = requested.reason
			expectedShutdown = true
			return nil
		}
		exitReason = "startup-error:frontend-readiness"
		return fmt.Errorf("frontend did not become ready: %w", err)
	}

	fmt.Println()
	fmt.Println("SmartPerfetto is running.")
	fmt.Printf("Open: %s\n", frontendURL)
	fmt.Println("Keep this launcher running while using SmartPerfetto.")
	fmt.Println()
	if !options.nonInteractive {
		_ = openBrowser(frontendURL)
	}

	exitCh := make(chan serviceExit, 2)
	go waitForService(backend, exitCh)
	go waitForService(frontend, exitCh)

	select {
	case reason := <-shutdownRequests:
		exitReason = reason
		expectedShutdown = true
		fmt.Printf("\nReceived %s, stopping SmartPerfetto...\n", reason)
	case exited := <-exitCh:
		exitReason = "service-exit:" + exited.name
		expectedShutdown = false
		fmt.Printf(
			"\n%s exited unexpectedly (code %d); stopping SmartPerfetto...\n",
			exited.name,
			exited.result.ExitCode,
		)
	}
	return nil
}

func resolveLayout() (packageLayout, error) {
	exe, err := executablePath()
	if err != nil {
		return packageLayout{}, err
	}
	exeDir, err := filepath.Abs(filepath.Dir(exe))
	if err != nil {
		return packageLayout{}, err
	}

	packageRoot := exeDir
	resources := exeDir
	if runtime.GOOS == "darwin" && filepath.Base(exeDir) == "MacOS" && filepath.Base(filepath.Dir(exeDir)) == "Contents" {
		contentsDir := filepath.Dir(exeDir)
		packageRoot = filepath.Dir(contentsDir)
		resources = filepath.Join(contentsDir, "Resources")
	}

	nodeExe := filepath.Join(resources, "runtime", "node", "bin", "node")
	traceProc := filepath.Join(resources, "bin", "trace_processor_shell")
	if runtime.GOOS == "windows" {
		nodeExe = filepath.Join(resources, "runtime", "node", "node.exe")
		traceProc = filepath.Join(resources, "bin", "trace_processor_shell.exe")
	}

	backendRoot := filepath.Join(resources, "backend")
	frontendRoot := filepath.Join(resources, "frontend")
	return packageLayout{
		packageRoot:   packageRoot,
		resources:     resources,
		nodeExe:       nodeExe,
		traceProc:     traceProc,
		backendRoot:   backendRoot,
		frontendRoot:  frontendRoot,
		backendEntry:  filepath.Join(backendRoot, "dist", "index.js"),
		frontendEntry: filepath.Join(frontendRoot, "server.js"),
	}, nil
}

func envFilePath(dataDir string) string {
	if value := os.Getenv("SMARTPERFETTO_ENV_FILE"); value != "" {
		return value
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(dataDir, "env")
	}
	return filepath.Join(dataDir, "env")
}

func nodeBinDir(nodeExe string) string {
	return filepath.Dir(nodeExe)
}

func loopbackHTTPURL(port string, requestPath string) string {
	return "http://" + net.JoinHostPort(ipv4LoopbackHost, port) + requestPath
}

func launcherName() string {
	if runtime.GOOS == "windows" {
		return "SmartPerfetto.exe"
	}
	if runtime.GOOS == "darwin" {
		return "SmartPerfetto.app"
	}
	return "SmartPerfetto"
}

func probeRuntimeVersion(
	label string,
	executable string,
	timeout time.Duration,
	args ...string,
) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	output := &limitedRuntimeProbeOutput{}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Stdout = output
	cmd.Stderr = output
	err := cmd.Run()
	versionOutput := strings.TrimSpace(output.String())
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf(
			"%s runtime self-check timed out after %s: %s",
			label,
			timeout,
			executable,
		)
	}
	if err != nil {
		if versionOutput == "" {
			return "", fmt.Errorf(
				"%s runtime self-check failed for %s: %w",
				label,
				executable,
				err,
			)
		}
		return "", fmt.Errorf(
			"%s runtime self-check failed for %s: %w: %s",
			label,
			executable,
			err,
			versionOutput,
		)
	}
	if versionOutput == "" {
		return "", fmt.Errorf(
			"%s runtime self-check returned no version output: %s",
			label,
			executable,
		)
	}
	return versionOutput, nil
}

type limitedRuntimeProbeOutput struct {
	mu        sync.Mutex
	text      []byte
	truncated bool
}

func (output *limitedRuntimeProbeOutput) Write(content []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()

	remaining := runtimeProbeMaxText - len(output.text)
	if remaining > 0 {
		kept := len(content)
		if kept > remaining {
			kept = remaining
		}
		output.text = append(output.text, content[:kept]...)
	}
	if len(content) > remaining {
		output.truncated = true
	}
	return len(content), nil
}

func (output *limitedRuntimeProbeOutput) String() string {
	output.mu.Lock()
	defer output.mu.Unlock()

	text := string(output.text)
	if output.truncated {
		text += "\n...[runtime output truncated]"
	}
	return text
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
	configureServiceCommand(cmd)

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

	proc := &serviceProcess{
		name:    name,
		cmd:     cmd,
		log:     logFile,
		logPath: logPath,
		done:    make(chan struct{}),
	}
	go func() {
		proc.recordResult(cmd.Wait())
	}()

	fmt.Printf("Started %s (PID %d), log: %s\n", name, cmd.Process.Pid, logPath)
	return proc, nil
}

func copyPrefixedOutput(prefix string, reader io.Reader, writer io.Writer) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		fmt.Fprintf(writer, "[%s] %s\n", strings.ToUpper(prefix), scanner.Text())
	}
}

func waitForHTTP(url string, timeout time.Duration) error {
	return waitForHealth(url, timeout, healthExpectation{})
}

type healthExpectation struct {
	status  string
	version string
}

func waitForHealth(url string, timeout time.Duration, expectation healthExpectation) error {
	return waitForHealthOrExit(nil, url, timeout, expectation, nil)
}

func waitForServiceHealth(
	proc *serviceProcess,
	url string,
	timeout time.Duration,
	expectation healthExpectation,
) error {
	return waitForHealthOrExit(proc, url, timeout, expectation, nil)
}

func waitForServiceHealthOrShutdown(
	proc *serviceProcess,
	url string,
	timeout time.Duration,
	expectation healthExpectation,
	shutdown <-chan string,
) error {
	return waitForHealthOrExit(proc, url, timeout, expectation, shutdown)
}

func waitForHealthOrExit(
	proc *serviceProcess,
	url string,
	timeout time.Duration,
	expectation healthExpectation,
	shutdown <-chan string,
) error {
	deadline := time.Now().Add(timeout)
	client := http.Client{
		Timeout: 2 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	var lastErr error

	for time.Now().Before(deadline) {
		if err := readinessShutdownError(shutdown); err != nil {
			return err
		}
		if err := readinessExitError(proc); err != nil {
			return err
		}
		resp, err := client.Get(url)
		if err == nil {
			var payload struct {
				Status  string `json:"status"`
				Version string `json:"version"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&payload)
			closeErr := resp.Body.Close()
			if resp.StatusCode >= 200 &&
				resp.StatusCode < 300 &&
				decodeErr == nil &&
				closeErr == nil &&
				(expectation.status == "" || payload.Status == expectation.status) &&
				(expectation.version == "" || payload.Version == expectation.version) {
				return nil
			}
			lastErr = fmt.Errorf(
				"HTTP %d health payload status=%q version=%q decode=%v",
				resp.StatusCode,
				payload.Status,
				payload.Version,
				decodeErr,
			)
		} else {
			lastErr = err
		}
		if err := waitForHealthRetry(proc, time.Second, shutdown); err != nil {
			return err
		}
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("timed out")
	}
	if proc != nil && proc.logPath != "" {
		return fmt.Errorf("%w; inspect log: %s", lastErr, proc.logPath)
	}
	return lastErr
}

func readinessShutdownError(shutdown <-chan string) error {
	if shutdown == nil {
		return nil
	}
	select {
	case reason := <-shutdown:
		return launcherShutdownRequested{reason: reason}
	default:
		return nil
	}
}

func readinessExitError(proc *serviceProcess) error {
	if proc == nil {
		return nil
	}
	select {
	case <-proc.done:
		result := proc.currentResult()
		logHint := ""
		if proc.logPath != "" {
			logHint = "; inspect log: " + proc.logPath
		}
		if result.Error != "" {
			return fmt.Errorf(
				"%s exited before readiness (code %d): %s%s",
				proc.name,
				result.ExitCode,
				result.Error,
				logHint,
			)
		}
		return fmt.Errorf(
			"%s exited before readiness (code %d)%s",
			proc.name,
			result.ExitCode,
			logHint,
		)
	default:
		return nil
	}
}

func waitForHealthRetry(
	proc *serviceProcess,
	delay time.Duration,
	shutdown <-chan string,
) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	if proc == nil {
		select {
		case reason := <-shutdown:
			return launcherShutdownRequested{reason: reason}
		case <-timer.C:
			return nil
		}
	}
	select {
	case <-proc.done:
		return readinessExitError(proc)
	case reason := <-shutdown:
		return launcherShutdownRequested{reason: reason}
	case <-timer.C:
		return nil
	}
}

func (proc *serviceProcess) closeLog() {
	if proc != nil && proc.log != nil {
		_ = proc.log.Close()
	}
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
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
	message := fmt.Sprintf("ERROR: %v", err)
	fmt.Fprintln(os.Stderr, message)
	if launcherNonInteractive {
		os.Exit(1)
	}
	if runtime.GOOS == "darwin" {
		_ = exec.Command("osascript", "-e", fmt.Sprintf(`display alert "SmartPerfetto failed" message %q`, message)).Run()
	} else if runtime.GOOS == "windows" {
		fmt.Fprintln(os.Stderr, "Press Enter to exit.")
		_, _ = fmt.Fscanln(os.Stdin)
	}
	os.Exit(1)
}
