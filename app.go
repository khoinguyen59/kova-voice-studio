package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ledongthuc/pdf"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows/registry"
)

const (
	voiceStudioNotebookURL = "https://colab.research.google.com/github/khoinguyen59/kova-video-dubbing/blob/main/voice-studio/notebooks/Kova_Voice_Studio_GPU.ipynb"
	maxReferenceBytes      = int64(64 * 1024 * 1024)
	maxGenerationBytes     = int64(32 * 1024 * 1024)
	maxDocumentBytes       = int64(12 * 1024 * 1024)
	previewSentenceVI      = "Xin chào, rất vui được gặp bạn, hẹn gặp lại."
)

var safeFileName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// App is an independent desktop client for the user-controlled KOVA Voice
// Studio GPU worker. It owns a private local profile backup/history library;
// the Colab token is intentionally session-only and never written to disk.
type App struct {
	ctx    context.Context
	client *http.Client
	mu     sync.Mutex
	state  studioState
	loaded bool
}

type studioState struct {
	Version         int                 `json:"version"`
	Theme           string              `json:"theme"`
	Locale          string              `json:"locale"`
	WorkerURL       string              `json:"worker_url,omitempty"`
	SelectedVoiceID string              `json:"selected_voice_id,omitempty"`
	Voices          []VoiceProfile      `json:"voices"`
	History         []GenerationHistory `json:"history"`
}

type StudioBootstrap struct {
	AppName         string              `json:"app_name"`
	Version         string              `json:"version"`
	NotebookURL     string              `json:"notebook_url"`
	Theme           string              `json:"theme"`
	Locale          string              `json:"locale"`
	WorkerURL       string              `json:"worker_url"`
	SelectedVoiceID string              `json:"selected_voice_id"`
	Voices          []VoiceProfile      `json:"voices"`
	History         []GenerationHistory `json:"history"`
	DemoVoices      []DemoVoice         `json:"demo_voices"`
}

type WorkerSession struct {
	BaseURL string `json:"base_url"`
	Token   string `json:"token"`
}

type WorkerHealth struct {
	Reachable bool   `json:"reachable"`
	Message   string `json:"message"`
	Device    string `json:"device,omitempty"`
}

// PairingSession is obtained from a single-use Colab pairing link. The token
// is returned only to the renderer's current memory and is never persisted.
type PairingSession struct {
	WorkerURL string `json:"worker_url"`
	Token     string `json:"token"`
	Message   string `json:"message"`
}

// TaskProgress is emitted to the desktop renderer for clone, preview, and
// generation tasks. The duration is measured locally; percentages represent
// completed protocol stages and never pretend to be GPU token-level metrics.
type TaskProgress struct {
	Task      string `json:"task"`
	Phase     string `json:"phase"`
	Percent   int    `json:"percent"`
	StartedAt string `json:"started_at"`
	UpdatedAt string `json:"updated_at"`
	ElapsedMS int64  `json:"elapsed_ms"`
	Message   string `json:"message"`
	Status    string `json:"status"`
}

type taskReporter struct {
	app     *App
	task    string
	started time.Time
}

func (a *App) startTask(task, message string) *taskReporter {
	reporter := &taskReporter{app: a, task: task, started: time.Now()}
	reporter.update("starting", 1, message, "running")
	return reporter
}

func (r *taskReporter) update(phase string, percent int, message, status string) {
	if r == nil || r.app == nil || r.app.ctx == nil {
		return
	}
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	now := time.Now()
	runtime.EventsEmit(r.app.ctx, "kova:voice-progress", TaskProgress{
		Task: r.task, Phase: phase, Percent: percent, StartedAt: r.started.UTC().Format(time.RFC3339Nano),
		UpdatedAt: now.UTC().Format(time.RFC3339Nano), ElapsedMS: now.Sub(r.started).Milliseconds(),
		Message: message, Status: status,
	})
}

func (r *taskReporter) done(message string) { r.update("complete", 100, message, "complete") }
func (r *taskReporter) fail(message string) { r.update("failed", 100, message, "failed") }

// VoiceProfile never exposes a reference path to the UI. ReferenceFile is a
// filename relative to the private application data directory.
type VoiceProfile struct {
	ID       string `json:"id"`
	RemoteID string `json:"remote_id"`
	Name     string `json:"name"`
	Language string `json:"language"`
	Status   string `json:"status"`
	Kind     string `json:"kind"`
	// ReferenceFile is deliberately only a basename inside the application's
	// private references directory.  Persisting this basename is what lets a
	// saved clone survive an app restart and lets KOVA restore it after a Colab
	// runtime expires.  It is never exposed through a public file picker.
	ReferenceFile   string `json:"reference_file,omitempty"`
	BackupAvailable bool   `json:"backup_available"`
	WorkerURL       string `json:"worker_url,omitempty"`
	CreatedAt       string `json:"created_at"`
	ReferenceClean  bool   `json:"reference_clean"`
}

type DemoVoice struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Language string  `json:"language"`
	Accent   string  `json:"accent"`
	Rate     float64 `json:"rate"`
	Pitch    float64 `json:"pitch"`
	Sample   string  `json:"sample"`
}

type VoiceCreateRequest struct {
	WorkerSession
	Name             string `json:"name"`
	Language         string `json:"language"`
	ReferencePath    string `json:"reference_path"`
	ConsentConfirmed bool   `json:"consent_confirmed"`
}

type VoiceDropCreateRequest struct {
	WorkerSession
	Name             string `json:"name"`
	Language         string `json:"language"`
	ReferenceBase64  string `json:"reference_base64"`
	ReferenceName    string `json:"reference_name"`
	ConsentConfirmed bool   `json:"consent_confirmed"`
}

type GenerateRequest struct {
	WorkerSession
	VoiceID  string  `json:"voice_id"`
	Text     string  `json:"text"`
	Language string  `json:"language"`
	Speed    float64 `json:"speed"`
	Steps    int     `json:"steps"`
}

type GenerationResult struct {
	History GenerationHistory `json:"history"`
	DataURL string            `json:"data_url"`
}

type GenerationHistory struct {
	ID        string `json:"id"`
	VoiceID   string `json:"voice_id"`
	VoiceName string `json:"voice_name"`
	Text      string `json:"text"`
	Language  string `json:"language"`
	FileName  string `json:"file_name"`
	CreatedAt string `json:"created_at"`
	SizeBytes int64  `json:"size_bytes"`
}

type PreferencesRequest struct {
	Theme           string `json:"theme"`
	Locale          string `json:"locale"`
	WorkerURL       string `json:"worker_url"`
	SelectedVoiceID string `json:"selected_voice_id"`
}

// ImportedDocument is deliberately plain text.  The original file remains on
// the user's device; KOVA only puts extracted text into the editable composer.
type ImportedDocument struct {
	FileName   string `json:"file_name"`
	Format     string `json:"format"`
	Text       string `json:"text"`
	Characters int    `json:"characters"`
}

