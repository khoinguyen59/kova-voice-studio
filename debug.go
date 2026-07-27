package main

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

const maxDebugLogBytes = int64(5 * 1024 * 1024)

// debugLog deliberately records only operational metadata. Request bodies,
// Colab bearer tokens, gateway keys and user scripts must never reach disk.
type debugLog struct {
	mu   sync.Mutex
	path string
	file *os.File
}

func newDebugLog(dataDir string) (*debugLog, *slog.Logger) {
	log := &debugLog{path: filepath.Join(dataDir, "logs", "kova-debug.jsonl")}
	_ = log.open()
	writer := io.MultiWriter(os.Stderr, log)
	return log, slog.New(slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func (log *debugLog) open() error {
	log.mu.Lock()
	defer log.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(log.path), 0700); err != nil {
		return err
	}
	if info, err := os.Stat(log.path); err == nil && info.Size() >= maxDebugLogBytes {
		_ = os.Remove(log.path + ".1")
		_ = os.Rename(log.path, log.path+".1")
	}
	if log.file != nil {
		_ = log.file.Close()
	}
	file, err := os.OpenFile(log.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	log.file = file
	return nil
}

func (log *debugLog) Write(data []byte) (int, error) {
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.file == nil {
		return len(data), nil
	}
	return log.file.Write(data)
}

func (log *debugLog) Close() {
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.file != nil {
		_ = log.file.Close()
		log.file = nil
	}
}
