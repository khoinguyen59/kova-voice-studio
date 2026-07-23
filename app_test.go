package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCloneProfilePersistsReferenceAndRestoresAfterRestart(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("KOVA_VOICE_STUDIO_DATA_DIR", dataDir)

	var profileUploads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer session-only-token" {
			http.Error(response, "missing token", http.StatusUnauthorized)
			return
		}
		switch request.URL.Path {
		case "/profiles":
			if err := request.ParseMultipartForm(maxReferenceBytes); err != nil {
				http.Error(response, err.Error(), http.StatusBadRequest)
				return
			}
			file, _, err := request.FormFile("ref_audio")
			if err != nil {
				http.Error(response, "reference is required", http.StatusBadRequest)
				return
			}
			defer file.Close()
			if audio, _ := io.ReadAll(file); len(audio) == 0 {
				http.Error(response, "empty reference", http.StatusBadRequest)
				return
			}
			id := "worker-profile-initial"
			if profileUploads.Add(1) > 1 {
				id = "worker-profile-restored"
			}
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"id":"` + id + `","profile":{"id":"` + id + `","name":"Lan da luu","language":"vi","status":"ready","reference_clean":true}}`))
		case "/v1/voices":
			// A reset Colab returns no voices. ensureRemote must use the private
			// local reference backup instead of asking the user to create again.
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`[]`))
		case "/generate":
			response.Header().Set("Content-Type", "audio/wav")
			_, _ = response.Write([]byte("RIFF-test-wav"))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	reference := filepath.Join(dataDir, "speaker.wav")
	if err := os.WriteFile(reference, []byte("reference-audio"), 0600); err != nil {
		t.Fatal(err)
	}

	firstRun := NewApp()
	firstRun.client = server.Client()
	created, err := firstRun.CreateVoice(VoiceCreateRequest{
		WorkerSession:    WorkerSession{BaseURL: server.URL, Token: "session-only-token"},
		Name:             "Lan da luu",
		Language:         "vi",
		ReferencePath:    reference,
		ConsentConfirmed: true,
	})
	if err != nil {
		t.Fatalf("create voice: %v", err)
	}
	if !created.BackupAvailable || created.ReferenceFile == "" {
		t.Fatalf("created profile has no persistent backup: %#v", created)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "references", created.ReferenceFile)); err != nil {
		t.Fatalf("reference backup was not saved: %v", err)
	}

	stateBytes, err := os.ReadFile(filepath.Join(dataDir, "studio-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(stateBytes), `"reference_file"`) {
		t.Fatal("persistent state does not contain the reference backup filename")
	}
	if strings.Contains(string(stateBytes), "session-only-token") {
		t.Fatal("session token must never be persisted")
	}

	secondRun := NewApp()
	secondRun.client = server.Client()
	bootstrap, err := secondRun.Bootstrap()
	if err != nil {
		t.Fatalf("load after restart: %v", err)
	}
	if len(bootstrap.Voices) != 1 {
		t.Fatalf("got %d persisted voices, want 1", len(bootstrap.Voices))
	}
	persisted := bootstrap.Voices[0]
	if persisted.Name != "Lan da luu" || !persisted.BackupAvailable || persisted.ReferenceFile != created.ReferenceFile {
		t.Fatalf("profile was not restored correctly: %#v", persisted)
	}

	_, err = secondRun.GenerateVoice(GenerateRequest{
		WorkerSession: WorkerSession{BaseURL: server.URL, Token: "session-only-token"},
		VoiceID:       persisted.ID,
		Text:          "Xin chao",
		Language:      "vi",
		Speed:         1,
		Steps:         8,
	})
	if err != nil {
		t.Fatalf("restore and generate after Colab reset: %v", err)
	}
	if profileUploads.Load() != 2 {
		t.Fatalf("expected exactly one restore upload after restart, got %d uploads", profileUploads.Load())
	}

	stateBytes, err = os.ReadFile(filepath.Join(dataDir, "studio-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state studioState
	if err := json.Unmarshal(stateBytes, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Voices) != 1 || state.Voices[0].RemoteID != "worker-profile-restored" {
		t.Fatalf("restored remote id was not saved: %#v", state.Voices)
	}
}

func TestMissingReferenceIsReportedAsUnavailableWithoutLosingProfile(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("KOVA_VOICE_STUDIO_DATA_DIR", dataDir)
	state := studioState{Version: 1, Theme: "dark", Locale: "vi", Voices: []VoiceProfile{{
		ID: "saved-profile", RemoteID: "remote-profile", Name: "Still visible", Language: "vi",
		ReferenceFile: "missing.wav", BackupAvailable: true,
	}}}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "studio-state.json"), data, 0600); err != nil {
		t.Fatal(err)
	}

	app := NewApp()
	bootstrap, err := app.Bootstrap()
	if err != nil {
		t.Fatal(err)
	}
	if len(bootstrap.Voices) != 1 || bootstrap.Voices[0].Name != "Still visible" || bootstrap.Voices[0].BackupAvailable {
		t.Fatalf("stale backup state was not repaired: %#v", bootstrap.Voices)
	}
}

func TestBootstrapReturnsEmptyArraysInsteadOfNull(t *testing.T) {
	t.Setenv("KOVA_VOICE_STUDIO_DATA_DIR", t.TempDir())
	app := NewApp()
	bootstrap, err := app.Bootstrap()
	if err != nil {
		t.Fatal(err)
	}
	if bootstrap.Voices == nil {
		t.Fatal("bootstrap voices must be an empty array, not null")
	}
	if bootstrap.History == nil {
		t.Fatal("bootstrap history must be an empty array, not null")
	}
	serialized, err := json.Marshal(bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(serialized), `"voices":null`) || strings.Contains(string(serialized), `"history":null`) {
		t.Fatalf("bootstrap JSON must not contain null collections: %s", serialized)
	}
}

func TestDocumentHelpersAndGatewayReviewPreserveUserControl(t *testing.T) {
	if got := normalizeImportedText(stripSRTText("1\n00:00:00,000 --> 00:00:01,000\nHello world.\n\n2\n00:00:02,000 --> 00:00:03,000\nXin chào.")); got != "Hello world.\n\nXin chào." {
		t.Fatalf("unexpected extracted SRT text: %q", got)
	}
	id, err := googleDriveFileID("https://drive.google.com/file/d/abc123/view?usp=sharing")
	if err != nil || id != "abc123" {
		t.Fatalf("extract Drive file id: %q, %v", id, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/chat/completions" || request.Header.Get("Authorization") != "Bearer session-key" {
			http.Error(response, "unexpected gateway request", http.StatusBadRequest)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"choices":[{"message":{"content":"{\"revised_text\":\"Bản đã sửa.\",\"review_summary\":\"Đã sửa dấu câu.\",\"warnings\":[\"Kiểm tra tên riêng\"]}"}}]}`))
	}))
	defer server.Close()
	app := NewApp()
	app.client = server.Client()
	review, err := app.ReviewTextWithGateway(TextReviewRequest{GatewayURL: server.URL, APIKey: "session-key", Model: "test", Text: "Ban da sua", Language: "vi", SourceFormat: "txt"})
	if err != nil || review.RevisedText != "Bản đã sửa." || len(review.Warnings) != 1 {
		t.Fatalf("unexpected review: %#v, %v", review, err)
	}
}