// TextReviewRequest is session-only. GatewayURL/APIKey are never added to
// studioState and therefore never written to KOVA's local library.
type TextReviewRequest struct {
	GatewayURL   string `json:"gateway_url"`
	APIKey       string `json:"api_key"`
	Model        string `json:"model"`
	Text         string `json:"text"`
	Language     string `json:"language"`
	SourceFormat string `json:"source_format"`
}

type TextReviewResult struct {
	RevisedText   string   `json:"revised_text"`
	ReviewSummary string   `json:"review_summary"`
	Warnings      []string `json:"warnings"`
}

// GatewayModelsRequest deliberately mirrors the session-only gateway fields
// used for text review.  Keys are used only for this request and are never
// persisted in the local voice library.
type GatewayModelsRequest struct {
	GatewayURL string `json:"gateway_url"`
	APIKey     string `json:"api_key"`
}

// GatewayModel is an OpenAI-compatible model entry.  PricingKnown is false
// for gateways which expose /models but do not publish pricing metadata.
// In that case KOVA never guesses that a model is free.
type GatewayModel struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Free         bool   `json:"free"`
	PricingKnown bool   `json:"pricing_known"`
}

func NewApp() *App {
	return &App{client: &http.Client{Timeout: 90 * time.Second}}
}

func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	_ = a.ensureLoaded()
	_ = registerPairingProtocol()
}

