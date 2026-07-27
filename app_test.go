package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestApplicationVersionUsesKovaReleaseFormat(t *testing.T) {
	parts := strings.Split(applicationVersion, ".")
	if len(parts) != 4 {
		t.Fatalf("application version must have four numeric parts, got %q", applicationVersion)
	}
	for _, part := range parts {
		if _, err := strconv.Atoi(part); err != nil {
			t.Fatalf("application version has a non-numeric component: %q", applicationVersion)
		}
	}
	build, err := strconv.Atoi(parts[3])
	if err != nil || build < 0 || build > 9 {
		t.Fatalf("fourth version component must be 0 through 9, got %q", applicationVersion)
	}
}

func TestRequestContextRemainsActiveWhileResponseBodyIsRead(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "audio/wav")
		response.WriteHeader(http.StatusOK)
		response.(http.Flusher).Flush()
		time.Sleep(75 * time.Millisecond)
		_, _ = response.Write([]byte("RIFF-delayed-audio"))
	}))
	defer server.Close()

	app := NewApp()
	app.client = server.Client()
	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := app.do(request, time.Second)
	if err != nil {
		t.Fatalf("start request: %v", err)
	}
	defer response.Body.Close()
	audio, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read delayed response body: %v", err)
	}
	if string(audio) != "RIFF-delayed-audio" {
		t.Fatalf("unexpected delayed audio body: %q", audio)
	}
}

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
		ReferenceText:    "Xin chào, đây là đoạn mẫu của Lan.",
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
	if !strings.Contains(string(stateBytes), `"reference_file"`) || !strings.Contains(string(stateBytes), `"reference_text"`) {
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

func TestCreateVoiceRequiresUserReviewedReferenceTranscript(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("KOVA_VOICE_STUDIO_DATA_DIR", dataDir)
	reference := filepath.Join(dataDir, "speaker.wav")
	if err := os.WriteFile(reference, []byte("reference-audio"), 0600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	_, err := app.CreateVoice(VoiceCreateRequest{
		WorkerSession: WorkerSession{BaseURL: "https://worker.example", Token: "session-token"},
		Name:          "Reviewed voice", Language: "vi", ReferencePath: reference, ConsentConfirmed: true,
	})
	if err == nil || !strings.Contains(err.Error(), "transcript") {
		t.Fatalf("expected transcript validation error, got %v", err)
	}
}

func TestEmotionPresetsExposeOnlyRecognizedTokens(t *testing.T) {
	allowed := map[string]bool{
		"[laughter]": true, "[sigh]": true, "[confirmation-en]": true,
		"[question-en]": true, "[question-ah]": true, "[question-oh]": true, "[question-ei]": true, "[question-yi]": true,
		"[surprise-ah]": true, "[surprise-oh]": true, "[surprise-wa]": true, "[surprise-yo]": true, "[dissatisfaction-hnn]": true,
	}
	for _, preset := range emotionPresets() {
		for _, token := range preset.Tokens {
			if !allowed[token] {
				t.Fatalf("preset %s exposes an unrecognized token %q", preset.ID, token)
			}
		}
	}
}

func TestAutoTranscribeReferenceReturnsAnEditableDraft(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("KOVA_VOICE_STUDIO_DATA_DIR", dataDir)
	reference := filepath.Join(dataDir, "speaker.wav")
	if err := os.WriteFile(reference, []byte("reference-audio"), 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v2/jobs/transcription" {
			http.NotFound(response, request)
			return
		}
		if request.URL.Path != "/transcribe-reference" || request.Header.Get("Authorization") != "Bearer session-token" {
			http.Error(response, "unexpected request", http.StatusBadRequest)
			return
		}
		if err := request.ParseMultipartForm(maxReferenceBytes); err != nil || request.FormValue("language") != "vi" {
			http.Error(response, "invalid multipart body", http.StatusBadRequest)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"text":"Đây là transcript nháp."}`))
	}))
	defer server.Close()
	app := NewApp()
	app.client = server.Client()
	draft, err := app.AutoTranscribeReference(ReferenceTranscriptRequest{
		WorkerSession: WorkerSession{BaseURL: server.URL, Token: "session-token"},
		ReferencePath: reference, Language: "vi",
	})
	if err != nil {
		t.Fatalf("auto transcribe reference: %v", err)
	}
	if draft != "Đây là transcript nháp." {
		t.Fatalf("unexpected transcript draft: %q", draft)
	}
}

func TestColabNotebookIsHostedWithTheDesktopProject(t *testing.T) {
	if !strings.Contains(voiceStudioNotebookURL, "khoinguyen59/kova-voice-studio/blob/v"+applicationVersion+"/worker/notebooks/") {
		t.Fatalf("notebook must be embedded in this repository: %s", voiceStudioNotebookURL)
	}
	if strings.Contains(voiceStudioNotebookURL, "kova-video-dubbing") {
		t.Fatalf("desktop must not depend on the former worker repository: %s", voiceStudioNotebookURL)
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

func TestReadVoiceReferenceAudioUsesPrivateBackupWithoutWorker(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("KOVA_VOICE_STUDIO_DATA_DIR", dataDir)
	if err := os.MkdirAll(filepath.Join(dataDir, "references"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "references", "sample.wav"), []byte("RIFF-local-reference"), 0600); err != nil {
		t.Fatal(err)
	}
	state := studioState{Version: 1, Theme: "light", Locale: "vi", Voices: []VoiceProfile{{
		ID: "saved-profile", Name: "Local sample", Language: "vi", ReferenceFile: "sample.wav", BackupAvailable: true,
	}}}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "studio-state.json"), data, 0600); err != nil {
		t.Fatal(err)
	}

	dataURL, err := NewApp().ReadVoiceReferenceAudio(WorkerSession{}, "saved-profile")
	if err != nil {
		t.Fatalf("read local reference: %v", err)
	}
	if !strings.HasPrefix(dataURL, "data:audio/") || !strings.Contains(dataURL, ";base64,") {
		t.Fatalf("expected browser-playable local audio URL, got %q", dataURL)
	}
}

func TestReadVoiceReferenceAudioRecoversMissingBackupFromCurrentWorker(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("KOVA_VOICE_STUDIO_DATA_DIR", dataDir)
	state := studioState{Version: 1, Theme: "light", Locale: "vi", Voices: []VoiceProfile{{
		ID: "saved-profile", RemoteID: "worker-profile", Name: "Recovered sample", Language: "vi",
	}}}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "studio-state.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/profiles/worker-profile/reference" || request.Header.Get("Authorization") != "Bearer session-token" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Disposition", `attachment; filename="reference.wav"`)
		response.Header().Set("Content-Type", "audio/wav")
		_, _ = response.Write([]byte("RIFF-recovered-reference"))
	}))
	defer server.Close()
	app := NewApp()
	app.client = server.Client()
	dataURL, err := app.ReadVoiceReferenceAudio(WorkerSession{BaseURL: server.URL, Token: "session-token"}, "saved-profile")
	if err != nil {
		t.Fatalf("recover missing local reference: %v", err)
	}
	if !strings.HasPrefix(dataURL, "data:audio/") {
		t.Fatalf("expected browser-playable recovered audio URL, got %q", dataURL)
	}
	bootstrap, err := app.Bootstrap()
	if err != nil || len(bootstrap.Voices) != 1 || !bootstrap.Voices[0].BackupAvailable || bootstrap.Voices[0].ReferenceFile == "" {
		t.Fatalf("recovered reference was not persisted: voices=%#v err=%v", bootstrap.Voices, err)
	}
}

func TestGeneratedAudioUsesSelectedOutputFolderAndKeepsItsLocation(t *testing.T) {
	dataDir := t.TempDir()
	outputDir := t.TempDir()
	t.Setenv("KOVA_VOICE_STUDIO_DATA_DIR", dataDir)
	state := studioState{Version: 1, Theme: "light", Locale: "vi", Voices: []VoiceProfile{{
		ID: "saved-profile", RemoteID: "worker-profile", Name: "Saved voice", Language: "vi", Status: "ready",
	}}}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "studio-state.json"), data, 0600); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/voices":
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`[{"id":"worker-profile","name":"Saved voice","language":"vi","status":"ready"}]`))
		case "/generate":
			response.Header().Set("Content-Type", "audio/wav")
			_, _ = response.Write([]byte("RIFF-generated-audio"))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	app := NewApp()
	preferences, err := app.SavePreferences(PreferencesRequest{Theme: "light", Locale: "vi", AudioOutputDir: outputDir})
	if err != nil {
		t.Fatalf("save output preference: %v", err)
	}
	if preferences.AudioOutputDir != outputDir {
		t.Fatalf("output folder was not persisted: %q", preferences.AudioOutputDir)
	}
	result, err := app.GenerateVoice(GenerateRequest{
		WorkerSession: WorkerSession{BaseURL: server.URL, Token: "session-token"},
		VoiceID:       "saved-profile", Text: "Save this in the selected folder", Language: "vi", Speed: 1, Steps: 8,
	})
	if err != nil {
		t.Fatalf("generate audio: %v", err)
	}
	if result.History.StorageDir != outputDir {
		t.Fatalf("history did not retain its selected folder: %#v", result.History)
	}
	path := filepath.Join(outputDir, result.History.FileName)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("generated audio was not saved to selected folder: %v", err)
	}
	if _, err := app.DeleteHistory(result.History.ID); err != nil {
		t.Fatalf("delete external history: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("selected-folder audio was not deleted, stat error: %v", err)
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

func TestGatewayPricingRequiresExplicitNumericZero(t *testing.T) {
	tests := []struct {
		name    string
		pricing map[string]json.RawMessage
		want    bool
	}{
		{
			name:    "zero decimal strings",
			pricing: map[string]json.RawMessage{"prompt": json.RawMessage(`"0.00000000"`), "completion": json.RawMessage(`"0"`)},
			want:    true,
		},
		{
			name:    "zero JSON numbers",
			pricing: map[string]json.RawMessage{"prompt": json.RawMessage(`0`), "completion": json.RawMessage(`0e0`)},
			want:    true,
		},
		{
			name:    "non-zero decimal",
			pricing: map[string]json.RawMessage{"prompt": json.RawMessage(`"0.000001"`), "completion": json.RawMessage(`"0"`)},
			want:    false,
		},
		{
			name:    "unparseable pricing",
			pricing: map[string]json.RawMessage{"prompt": json.RawMessage(`"free"`)},
			want:    false,
		},
		{
			name:    "missing pricing",
			pricing: map[string]json.RawMessage{},
			want:    false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := gatewayPricingIsFree(test.pricing); got != test.want {
				t.Fatalf("gatewayPricingIsFree(%v) = %v, want %v", test.pricing, got, test.want)
			}
		})
	}
}

func TestNormalizeGatewayURLRequiresHTTPSOutsideLocalhost(t *testing.T) {
	got, err := normalizeGatewayURL("https://gateway.example.test")
	if err != nil || got != "https://gateway.example.test/v1" {
		t.Fatalf("normalize HTTPS gateway = %q, %v", got, err)
	}
	got, err = normalizeGatewayURL("http://localhost:8080/v1/")
	if err != nil || got != "http://localhost:8080/v1" {
		t.Fatalf("normalize local gateway = %q, %v", got, err)
	}
	if _, err := normalizeGatewayURL("http://gateway.example.test"); err == nil {
		t.Fatal("remote HTTP gateway must be rejected")
	}
}
