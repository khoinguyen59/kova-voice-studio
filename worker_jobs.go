package main

// Worker v2 uses short requests plus polling instead of holding an HTTP
// connection open while Colab performs GPU inference. This is intentionally a
// small client rather than a new dependency so the desktop executable stays
// self-contained.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var errWorkerJobProtocolUnsupported = errors.New("worker job protocol is unavailable")

type workerJobError struct {
	Code        string `json:"code"`
	Message     string `json:"message"`
	Retryable   bool   `json:"retryable"`
	RequestID   string `json:"request_id"`
	DebugDetail string `json:"debug_detail"`
}

type workerJob struct {
	ID              string          `json:"id"`
	Kind            string          `json:"kind"`
	Status          string          `json:"status"`
	Stage           string          `json:"stage"`
	Percent         int             `json:"percent"`
	Message         string          `json:"message"`
	CancelRequested bool            `json:"cancel_requested"`
	Result          json.RawMessage `json:"result"`
	Error           *workerJobError `json:"error"`
}

// CancelWorkerJob requests cancellation of a queued or running v2 worker job.
// GPU inference itself is not forcibly interrupted, but the worker guarantees
// a cancelled job will not persist a profile or deliver generated audio.
func (a *App) CancelWorkerJob(session WorkerSession, jobID string) error {
	baseURL, err := normalizeWorkerURL(session.BaseURL)
	if err != nil {
		return err
	}
	if strings.TrimSpace(session.Token) == "" {
		return errors.New("paste the current Colab worker token before cancelling a task")
	}
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		return errors.New("worker job id is unavailable")
	}
	request, err := http.NewRequest(http.MethodDelete, baseURL+"/v2/jobs/"+url.PathEscape(jobID), nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(session.Token))
	response, err := a.do(request, workerRequestTimeout)
	if err != nil {
		return fmt.Errorf("cancel worker task: %w", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode == http.StatusNotFound {
		return errWorkerJobProtocolUnsupported
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("cancel worker task returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

func (a *App) uploadProfileWithJob(baseURL, token, name, language, referenceText, sourcePath string, separateMusic bool, progress *taskReporter) (VoiceProfile, error) {
	job, err := a.submitMultipartJob(baseURL, token, "/v2/jobs/profile", map[string]string{
		"name": name, "language": language, "ref_text": referenceText, "consent_confirmed": "true", "separate_music": strconv.FormatBool(separateMusic),
	}, sourcePath, profileUploadTimeout)
	if errors.Is(err, errWorkerJobProtocolUnsupported) {
		return a.uploadProfile(baseURL, token, name, language, referenceText, sourcePath, separateMusic)
	}
	if err != nil {
		return VoiceProfile{}, err
	}
	if progress != nil {
		progress.setJobID(job.ID)
	}
	job, err = a.waitForWorkerJob(baseURL, token, job, profileUploadTimeout, progress)
	if err != nil {
		return VoiceProfile{}, err
	}
	var result struct {
		ID      string       `json:"id"`
		Profile VoiceProfile `json:"profile"`
	}
	if err := json.Unmarshal(job.Result, &result); err != nil {
		return VoiceProfile{}, fmt.Errorf("decode created worker profile: %w", err)
	}
	if result.Profile.ID == "" {
		result.Profile.ID = result.ID
	}
	if result.Profile.ID == "" {
		return VoiceProfile{}, errors.New("worker job completed without a profile id")
	}
	return result.Profile, nil
}

func (a *App) transcribeWithJob(baseURL, token, sourcePath, language string, progress *taskReporter) (string, error) {
	job, err := a.submitMultipartJob(baseURL, token, "/v2/jobs/transcription", map[string]string{"language": language}, sourcePath, profileUploadTimeout)
	if errors.Is(err, errWorkerJobProtocolUnsupported) {
		return "", errWorkerJobProtocolUnsupported
	}
	if err != nil {
		return "", err
	}
	if progress != nil {
		progress.setJobID(job.ID)
	}
	job, err = a.waitForWorkerJob(baseURL, token, job, profileUploadTimeout, progress)
	if err != nil {
		return "", err
	}
	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(job.Result, &result); err != nil {
		return "", fmt.Errorf("decode worker transcript: %w", err)
	}
	return result.Text, nil
}

func (a *App) submitMultipartJob(baseURL, token, endpoint string, fields map[string]string, sourcePath string, timeout time.Duration) (workerJob, error) {
	file, err := os.Open(sourcePath)
	if err != nil {
		return workerJob{}, err
	}
	defer file.Close()

	reader, writer := io.Pipe()
	form := multipart.NewWriter(writer)
	writeErr := make(chan error, 1)
	go func() {
		defer close(writeErr)
		for key, value := range fields {
			if err := form.WriteField(key, value); err != nil {
				_ = writer.CloseWithError(err)
				writeErr <- err
				return
			}
		}
		part, err := form.CreateFormFile("ref_audio", filepath.Base(sourcePath))
		if err == nil {
			_, err = io.Copy(part, io.LimitReader(file, maxReferenceBytes+1))
		}
		if err == nil {
			err = form.Close()
		}
		if err != nil {
			_ = writer.CloseWithError(err)
			writeErr <- err
			return
		}
		_ = writer.Close()
		writeErr <- nil
	}()

	request, err := http.NewRequest(http.MethodPost, baseURL+endpoint, reader)
	if err != nil {
		return workerJob{}, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	request.Header.Set("Content-Type", form.FormDataContentType())
	response, err := a.do(request, timeout)
	if err != nil {
		return workerJob{}, err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	// Always wait for the multipart writer before file.Close runs. Older worker
	// fallbacks can answer 404 immediately without consuming the request body.
	writerErr := <-writeErr
	if response.StatusCode == http.StatusNotFound {
		return workerJob{}, errWorkerJobProtocolUnsupported
	}
	if writerErr != nil {
		return workerJob{}, writerErr
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return workerJob{}, fmt.Errorf("Voice Studio job submission returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var job workerJob
	if err := json.Unmarshal(body, &job); err != nil || job.ID == "" {
		if err == nil {
			err = errors.New("job id is missing")
		}
		return workerJob{}, fmt.Errorf("decode Voice Studio job: %w", err)
	}
	return job, nil
}

func (a *App) submitGenerationJob(baseURL, token string, request GenerateRequest, remoteID string) (workerJob, error) {
	payload, err := json.Marshal(map[string]any{
		"text": request.Text, "profile_id": remoteID, "language": request.Language,
		"speed": request.Speed, "num_step": request.Steps,
	})
	if err != nil {
		return workerJob{}, err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, baseURL+"/v2/jobs/generation", bytes.NewReader(payload))
	if err != nil {
		return workerJob{}, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := a.do(httpRequest, workerRequestTimeout)
	if err != nil {
		return workerJob{}, err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode == http.StatusNotFound {
		return workerJob{}, errWorkerJobProtocolUnsupported
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return workerJob{}, fmt.Errorf("Voice Studio generation job returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var job workerJob
	if err := json.Unmarshal(body, &job); err != nil || job.ID == "" {
		if err == nil {
			err = errors.New("job id is missing")
		}
		return workerJob{}, fmt.Errorf("decode generation job: %w", err)
	}
	return job, nil
}

func (a *App) waitForWorkerJob(baseURL, token string, job workerJob, timeout time.Duration, progress *taskReporter) (workerJob, error) {
	deadline := time.Now().Add(timeout)
	for {
		if progress != nil {
			progress.update("worker_"+first(job.Stage, "queued"), max(5, min(95, job.Percent)), first(job.Message, "Colab GPU is processing the task"), "running")
		}
		switch job.Status {
		case "succeeded":
			return job, nil
		case "cancelled":
			return workerJob{}, errors.New("the worker task was cancelled")
		case "failed":
			if job.Error != nil && job.Error.Message != "" {
				message := job.Error.Message
				if strings.TrimSpace(job.Error.DebugDetail) != "" {
					message += " | debug: " + job.Error.DebugDetail
				}
				return workerJob{}, fmt.Errorf("worker task failed (%s): %s", job.Error.Code, message)
			}
			return workerJob{}, errors.New("worker task failed")
		}
		if time.Now().After(deadline) {
			return workerJob{}, errors.New("the Colab worker did not complete the task before the local timeout")
		}
		time.Sleep(750 * time.Millisecond)
		request, err := http.NewRequest(http.MethodGet, baseURL+"/v2/jobs/"+url.PathEscape(job.ID), nil)
		if err != nil {
			return workerJob{}, err
		}
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
		response, err := a.do(request, workerRequestTimeout)
		if err != nil {
			return workerJob{}, fmt.Errorf("poll worker task %s: %w", job.ID, err)
		}
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return workerJob{}, fmt.Errorf("worker task status returned %s: %s", response.Status, strings.TrimSpace(string(body)))
		}
		if err := json.Unmarshal(body, &job); err != nil || job.ID == "" {
			if err == nil {
				err = errors.New("job id is missing")
			}
			return workerJob{}, fmt.Errorf("decode worker task status: %w", err)
		}
	}
}

func (a *App) downloadWorkerJobAudio(baseURL, token, jobID string) ([]byte, error) {
	request, err := http.NewRequest(http.MethodGet, baseURL+"/v2/jobs/"+url.PathEscape(jobID)+"/audio", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	response, err := a.do(request, generationTimeout)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	audio, err := io.ReadAll(io.LimitReader(response.Body, maxGenerationBytes+1))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("download generated worker audio returned %s: %s", response.Status, strings.TrimSpace(string(audio)))
	}
	if len(audio) == 0 || int64(len(audio)) > maxGenerationBytes {
		return nil, errors.New("generated audio is empty or too large")
	}
	return audio, nil
}

func max(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