func (a *App) Bootstrap() (StudioBootstrap, error) {
	if err := a.ensureLoaded(); err != nil {
		return StudioBootstrap{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return StudioBootstrap{
		AppName:         "KOVA Voice Studio",
		Version:         "1.0.0.9",
		NotebookURL:     voiceStudioNotebookURL,
		Theme:           a.state.Theme,
		Locale:          a.state.Locale,
		WorkerURL:       a.state.WorkerURL,
		SelectedVoiceID: a.state.SelectedVoiceID,
		Voices:          copyVoices(a.state.Voices),
		History:         copyHistory(a.state.History),
		DemoVoices:      demoVoices(),
	}, nil
}

func (a *App) SavePreferences(request PreferencesRequest) (StudioBootstrap, error) {
	if err := a.ensureLoaded(); err != nil {
		return StudioBootstrap{}, err
	}
	theme := strings.ToLower(strings.TrimSpace(request.Theme))
	if theme != "dark" && theme != "light" && theme != "system" {
		theme = "dark"
	}
	locale := strings.ToLower(strings.TrimSpace(request.Locale))
	if locale != "vi" && locale != "en" {
		locale = "vi"
	}
	workerURL := strings.TrimSpace(request.WorkerURL)
	if workerURL != "" {
		var err error
		workerURL, err = normalizeWorkerURL(workerURL)
		if err != nil {
			return StudioBootstrap{}, err
		}
	}
	a.mu.Lock()
	a.state.Theme = theme
	a.state.Locale = locale
	a.state.WorkerURL = workerURL
	if strings.TrimSpace(request.SelectedVoiceID) != "" {
		a.state.SelectedVoiceID = strings.TrimSpace(request.SelectedVoiceID)
	}
	err := a.saveStateLocked()
	a.mu.Unlock()
	if err != nil {
		return StudioBootstrap{}, err
	}
	return a.Bootstrap()
}

func (a *App) OpenColabNotebook() error {
	if a.ctx == nil {
		return errors.New("application is not ready")
	}
	runtime.BrowserOpenURL(a.ctx, voiceStudioNotebookURL)
	return nil
}

// OpenGoogleDrive hands the user to Google Drive in their default browser.
// On Windows this normally reuses the existing browser profile/session, so a
// signed-in Chrome window stays signed in.  KOVA never receives Drive OAuth
// access: the user chooses a file and pastes its share link back into Studio.
func (a *App) OpenGoogleDrive() error {
	if a.ctx == nil {
		return errors.New("application is not ready")
	}
	runtime.BrowserOpenURL(a.ctx, "https://drive.google.com/drive/u/0/my-drive")
	return nil
}

func (a *App) CheckWorker(session WorkerSession) WorkerHealth {
	baseURL, err := normalizeWorkerURL(session.BaseURL)
	if err != nil {
		return WorkerHealth{Message: err.Error()}
	}
	request, _ := http.NewRequest(http.MethodGet, baseURL+"/v1/health", nil)
	if token := strings.TrimSpace(session.Token); token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := a.client.Do(request)
	if err != nil {
		return WorkerHealth{Message: "Cannot reach the Voice Studio worker: " + err.Error()}
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return WorkerHealth{Message: "Voice Studio returned " + response.Status}
	}
	var payload struct {
		Device string `json:"device"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&payload)
	return WorkerHealth{Reachable: true, Message: "Voice Studio worker is ready", Device: payload.Device}
}

// ConsumeIncomingColabPairing receives the one-time link written by the
// Windows protocol handler. It is safe to poll: no link simply returns nil.
// The bearer token is exchanged over HTTPS and never written to studio state.
func (a *App) ConsumeIncomingColabPairing() (*PairingSession, error) {
	if err := a.ensureLoaded(); err != nil {
		return nil, err
	}
	pairingURI, err := consumePairingInbox()
	if err != nil || pairingURI == "" {
		return nil, err
	}
	workerURL, code, err := parsePairingURI(pairingURI)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodGet, workerURL+"/v1/pairing/"+url.PathEscape(code), nil)
	if err != nil {
		return nil, err
	}
	response, err := a.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("claim Colab pairing: %w", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("Colab pairing returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode Colab pairing: %w", err)
	}
	if strings.TrimSpace(payload.Token) == "" {
		return nil, errors.New("Colab pairing did not return a session token")
	}
	health := a.CheckWorker(WorkerSession{BaseURL: workerURL, Token: payload.Token})
	if !health.Reachable {
		return nil, errors.New(health.Message)
	}
	a.mu.Lock()
	a.state.WorkerURL = workerURL
	err = a.saveStateLocked()
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return &PairingSession{WorkerURL: workerURL, Token: payload.Token, Message: health.Message}, nil
}

func (a *App) SelectReferenceAudio() (string, error) {
	if a.ctx == nil {
		return "", errors.New("application is not ready")
	}
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Choose voice reference audio",
		Filters: []runtime.FileFilter{{DisplayName: "Audio reference (WAV, MP3, FLAC)", Pattern: "*.wav;*.mp3;*.flac"}},
	})
}

// SelectTextDocument opens a native picker for formats that can be reviewed
// and read by a voice profile. It intentionally does not use a browser upload
// so private documents stay local until the user explicitly sends text to a
// gateway review request.
func (a *App) SelectTextDocument() (string, error) {
	if a.ctx == nil {
		return "", errors.New("application is not ready")
	}
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Choose text, subtitle, or document",
		Filters: []runtime.FileFilter{{DisplayName: "Documents (TXT, SRT, MD, DOCX, PDF)", Pattern: "*.txt;*.srt;*.md;*.docx;*.pdf"}},
	})
}

// ImportTextDocument extracts editable text from a user-selected local file.
// DOCX and PDF are read locally; nothing is uploaded by this operation.
func (a *App) ImportTextDocument(path string) (ImportedDocument, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return ImportedDocument{}, errors.New("choose a TXT, SRT, MD, DOCX, or PDF file")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return ImportedDocument{}, err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return ImportedDocument{}, errors.New("selected document is unavailable")
	}
	if info.Size() <= 0 || info.Size() > maxDocumentBytes {
		return ImportedDocument{}, fmt.Errorf("document must be between 1 byte and %d MiB", maxDocumentBytes/(1024*1024))
	}
	format := strings.ToLower(strings.TrimPrefix(filepath.Ext(abs), "."))
	var value string
	switch format {
	case "txt", "md":
		data, readErr := os.ReadFile(abs)
		if readErr != nil {
			return ImportedDocument{}, readErr
		}
		value = string(data)
	case "srt":
		data, readErr := os.ReadFile(abs)
		if readErr != nil {
			return ImportedDocument{}, readErr
		}
		value = stripSRTText(string(data))
	case "docx":
		value, err = readDOCXText(abs)
	case "pdf":
		value, err = readPDFText(abs)
	default:
		return ImportedDocument{}, errors.New("supported formats are TXT, SRT, MD, DOCX, and PDF")
	}
	if err != nil {
		return ImportedDocument{}, err
	}
	value = normalizeImportedText(value)
	if value == "" {
		return ImportedDocument{}, errors.New("no readable text was found in the document")
	}
	if len([]rune(value)) > 10000 {
		value = string([]rune(value)[:10000])
	}
	return ImportedDocument{FileName: filepath.Base(abs), Format: format, Text: value, Characters: len([]rune(value))}, nil
}

// ImportGoogleDriveDocument supports a public/shareable Google Drive file
// without collecting OAuth permissions. The user retains control: only the
// URL they paste is fetched, and private Drive files still require a browser
// download followed by the local picker above.
func (a *App) ImportGoogleDriveDocument(sharedURL string) (ImportedDocument, error) {
	id, err := googleDriveFileID(sharedURL)
	if err != nil {
		return ImportedDocument{}, err
	}
	downloadURL := "https://drive.usercontent.google.com/download?id=" + url.QueryEscape(id) + "&export=download&confirm=t"
	request, err := http.NewRequest(http.MethodGet, downloadURL, nil)
	if err != nil {
		return ImportedDocument{}, err
	}
	response, err := a.client.Do(request)
	if err != nil {
		return ImportedDocument{}, fmt.Errorf("download shared Google Drive file: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return ImportedDocument{}, fmt.Errorf("Google Drive returned %s; make sure the file is shared with anyone who has the link", response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxDocumentBytes+1))
	if err != nil {
		return ImportedDocument{}, err
	}
	if int64(len(body)) > maxDocumentBytes {
		return ImportedDocument{}, fmt.Errorf("Google Drive document exceeds %d MiB", maxDocumentBytes/(1024*1024))
	}
	name := driveFilename(response.Header.Get("Content-Disposition"), id)
	format := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	if format == "" {
		format = formatFromContent(response.Header.Get("Content-Type"), body)
		name += "." + format
	}
	if format == "docx" || format == "pdf" {
		incoming := filepath.Join(a.dataDir(), "incoming")
		if err := os.MkdirAll(incoming, 0700); err != nil {
			return ImportedDocument{}, err
		}
		temporary, err := os.CreateTemp(incoming, "drive-*"+"."+format)
		if err != nil {
			return ImportedDocument{}, err
		}
		temporaryPath := temporary.Name()
		if _, err = temporary.Write(body); err == nil {
			err = temporary.Close()
		} else {
			_ = temporary.Close()
		}
		if err != nil {
			_ = os.Remove(temporaryPath)
			return ImportedDocument{}, err
		}
		defer os.Remove(temporaryPath)
		result, err := a.ImportTextDocument(temporaryPath)
		if err != nil {
			return ImportedDocument{}, err
		}
		result.FileName = name
		return result, nil
	}
	if format != "txt" && format != "md" && format != "srt" {
		return ImportedDocument{}, errors.New("Google Drive file must be TXT, SRT, MD, DOCX, or PDF")
	}
	value := string(body)
	if format == "srt" {
		value = stripSRTText(value)
	}
	value = normalizeImportedText(value)
	if value == "" {
		return ImportedDocument{}, errors.New("no readable text was found in the Google Drive file")
	}
	if len([]rune(value)) > 10000 {
		value = string([]rune(value)[:10000])
	}
	return ImportedDocument{FileName: name, Format: format, Text: value, Characters: len([]rune(value))}, nil
}

// ReviewTextWithGateway asks an OpenAI-compatible API Gateway to review
// context, logic, spelling, and punctuation. It never automatically replaces
// the user's text: the renderer presents the result for an explicit Apply.
func (a *App) ReviewTextWithGateway(input TextReviewRequest) (TextReviewResult, error) {
	textValue := strings.TrimSpace(input.Text)
	if textValue == "" || len([]rune(textValue)) > 10000 {
		return TextReviewResult{}, errors.New("text must contain 1–10,000 characters")
	}
	baseURL, err := normalizeGatewayURL(input.GatewayURL)
	if err != nil {
		return TextReviewResult{}, err
	}
	if strings.TrimSpace(input.APIKey) == "" {
		return TextReviewResult{}, errors.New("enter an API Gateway key for this session")
	}
	model := first(strings.TrimSpace(input.Model), "deepseek-v4-flash:cloud")
	language := first(strings.TrimSpace(input.Language), "vi")
	format := first(strings.TrimSpace(input.SourceFormat), "plain text")
	prompt := "Review the following " + format + " in " + language + ". Correct spelling, punctuation, grammar, context coherence, and obvious logic issues without inventing facts. Preserve proper names, numbers, URLs, and SRT timestamps if present. Return ONLY valid JSON with revised_text (string), review_summary (string), warnings (array of strings).\n\nTEXT:\n" + textValue
	payload := map[string]any{"model": model, "temperature": 0.15, "messages": []map[string]string{{"role": "system", "content": "You are a careful bilingual editorial reviewer. Never remove user meaning or change factual claims without a warning."}, {"role": "user", "content": prompt}}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return TextReviewResult{}, err
	}
	request, err := http.NewRequest(http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		return TextReviewResult{}, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(input.APIKey))
	request.Header.Set("Content-Type", "application/json")
	response, err := a.client.Do(request)
	if err != nil {
		return TextReviewResult{}, fmt.Errorf("AI Gateway review: %w", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return TextReviewResult{}, fmt.Errorf("AI Gateway returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &completion); err != nil {
		return TextReviewResult{}, fmt.Errorf("decode AI Gateway response: %w", err)
	}
	if len(completion.Choices) == 0 {
		return TextReviewResult{}, errors.New("AI Gateway returned no review choices")
	}
	content := strings.TrimSpace(completion.Choices[0].Message.Content)
	start, end := strings.Index(content, "{"), strings.LastIndex(content, "}")
	if start < 0 || end <= start {
		return TextReviewResult{}, errors.New("AI Gateway did not return the required JSON review")
	}
	var result TextReviewResult
	if err := json.Unmarshal([]byte(content[start:end+1]), &result); err != nil {
		return TextReviewResult{}, fmt.Errorf("decode AI review JSON: %w", err)
	}
	result.RevisedText = normalizeImportedText(result.RevisedText)
	if result.RevisedText == "" {
		return TextReviewResult{}, errors.New("AI Gateway review did not contain revised text")
	}
	if len([]rune(result.RevisedText)) > 10000 {
		result.RevisedText = string([]rune(result.RevisedText)[:10000])
	}
	if result.Warnings == nil {
		result.Warnings = []string{}
	}
	return result, nil
}

// ListGatewayModels reads an OpenAI-compatible /v1/models endpoint and
// returns every model which the gateway explicitly prices at zero.  A few
// providers omit pricing entirely; in that case all returned models are shown
// with PricingKnown=false rather than being incorrectly presented as free.
func (a *App) ListGatewayModels(input GatewayModelsRequest) ([]GatewayModel, error) {
	baseURL, err := normalizeGatewayURL(input.GatewayURL)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodGet, baseURL+"/models", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if key := strings.TrimSpace(input.APIKey); key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	response, err := a.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("load AI Gateway models: %w", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("AI Gateway models returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var payload struct {
		Data []struct {
			ID      string                     `json:"id"`
			Name    string                     `json:"name"`
			Pricing map[string]json.RawMessage `json:"pricing"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode AI Gateway model list: %w", err)
	}
	if len(payload.Data) == 0 {
		return nil, errors.New("AI Gateway returned no models")
	}
	pricingAvailable := false
	models := make([]GatewayModel, 0, len(payload.Data))
	for _, item := range payload.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		known := len(item.Pricing) > 0
		pricingAvailable = pricingAvailable || known
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = id
		}
		models = append(models, GatewayModel{
			ID:           id,
			Name:         name,
			Free:         known && gatewayPricingIsFree(item.Pricing),
			PricingKnown: known,
		})
	}
	if len(models) == 0 {
		return nil, errors.New("AI Gateway returned no usable model IDs")
	}
	if pricingAvailable {
		freeModels := models[:0]
		for _, model := range models {
			if model.Free {
				freeModels = append(freeModels, model)
			}
		}
		models = freeModels
		if len(models) == 0 {
			return nil, errors.New("AI Gateway did not report any zero-cost models")
		}
	}
	sort.Slice(models, func(i, j int) bool {
		return strings.ToLower(models[i].Name) < strings.ToLower(models[j].Name)
	})
	return models, nil
}