func TestGatewayModelCatalogOnlyLabelsExplicitlyFreeModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/models" || request.Header.Get("Authorization") != "Bearer session-key" {
			http.Error(response, "unexpected gateway request", http.StatusBadRequest)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":[
			{"id":"paid-model","name":"Paid model","pricing":{"prompt":"0.000001","completion":"0.000002"}},
			{"id":"free-model","name":"Free model","pricing":{"prompt":"0","completion":"0"}}
		]}`))
	}))
	defer server.Close()
	app := NewApp()
	app.client = server.Client()
	models, err := app.ListGatewayModels(GatewayModelsRequest{GatewayURL: server.URL, APIKey: "session-key"})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "free-model" || !models[0].Free || !models[0].PricingKnown {
		t.Fatalf("expected only explicit free model, got %#v", models)
	}
}

func TestGatewayModelCatalogDoesNotGuessPricing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":[{"id":"worker-model","name":"Worker model"}]}`))
	}))
	defer server.Close()
	app := NewApp()
	app.client = server.Client()
	models, err := app.ListGatewayModels(GatewayModelsRequest{GatewayURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].Free || models[0].PricingKnown {
		t.Fatalf("pricing must remain unknown instead of being labeled free: %#v", models)
	}
}

func TestOneTimeColabPairingIsConsumedWithoutPersistingToken(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("KOVA_VOICE_STUDIO_DATA_DIR", dataDir)
	const code = "abcdefghijklmnopqrstuvwxyz012345"
	const token = "one-time-session-token"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/pairing/" + code:
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"token":"` + token + `"}`))
		case "/v1/health":
			if request.Header.Get("Authorization") != "Bearer "+token {
				http.Error(response, "missing token", http.StatusUnauthorized)
				return
			}
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"device":"cuda"}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	pairing := "kova-voice-studio://pair?worker_url=" + url.QueryEscape(server.URL) + "&code=" + code
	if err := storeIncomingPairing(pairing); err != nil {
		t.Fatalf("store pairing link: %v", err)
	}
	app := NewApp()
	app.client = server.Client()
	pair, err := app.ConsumeIncomingColabPairing()
	if err != nil {
		t.Fatalf("consume pairing link: %v", err)
	}
	if pair == nil || pair.WorkerURL != server.URL || pair.Token != token {
		t.Fatalf("unexpected pairing result: %#v", pair)
	}
	if next, err := app.ConsumeIncomingColabPairing(); err != nil || next != nil {
		t.Fatalf("pairing inbox should be empty after one consume: %#v, %v", next, err)
	}
	stateBytes, err := os.ReadFile(filepath.Join(dataDir, "studio-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stateBytes), token) {
		t.Fatal("pairing token must remain session-only and never be persisted")
	}
}