func gatewayPricingIsFree(pricing map[string]json.RawMessage) bool {
	if len(pricing) == 0 {
		return false
	}
	for _, raw := range pricing {
		value := strings.Trim(strings.TrimSpace(string(raw)), `"`)
		if value == "" || value == "0" || value == "0.0" || value == "0.00" || value == "0.000000" {
			continue
		}
		return false
	}
	return true
}

func (a *App) RefreshVoiceLibrary(session WorkerSession) ([]VoiceProfile, error) {
	if err := a.ensureLoaded(); err != nil {
		return nil, err
	}
	baseURL, err := normalizeWorkerURL(session.BaseURL)
	if err != nil {
		return nil, err
	}
	remote, err := a.remoteVoices(baseURL, session.Token)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	known := make(map[string]int, len(a.state.Voices))
	for index, profile := range a.state.Voices {
		known[profile.RemoteID] = index
	}
	for _, profile := range remote {
		if index, found := known[profile.ID]; found {
			a.state.Voices[index].Name = first(profile.Name, a.state.Voices[index].Name)
			a.state.Voices[index].Language = first(profile.Language, a.state.Voices[index].Language)
			a.state.Voices[index].Status = profile.Status
			a.state.Voices[index].WorkerURL = baseURL
			continue
		}
		a.state.Voices = append(a.state.Voices, VoiceProfile{
			ID: profile.ID, RemoteID: profile.ID, Name: profile.Name, Language: first(profile.Language, "vi"),
			Status: profile.Status, Kind: "remote", WorkerURL: baseURL, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		})
	}
	err = a.saveStateLocked()
	voices := copyVoices(a.state.Voices)
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return voices, nil
}

func (a *App) CreateVoice(request VoiceCreateRequest) (profile VoiceProfile, err error) {
	progress := a.startTask("clone", "Đang kiểm tra audio mẫu và quyền clone")
	defer func() {
		if err != nil {
			progress.fail("Tạo clone thất bại: " + err.Error())
			return
		}
		progress.done("Clone đã lưu. Phòng thu sẽ tái sử dụng profile này, không clone lại.")
	}()
	if strings.TrimSpace(request.ReferencePath) == "" {
		return VoiceProfile{}, errors.New("choose a WAV, MP3, or FLAC reference file")
	}
	return a.createVoiceFromFile(request.WorkerSession, request.Name, request.Language, request.ReferencePath, request.ConsentConfirmed, progress)
}

func (a *App) CreateVoiceFromDrop(request VoiceDropCreateRequest) (profile VoiceProfile, err error) {
	progress := a.startTask("clone", "Đang đọc audio mẫu đã kéo thả")
	defer func() {
		if err != nil {
			progress.fail("Tạo clone thất bại: " + err.Error())
			return
		}
		progress.done("Clone đã lưu. Phòng thu sẽ tái sử dụng profile này, không clone lại.")
	}()
	if err := a.ensureLoaded(); err != nil {
		return VoiceProfile{}, err
	}
	encoded := strings.TrimSpace(request.ReferenceBase64)
	if comma := strings.IndexByte(encoded, ','); strings.HasPrefix(encoded, "data:") && comma >= 0 {
		encoded = encoded[comma+1:]
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return VoiceProfile{}, errors.New("the dropped audio could not be read")
	}
	if len(data) == 0 || int64(len(data)) > maxReferenceBytes {
		return VoiceProfile{}, fmt.Errorf("reference audio must be between 1 byte and %d MiB", maxReferenceBytes/(1024*1024))
	}
	name := safeReferenceName(request.ReferenceName)
	if !allowedReferenceExtension(filepath.Ext(name)) {
		return VoiceProfile{}, errors.New("dropped audio must be WAV, MP3, or FLAC")
	}
	incoming := filepath.Join(a.dataDir(), "incoming")
	if err := os.MkdirAll(incoming, 0700); err != nil {
		return VoiceProfile{}, err
	}
	temporary, err := os.CreateTemp(incoming, "drop-*"+filepath.Ext(name))
	if err != nil {
		return VoiceProfile{}, err
	}
	temporaryPath := temporary.Name()
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		_ = os.Remove(temporaryPath)
		return VoiceProfile{}, err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return VoiceProfile{}, err
	}
	defer os.Remove(temporaryPath)
	return a.createVoiceFromFile(request.WorkerSession, request.Name, request.Language, temporaryPath, request.ConsentConfirmed, progress)
}

func (a *App) PreviewVoice(request GenerateRequest) (result GenerationResult, err error) {
	progress := a.startTask("preview", "Đang chuẩn bị câu nghe thử bằng profile đã lưu")
	defer func() {
		if err != nil {
			progress.fail("Nghe thử thất bại: " + err.Error())
			return
		}
		progress.done("Audio nghe thử đã sẵn sàng")
	}()
	request.Text = previewSentenceVI
	if strings.TrimSpace(request.Language) == "" {
		request.Language = "vi"
	}
	return a.generate(request, false, progress)
}

func (a *App) GenerateVoice(request GenerateRequest) (result GenerationResult, err error) {
	progress := a.startTask("generate", "Đang chuẩn bị tạo audio bằng profile đã lưu")
	defer func() {
		if err != nil {
			progress.fail("Tạo audio thất bại: " + err.Error())
			return
		}
		progress.done("Audio đã tạo và lưu vào lịch sử")
	}()
	return a.generate(request, true, progress)
}

func (a *App) DeleteVoice(session WorkerSession, voiceID string) ([]VoiceProfile, error) {
	if err := a.ensureLoaded(); err != nil {
		return nil, err
	}
	voiceID = strings.TrimSpace(voiceID)
	if voiceID == "" {
		return nil, errors.New("select a voice to delete")
	}
	a.mu.Lock()
	index := -1
	for i, profile := range a.state.Voices {
		if profile.ID == voiceID {
			index = i
			break
		}
	}
	if index < 0 {
		a.mu.Unlock()
		return nil, errors.New("voice was not found in the local library")
	}
	profile := a.state.Voices[index]
	a.mu.Unlock()

	if strings.TrimSpace(session.BaseURL) != "" && strings.TrimSpace(session.Token) != "" && strings.TrimSpace(profile.RemoteID) != "" {
		baseURL, err := normalizeWorkerURL(session.BaseURL)
		if err != nil {
			return nil, err
		}
		request, _ := http.NewRequest(http.MethodDelete, baseURL+"/v1/profiles/"+url.PathEscape(profile.RemoteID), nil)
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(session.Token))
		response, err := a.client.Do(request)
		if err != nil {
			return nil, fmt.Errorf("delete profile from Voice Studio: %w", err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusNotFound && (response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices) {
			return nil, fmt.Errorf("Voice Studio delete returned %s", response.Status)
		}
	}

	a.mu.Lock()
	if profile.ReferenceFile != "" {
		_ = os.Remove(filepath.Join(a.dataDir(), "references", filepath.Base(profile.ReferenceFile)))
	}
	a.state.Voices = append(a.state.Voices[:index], a.state.Voices[index+1:]...)
	if a.state.SelectedVoiceID == voiceID {
		a.state.SelectedVoiceID = ""
	}
	err := a.saveStateLocked()
	voices := copyVoices(a.state.Voices)
	a.mu.Unlock()
	return voices, err
}

func (a *App) DeleteHistory(id string) ([]GenerationHistory, error) {
	if err := a.ensureLoaded(); err != nil {
		return nil, err
	}
	a.mu.Lock()
	index := -1
	for i, item := range a.state.History {
		if item.ID == strings.TrimSpace(id) {
			index = i
			break
		}
	}
	if index < 0 {
		a.mu.Unlock()
		return nil, errors.New("history item was not found")
	}
	_ = os.Remove(filepath.Join(a.dataDir(), "history", filepath.Base(a.state.History[index].FileName)))
	a.state.History = append(a.state.History[:index], a.state.History[index+1:]...)
	err := a.saveStateLocked()
	history := copyHistory(a.state.History)
	a.mu.Unlock()
	return history, err
}

func (a *App) OpenHistoryAudio(id string) error {
	if err := a.ensureLoaded(); err != nil {
		return err
	}
	a.mu.Lock()
	var fileName string
	for _, item := range a.state.History {
		if item.ID == strings.TrimSpace(id) {
			fileName = item.FileName
			break
		}
	}
	a.mu.Unlock()
	if fileName == "" {
		return errors.New("history item was not found")
	}
	path := filepath.Join(a.dataDir(), "history", filepath.Base(fileName))
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return errors.New("saved audio file is unavailable")
	}
	if a.ctx == nil {
		return errors.New("application is not ready")
	}
	u := &url.URL{Scheme: "file", Path: path}
	runtime.BrowserOpenURL(a.ctx, u.String())
	return nil
}

func (a *App) ensureLoaded() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.loaded {
		return nil
	}
	state, err := loadState(a.statePath())
	if err != nil {
		return err
	}
	// A profile must never advertise a usable backup when the audio was deleted
	// outside the application.  Keep the profile metadata, but show an honest
	// state so the user can add a new reference instead of failing later.
	for index := range state.Voices {
		profile := &state.Voices[index]
		if profile.ReferenceFile == "" {
			profile.BackupAvailable = false
			continue
		}
		path := filepath.Join(a.dataDir(), "references", filepath.Base(profile.ReferenceFile))
		info, statErr := os.Stat(path)
		profile.BackupAvailable = statErr == nil && !info.IsDir() && info.Size() > 0
	}
	a.state = state
	a.loaded = true
	return nil
}

func (a *App) dataDir() string {
	return voiceStudioDataDir()
}

func voiceStudioDataDir() string {
	if root := strings.TrimSpace(os.Getenv("KOVA_VOICE_STUDIO_DATA_DIR")); root != "" {
		return root
	}
	if root, err := os.UserConfigDir(); err == nil && root != "" {
		return filepath.Join(root, "KOVA Voice Studio")
	}
	return "kova-voice-studio-data"
}

func pairingInboxPath() string {
	return filepath.Join(voiceStudioDataDir(), "incoming-colab-pairing.json")
}

func storeIncomingPairing(pairingURI string) error {
	if _, _, err := parsePairingURI(pairingURI); err != nil {
		return err
	}
	if err := os.MkdirAll(voiceStudioDataDir(), 0700); err != nil {
		return err
	}
	payload, err := json.Marshal(struct {
		URI        string `json:"uri"`
		ReceivedAt string `json:"received_at"`
	}{URI: pairingURI, ReceivedAt: time.Now().UTC().Format(time.RFC3339)})
	if err != nil {
		return err
	}
	path := pairingInboxPath()
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, payload, 0600); err != nil {
		return err
	}
	// Windows does not consistently replace an existing destination on Rename.
	// A newer one-time link is more useful than an already-unclaimed one.
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func consumePairingInbox() (string, error) {
	path := pairingInboxPath()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if err := os.Remove(path); err != nil {
		return "", err
	}
	var payload struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", fmt.Errorf("decode Colab pairing inbox: %w", err)
	}
	return strings.TrimSpace(payload.URI), nil
}

func parsePairingURI(raw string) (string, string, error) {
	pairing, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || pairing.Scheme != "kova-voice-studio" || !strings.EqualFold(pairing.Host, "pair") {
		return "", "", errors.New("invalid KOVA Voice Studio pairing link")
	}
	workerURL, err := normalizeWorkerURL(pairing.Query().Get("worker_url"))
	if err != nil {
		return "", "", err
	}
	code := strings.TrimSpace(pairing.Query().Get("code"))
	if len(code) < 24 || len(code) > 256 {
		return "", "", errors.New("invalid Colab pairing code")
	}
	return workerURL, code, nil
}

func registerPairingProtocol() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Classes\kova-voice-studio`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if err := key.SetStringValue("", "URL:KOVA Voice Studio pairing"); err != nil {
		return err
	}
	if err := key.SetStringValue("URL Protocol", ""); err != nil {
		return err
	}
	command, _, err := registry.CreateKey(key, `shell\open\command`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer command.Close()
	return command.SetStringValue("", fmt.Sprintf(`"%s" --pair "%%1"`, executable))
}

func (a *App) statePath() string { return filepath.Join(a.dataDir(), "studio-state.json") }

func (a *App) saveStateLocked() error {
	if err := os.MkdirAll(a.dataDir(), 0700); err != nil {
		return err
	}
	a.state.Version = 1
	data, err := json.MarshalIndent(a.state, "", "  ")
	if err != nil {
		return err
	}
	path := a.statePath()
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(data, '\n'), 0600); err != nil {
		return err
	}
	// Rename replaces the destination atomically on the supported Windows file
	// systems.  Keeping the old state until the new state is completely written
	// is important: an interrupted shutdown must not lose the whole library.
	if err := os.Rename(temporary, path); err != nil {
		// Windows cannot replace an existing file with Rename on every volume.
		// Preserve a last-known-good copy before using the compatibility path.
		backup := path + ".bak"
		if copyErr := copyFile(path, backup); copyErr != nil && !errors.Is(copyErr, os.ErrNotExist) {
			_ = os.Remove(temporary)
			return copyErr
		}
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			_ = os.Remove(temporary)
			return removeErr
		}
		if renameErr := os.Rename(temporary, path); renameErr != nil {
			return renameErr
		}
	}
	return nil
}

func loadState(path string) (studioState, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return studioState{Version: 1, Theme: "dark", Locale: "vi", Voices: []VoiceProfile{}, History: []GenerationHistory{}}, nil
	}
	if err != nil {
		return studioState{}, fmt.Errorf("read Voice Studio library: %w", err)
	}
	var state studioState
	if err := json.Unmarshal(data, &state); err != nil {
		// If a device loses power precisely during a legacy non-atomic save, the
		// last backup is preferable to discarding the user's complete library.
		backup, backupErr := os.ReadFile(path + ".bak")
		if backupErr == nil && json.Unmarshal(backup, &state) == nil {
			return normalizeState(state), nil
		}
		return studioState{}, fmt.Errorf("decode Voice Studio library: %w", err)
	}
	return normalizeState(state), nil
}

func normalizeState(state studioState) studioState {
	if state.Theme == "" {
		state.Theme = "dark"
	}
	if state.Locale == "" {
		state.Locale = "vi"
	}
	if state.Voices == nil {
		state.Voices = []VoiceProfile{}
	}
	if state.History == nil {
		state.History = []GenerationHistory{}
	}
	return state
}

func (a *App) createVoiceFromFile(session WorkerSession, name, language, sourcePath string, consent bool, progress *taskReporter) (VoiceProfile, error) {
	progress.update("validate_reference", 10, "Đang kiểm tra audio mẫu và quyền clone", "running")
	if err := a.ensureLoaded(); err != nil {
		return VoiceProfile{}, err
	}
	if !consent {
		return VoiceProfile{}, errors.New("confirm that you have permission to clone this reference voice")
	}
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 120 {
		return VoiceProfile{}, errors.New("voice name is required and must not exceed 120 characters")
	}
	language = first(strings.TrimSpace(language), "vi")
	if language != "vi" && language != "en" {
		return VoiceProfile{}, errors.New("choose Vietnamese or English for this profile")
	}
	sourcePath, err := filepath.Abs(strings.TrimSpace(sourcePath))
	if err != nil {
		return VoiceProfile{}, err
	}
	info, err := os.Stat(sourcePath)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return VoiceProfile{}, errors.New("reference audio file is unavailable or empty")
	}
	if info.Size() > maxReferenceBytes {
		return VoiceProfile{}, fmt.Errorf("reference audio exceeds %d MiB", maxReferenceBytes/(1024*1024))
	}
	if !allowedReferenceExtension(filepath.Ext(sourcePath)) {
		return VoiceProfile{}, errors.New("reference audio must be WAV, MP3, or FLAC")
	}
	baseURL, err := normalizeWorkerURL(session.BaseURL)
	if err != nil {
		return VoiceProfile{}, err
	}
	if strings.TrimSpace(session.Token) == "" {
		return VoiceProfile{}, errors.New("paste the current Colab worker token before creating a voice")
	}
	// The GPU worker performs a mandatory Demucs vocal-stem pass before it
	// accepts the reference. Keeping this explicit stops music-contaminated
	// input from being mistaken for a successful clone.
	progress.update("separate_voice_music", 35, "GPU Colab is separating the spoken voice from music before cloning", "running")
	remote, err := a.uploadProfile(baseURL, session.Token, name, language, sourcePath)
	if err != nil {
		return VoiceProfile{}, err
	}
	progress.update("backup_reference", 78, "Clean vocal reference is ready; saving a private local backup", "running")
	profile := VoiceProfile{
		ID: remote.ID, RemoteID: remote.ID, Name: first(remote.Name, name), Language: first(remote.Language, language),
		Status: first(remote.Status, "ready"), Kind: "cloned", WorkerURL: baseURL,
		CreatedAt: time.Now().UTC().Format(time.RFC3339), ReferenceClean: remote.ReferenceClean,
	}
	if err := a.storeReference(&profile, sourcePath); err != nil {
		return VoiceProfile{}, err
	}
	a.mu.Lock()
	for i := range a.state.Voices {
		if a.state.Voices[i].ID == profile.ID {
			a.state.Voices[i] = profile
			profile = a.state.Voices[i]
			break
		}
	}
	found := false
	for _, item := range a.state.Voices {
		if item.ID == profile.ID {
			found = true
			break
		}
	}
	if !found {
		a.state.Voices = append(a.state.Voices, profile)
	}
	a.state.SelectedVoiceID = profile.ID
	err = a.saveStateLocked()
	a.mu.Unlock()
	if err != nil {
		return VoiceProfile{}, err
	}
	progress.update("save_profile", 96, "Đang lưu profile vào thư viện dùng lại", "running")
	return profile, nil
}

func (a *App) storeReference(profile *VoiceProfile, sourcePath string) error {
	if profile == nil {
		return errors.New("voice profile is missing")
	}
	filename := safeReferenceName(profile.ID + filepath.Ext(sourcePath))
	destination := filepath.Join(a.dataDir(), "references", filename)
	if err := copyFile(sourcePath, destination); err != nil {
		return fmt.Errorf("save local voice backup: %w", err)
	}
	profile.ReferenceFile = filename
	profile.BackupAvailable = true
	return nil
}

func (a *App) uploadProfile(baseURL, token, name, language, sourcePath string) (VoiceProfile, error) {
	file, err := os.Open(sourcePath)
	if err != nil {
		return VoiceProfile{}, err
	}
	defer file.Close()
	buffer := &bytes.Buffer{}
	writer := multipart.NewWriter(buffer)
	for field, value := range map[string]string{"name": name, "language": language, "consent_confirmed": "true"} {
		if err := writer.WriteField(field, value); err != nil {
			return VoiceProfile{}, err
		}
	}
	part, err := writer.CreateFormFile("ref_audio", filepath.Base(sourcePath))
	if err != nil {
		return VoiceProfile{}, err
	}
	if _, err = io.Copy(part, io.LimitReader(file, maxReferenceBytes+1)); err != nil {
		return VoiceProfile{}, err
	}
	if err = writer.Close(); err != nil {
		return VoiceProfile{}, err
	}
	request, err := http.NewRequest(http.MethodPost, baseURL+"/profiles", buffer)
	if err != nil {
		return VoiceProfile{}, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := a.client.Do(request)
	if err != nil {
		return VoiceProfile{}, fmt.Errorf("upload reference to Voice Studio: %w", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return VoiceProfile{}, fmt.Errorf("Voice Studio profile upload returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var payload struct {
		ID      string       `json:"id"`
		Profile VoiceProfile `json:"profile"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return VoiceProfile{}, fmt.Errorf("decode Voice Studio response: %w", err)
	}
	if payload.Profile.ID == "" {
		payload.Profile.ID = payload.ID
	}
	if payload.Profile.ID == "" {
		return VoiceProfile{}, errors.New("Voice Studio did not return a profile id")
	}
	return payload.Profile, nil
}

func (a *App) generate(request GenerateRequest, save bool, progress *taskReporter) (GenerationResult, error) {
	progress.update("validate", 10, "Đang kiểm tra nội dung và profile đã chọn", "running")
	if err := a.ensureLoaded(); err != nil {
		return GenerationResult{}, err
	}
	text := strings.TrimSpace(request.Text)
	if text == "" || len([]rune(text)) > 10000 {
		return GenerationResult{}, errors.New("text must contain 1–10,000 characters")
	}
	baseURL, err := normalizeWorkerURL(request.BaseURL)
	if err != nil {
		return GenerationResult{}, err
	}
	if strings.TrimSpace(request.Token) == "" {
		return GenerationResult{}, errors.New("paste the current Colab worker token before generating audio")
	}
	profile, err := a.profile(request.VoiceID)
	if err != nil {
		return GenerationResult{}, err
	}
	progress.update("reuse_profile", 24, "Đang tái sử dụng profile đã lưu; không tạo clone mới", "running")
	remoteID, err := a.ensureRemote(profile, baseURL, request.Token)
	if err != nil {
		return GenerationResult{}, err
	}
	speed := request.Speed
	if speed <= 0 || speed > 2 {
		speed = 1
	}
	steps := request.Steps
	if steps < 1 || steps > 64 {
		steps = 32
	}
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for field, value := range map[string]string{
		"text": text, "profile_id": remoteID, "language": first(strings.TrimSpace(request.Language), profile.Language),
		"speed": fmt.Sprintf("%.2f", speed), "num_step": fmt.Sprintf("%d", steps), "output_format": "wav",
	} {
		if err := writer.WriteField(field, value); err != nil {
			return GenerationResult{}, err
		}
	}
	if err := writer.Close(); err != nil {
		return GenerationResult{}, err
	}
	progress.update("gpu_synthesis", 45, "GPU Colab đang tạo audio; thời gian chạy được cập nhật liên tục", "running")
	httpRequest, err := http.NewRequest(http.MethodPost, baseURL+"/generate", body)
	if err != nil {
		return GenerationResult{}, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+strings.TrimSpace(request.Token))
	httpRequest.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := a.client.Do(httpRequest)
	if err != nil {
		return GenerationResult{}, fmt.Errorf("generate audio: %w", err)
	}
	defer response.Body.Close()
	audio, err := io.ReadAll(io.LimitReader(response.Body, maxGenerationBytes+1))
	if err != nil {
		return GenerationResult{}, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return GenerationResult{}, fmt.Errorf("Voice Studio generation returned %s: %s", response.Status, strings.TrimSpace(string(audio)))
	}
	if len(audio) == 0 || int64(len(audio)) > maxGenerationBytes {
		return GenerationResult{}, errors.New("generated audio is empty or too large")
	}
	progress.update("receive_audio", 86, "Đã nhận audio từ GPU; đang chuẩn bị phát và lưu", "running")
	result := GenerationResult{DataURL: "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(audio)}
	if !save {
		return result, nil
	}
	id := fmt.Sprintf("g-%d", time.Now().UnixNano())
	fileName := id + ".wav"
	destination := filepath.Join(a.dataDir(), "history", fileName)
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return GenerationResult{}, err
	}
	if err := os.WriteFile(destination, audio, 0600); err != nil {
		return GenerationResult{}, err
	}
	progress.update("save_audio", 94, "Đang lưu audio vào lịch sử cục bộ", "running")
	item := GenerationHistory{ID: id, VoiceID: profile.ID, VoiceName: profile.Name, Text: text, Language: first(strings.TrimSpace(request.Language), profile.Language), FileName: fileName, CreatedAt: time.Now().UTC().Format(time.RFC3339), SizeBytes: int64(len(audio))}
	a.mu.Lock()
	a.state.History = append([]GenerationHistory{item}, a.state.History...)
	if len(a.state.History) > 100 {
		a.state.History = a.state.History[:100]
	}
	err = a.saveStateLocked()
	a.mu.Unlock()
	if err != nil {
		return GenerationResult{}, err
	}
	result.History = item
	return result, nil
}

func (a *App) profile(id string) (VoiceProfile, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, profile := range a.state.Voices {
		if profile.ID == strings.TrimSpace(id) {
			return profile, nil
		}
	}
	return VoiceProfile{}, errors.New("select a saved or worker voice profile")
}

func (a *App) ensureRemote(profile VoiceProfile, baseURL, token string) (string, error) {
	remote, err := a.remoteVoices(baseURL, token)
	if err != nil {
		return "", err
	}
	for _, item := range remote {
		if item.ID == profile.RemoteID || item.ID == profile.ID {
			return item.ID, nil
		}
	}
	if !profile.BackupAvailable || profile.ReferenceFile == "" {
		return "", errors.New("this voice has no local reference backup. Recreate it once while connected to a current worker")
	}
	path := filepath.Join(a.dataDir(), "references", filepath.Base(profile.ReferenceFile))
	if info, err := os.Stat(path); err != nil || info.IsDir() || info.Size() == 0 {
		return "", errors.New("the local reference backup is unavailable")
	}
	restored, err := a.uploadProfile(baseURL, token, profile.Name, profile.Language, path)
	if err != nil {
		return "", fmt.Errorf("restore voice on the current Colab worker: %w", err)
	}
	a.mu.Lock()
	for i := range a.state.Voices {
		if a.state.Voices[i].ID == profile.ID {
			a.state.Voices[i].RemoteID = restored.ID
			a.state.Voices[i].WorkerURL = baseURL
			a.state.Voices[i].Status = "ready"
			break
		}
	}
	err = a.saveStateLocked()
	a.mu.Unlock()
	if err != nil {
		return "", err
	}
	return restored.ID, nil
}

func (a *App) remoteVoices(baseURL, token string) ([]VoiceProfile, error) {
	request, err := http.NewRequest(http.MethodGet, baseURL+"/v1/voices?status=ready", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	response, err := a.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("load Voice Studio profiles: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("Voice Studio voice list returned %s", response.Status)
	}
	var profiles []VoiceProfile
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&profiles); err != nil {
		return nil, err
	}
	return profiles, nil
}

func normalizeWorkerURL(raw string) (string, error) {
	u, err := url.ParseRequestURI(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", errors.New("enter a valid Voice Studio worker URL")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", errors.New("Voice Studio worker must use HTTPS except localhost")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func normalizeGatewayURL(raw string) (string, error) {
	raw = strings.TrimSpace(strings.TrimRight(raw, "/"))
	if raw == "" {
		return "", errors.New("enter an AI Gateway URL")
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return "", errors.New("AI Gateway URL must start with http:// or https://")
	}
	// Users may paste the OpenAI-compatible /v1 endpoint or just the host.
	path := strings.TrimRight(parsed.Path, "/")
	if !strings.HasSuffix(path, "/v1") {
		parsed.Path = path + "/v1"
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func stripSRTText(value string) string {
	lines := strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
	kept := make([]string, 0, len(lines))
	timestamp := regexp.MustCompile(`^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->`)
	indexLine := regexp.MustCompile(`^\s*\d+\s*$`)
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if timestamp.MatchString(trimmed) || indexLine.MatchString(trimmed) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func normalizeImportedText(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	lines := strings.Split(value, "\n")
	clean := make([]string, 0, len(lines))
	empty := false
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			if !empty {
				clean = append(clean, "")
			}
			empty = true
			continue
		}
		empty = false
		clean = append(clean, line)
	}
	return strings.TrimSpace(strings.Join(clean, "\n"))
}

func readDOCXText(path string) (string, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return "", fmt.Errorf("open DOCX: %w", err)
	}
	defer archive.Close()
	var document *zip.File
	for _, file := range archive.File {
		if file.Name == "word/document.xml" {
			document = file
			break
		}
	}
	if document == nil {
		return "", errors.New("DOCX is missing word/document.xml")
	}
	reader, err := document.Open()
	if err != nil {
		return "", err
	}
	defer reader.Close()
	decoder := xml.NewDecoder(io.LimitReader(reader, maxDocumentBytes))
	var builder strings.Builder
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("decode DOCX text: %w", err)
		}
		switch value := token.(type) {
		case xml.CharData:
			builder.Write([]byte(value))
		case xml.EndElement:
			if value.Name.Local == "p" {
				builder.WriteByte('\n')
			}
		}
	}
	return builder.String(), nil
}

func readPDFText(path string) (string, error) {
	file, reader, err := pdf.Open(path)
	if err != nil {
		return "", fmt.Errorf("open PDF: %w", err)
	}
	defer file.Close()
	textReader, err := reader.GetPlainText()
	if err != nil {
		return "", fmt.Errorf("extract PDF text: %w", err)
	}
	data, err := io.ReadAll(io.LimitReader(textReader, maxDocumentBytes))
	if err != nil {
		return "", fmt.Errorf("read PDF text: %w", err)
	}
	return string(data), nil
}

func googleDriveFileID(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return "", errors.New("paste a Google Drive sharing URL")
	}
	host := strings.ToLower(parsed.Host)
	if !strings.Contains(host, "drive.google.com") && !strings.Contains(host, "docs.google.com") {
		return "", errors.New("the link must be a Google Drive sharing URL")
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	for index, part := range parts {
		if part == "d" && index+1 < len(parts) && strings.TrimSpace(parts[index+1]) != "" {
			return parts[index+1], nil
		}
	}
	if id := strings.TrimSpace(parsed.Query().Get("id")); id != "" {
		return id, nil
	}
	return "", errors.New("could not find a file ID in the Google Drive URL")
}

func driveFilename(disposition, fallback string) string {
	matched := regexp.MustCompile(`(?i)filename="?([^";]+)`).FindStringSubmatch(disposition)
	if len(matched) == 2 {
		return safeFileName.ReplaceAllString(filepath.Base(matched[1]), "_")
	}
	// Do not assume TXT when Drive omits Content-Disposition; the caller can
	// then identify DOCX/PDF from Content-Type or the file signature.
	return "google-drive-" + fallback
}

func formatFromContent(contentType string, data []byte) string {
	contentType = strings.ToLower(contentType)
	if strings.Contains(contentType, "pdf") || bytes.HasPrefix(data, []byte("%PDF")) {
		return "pdf"
	}
	if strings.Contains(contentType, "wordprocessingml") || bytes.HasPrefix(data, []byte("PK")) {
		return "docx"
	}
	return "txt"
}

func allowedReferenceExtension(extension string) bool {
	extension = strings.ToLower(extension)
	return extension == ".wav" || extension == ".mp3" || extension == ".flac"
}
func safeReferenceName(value string) string {
	value = safeFileName.ReplaceAllString(filepath.Base(value), "-")
	value = strings.Trim(value, ".-")
	if value == "" {
		return "reference.wav"
	}
	return value
}
func first(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}
func copyVoices(values []VoiceProfile) []VoiceProfile {
	if len(values) == 0 {
		return []VoiceProfile{}
	}
	return append([]VoiceProfile(nil), values...)
}
func copyHistory(values []GenerationHistory) []GenerationHistory {
	if len(values) == 0 {
		return []GenerationHistory{}
	}
	return append([]GenerationHistory(nil), values...)
}

func copyFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	temporary := destination + ".tmp"
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		_ = os.Remove(temporary)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return closeErr
	}
	if err := os.Remove(destination); err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, destination)
}

func demoVoices() []DemoVoice {
	voices := []DemoVoice{
		{ID: "demo-linh", Name: "Linh", Language: "vi", Accent: "Nữ · ấm áp", Rate: 0.96, Pitch: 1.08, Sample: "Xin chào, rất vui được gặp bạn. Đây là giọng demo hệ thống của KOVA Voice Studio."},
		{ID: "demo-minh", Name: "Minh", Language: "vi", Accent: "Nam · rõ ràng", Rate: 0.94, Pitch: 0.88, Sample: "Xin chào, rất vui được gặp bạn. Đây là giọng demo hệ thống của KOVA Voice Studio."},
		{ID: "demo-aria", Name: "Aria", Language: "en", Accent: "English · calm", Rate: 0.94, Pitch: 1.04, Sample: "Hello, it is lovely to meet you. This is a KOVA Voice Studio system demo voice."},
		{ID: "demo-noah", Name: "Noah", Language: "en", Accent: "English · narrative", Rate: 0.92, Pitch: 0.90, Sample: "Hello, it is lovely to meet you. This is a KOVA Voice Studio system demo voice."},
	}
	sort.Slice(voices, func(i, j int) bool { return voices[i].ID < voices[j].ID })
	return voices
}
