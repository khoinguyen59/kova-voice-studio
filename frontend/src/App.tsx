import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EventsOn } from "../wailsjs/runtime/runtime";
import {
  Bootstrap,
  DemoVoice,
  EmotionPreset,
  Generated,
  GatewayModel,
  GenerationHistory,
  Health,
  ImportedDocument,
  Session,
  TextReviewResult,
  VoiceProfile,
  bootstrap,
  applyEmotionWithGateway,
	  autoTranscribeReference,
  checkWorker,
  createVoice,
  deleteHistory,
  deleteVoice,
  generateVoice,
  importGoogleDriveDocument,
  importTextDocument,
  listGatewayModels,
  openColabNotebook,
  openGoogleDrive,
  openHistoryAudio,
  previewVoice,
  readVoiceReferenceAudio,
  readReferenceAudioSource,
  refreshVoiceLibrary,
  savePreferences,
  selectAudioOutputDirectory,
  selectReferenceAudio,
  selectTextDocument,
  reviewTextWithGateway,
  saveTrimmedReferenceAudio,
  TaskProgress,
} from "./api";

type Page = "home" | "studio" | "library" | "history" | "settings";
type Notice = { type: "success" | "error" | "info"; message: string } | null;
type ScriptPreset = "short" | "medium" | "long";
type GatewayMode = "catalog" | "custom";

const initialFreeGatewayModels: GatewayModel[] = [
  {
    id: "openrouter/free",
    name: "OpenRouter · Free Models Router",
    free: true,
    pricing_known: true,
  },
];

const blankBootstrap: Bootstrap = {
  app_name: "KOVA Voice Studio",
  version: "",
  notebook_url: "",
  theme: "light",
  locale: "vi",
  worker_url: "",
  audio_output_dir: "",
  selected_voice_id: "",
  voices: [],
  history: [],
  demo_voices: [],
  emotion_presets: [],
};

const scriptPresets: Record<
  "vi" | "en",
  Record<ScriptPreset, { label: string; hint: string; value: string }>
> = {
  vi: {
    short: {
      label: "Ngắn",
      hint: "~15 giây",
      value:
        "Xin chào. Đây là bản nghe thử ngắn của KOVA Voice Studio, với giọng nói đã lưu của bạn.",
    },
    medium: {
      label: "Vừa",
      hint: "~45 giây",
      value:
        "Xin chào, đây là bản nghe thử với độ dài vừa. KOVA Voice Studio giúp bạn tái sử dụng một profile giọng đã lưu để tạo audio ổn định. Bạn có thể điều chỉnh tốc độ đọc, kiểm tra dấu câu và nghe lại kết quả trước khi dùng cho dự án của mình.",
    },
    long: {
      label: "Dài",
      hint: "~2 phút",
      value:
        "Xin chào, đây là bài kiểm tra dài để bạn đánh giá độ ổn định của giọng đọc. KOVA Voice Studio tách phần giọng nói khỏi nhạc trong audio mẫu trước khi tạo profile clone. Nhờ vậy, giọng tạo ra tập trung vào đặc điểm phát âm và nhịp điệu của người nói thay vì lẫn tiếng nhạc nền.\n\nTrong Phòng thu, profile đã lưu được tái sử dụng cho mọi bản audio. Bạn có thể sửa nội dung, điều chỉnh tốc độ đọc, sử dụng AI Gateway để rà soát chính tả, dấu câu, ngữ cảnh và tính logic, rồi nghe thử trước khi xuất. Việc kiểm tra theo từng bước giúp bạn giữ quyền quyết định đối với mỗi thay đổi của AI.\n\nBản đọc dài này cũng giúp phát hiện những chỗ nghỉ chưa tự nhiên, tên riêng cần giữ nguyên, hoặc câu quá dài. Sau khi nghe, hãy điều chỉnh văn bản theo ý của bạn rồi tạo lại audio. Profile giọng vẫn được lưu riêng trong thư viện để dùng lại nhanh ở lần sau.",
    },
  },
  en: {
    short: {
      label: "Short",
      hint: "~15 seconds",
      value:
        "Hello. This is a short KOVA Voice Studio listening test using your saved voice profile.",
    },
    medium: {
      label: "Medium",
      hint: "~45 seconds",
      value:
        "Hello, this is a medium-length listening test. KOVA Voice Studio reuses one saved voice profile to generate consistent audio. You can adjust reading speed, review punctuation, and listen to the result before using it in your project.",
    },
    long: {
      label: "Long",
      hint: "~2 minutes",
      value:
        "Hello, this is a longer listening test for evaluating the stability of a generated voice. KOVA Voice Studio separates speech from music in the reference recording before it creates a clone profile. That keeps the generated result focused on the speaker's pronunciation and rhythm instead of reproducing background music.\n\nIn the Studio, the saved profile is reused for every audio generation. You can edit the script, tune the speed, ask an AI Gateway to review spelling, punctuation, context, and logic, then listen before exporting. Each AI change remains under your review, so the original wording is never silently replaced.\n\nA longer test also reveals unnatural pauses, proper names that should remain unchanged, and sentences that need to be split. After listening, adjust the script as you wish and generate again. The voice profile stays in your private library for fast reuse next time.",
    },
  },
};

const text = (locale: "vi" | "en", vi: string, en: string) =>
  locale === "vi" ? vi : en;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const isAudioPath = (path: string) => /\.(wav|mp3|flac)$/i.test(path);
const safeList = <T,>(value: T[] | null | undefined): T[] =>
  Array.isArray(value) ? value : [];
const fileDropPaths = (event: unknown): string[] => {
  const value = (event as { data?: unknown })?.data ?? event;
  if (Array.isArray(value)) return value.filter((path): path is string => typeof path === "string");
  if (value && typeof value === "object") {
    const paths = (value as { paths?: unknown }).paths;
    if (Array.isArray(paths)) return paths.filter((path): path is string => typeof path === "string");
  }
  return [];
};
const normalizeBootstrap = (
  value: Bootstrap | null | undefined,
): Bootstrap => ({
  ...blankBootstrap,
  ...(value ?? {}),
  voices: safeList(value?.voices),
  history: safeList(value?.history),
  demo_voices: safeList(value?.demo_voices),
  emotion_presets: safeList(value?.emotion_presets),
});
const formatDate = (raw: string, locale: "vi" | "en") => {
  const date = new Date(raw);
  return Number.isNaN(date.valueOf())
    ? raw
    : new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
};
const formatElapsed = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingSeconds = seconds % 60;
  if (hours)
    return `${hours} giờ ${minutes % 60} phút ${remainingSeconds} giây`;
  if (minutes) return `${minutes} phút ${remainingSeconds} giây`;
  return `${remainingSeconds} giây`;
};

export default function App() {
  const [data, setData] = useState<Bootstrap>(blankBootstrap);
  const [page, setPage] = useState<Page>("home");
  const [workerURL, setWorkerURL] = useState("");
  const [token, setToken] = useState("");
  const [selectedID, setSelectedID] = useState("");
  const [theme, setTheme] = useState("light");
  const [locale, setLocale] = useState<"vi" | "en">("vi");
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [notice, setNotice] = useState<Notice>(null);
  const [profileName, setProfileName] = useState("");
  const [profileLanguage, setProfileLanguage] = useState<"vi" | "en">("vi");
  const [referencePath, setReferencePath] = useState("");
  const [referenceText, setReferenceText] = useState("");
	const [transcriptReviewed, setTranscriptReviewed] = useState(false);
  const [referenceSource, setReferenceSource] = useState("");
  const [trimmedReference, setTrimmedReference] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [script, setScript] = useState(
    "Xin chào, đây là KOVA Voice Studio. Tôi đang đọc bằng giọng đã chọn của bạn.",
  );
  const [scriptLanguage, setScriptLanguage] = useState<"vi" | "en">("vi");
  const [scriptPreset, setScriptPreset] = useState<ScriptPreset>("short");
  const [importedDocument, setImportedDocument] =
    useState<ImportedDocument | null>(null);
  const [driveURL, setDriveURL] = useState("");
  const [gatewayURL, setGatewayURL] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [gatewayModel, setGatewayModel] = useState("openrouter/free");
  const [gatewayModels, setGatewayModels] = useState<GatewayModel[]>(
    initialFreeGatewayModels,
  );
  const [gatewayMode, setGatewayMode] = useState<GatewayMode>("catalog");
  const [customGatewayURL, setCustomGatewayURL] = useState("");
  const [customGatewayKey, setCustomGatewayKey] = useState("");
  const [customGatewayModel, setCustomGatewayModel] = useState("");
  const [review, setReview] = useState<TextReviewResult | null>(null);
  const [speed, setSpeed] = useState(1);
  const [steps, setSteps] = useState(32);
  const [emotionID, setEmotionID] = useState("neutral");
  const [output, setOutput] = useState<Generated | null>(null);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);
  const [progressClock, setProgressClock] = useState(Date.now());
  const [loaded, setLoaded] = useState(false);

  const savedVoices = safeList(data?.voices);
  const history = safeList(data?.history);
  const demos = safeList(data?.demo_voices);
  const emotionPresets = safeList(data?.emotion_presets);
  const selectedEmotion =
    emotionPresets.find((preset) => preset.id === emotionID) ??
    emotionPresets[0] ??
    null;
  const selected = savedVoices.find((voice) => voice.id === selectedID) ?? null;

  useEffect(() => {
    if (loaded) return;
    setLoaded(true);
    void loadBootstrap();
  }, [loaded]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!window.go?.main?.App) return;
    return EventsOn(
      "kova:voice-progress",
      (event: { data?: TaskProgress } | TaskProgress) => {
        const payload =
          "data" in event && event.data ? event.data : (event as TaskProgress);
        if (payload && typeof payload.percent === "number")
          setTaskProgress(payload);
      },
    );
  }, []);

  useEffect(() => {
    if (!window.go?.main?.App) return;
    return EventsOn("wails:file-drop", async (event: unknown) => {
      const path = fileDropPaths(event)[0];
      if (!path) return;
      if (!isAudioPath(path)) {
        setNotice({
          type: "error",
          message: text(locale, "Chỉ nhận tệp WAV, MP3 hoặc FLAC.", "Only WAV, MP3, and FLAC files are supported."),
        });
        return;
      }
      setReferencePath(path);
	  setReferenceText("");
	  setTranscriptReviewed(false);
	  setTrimmedReference(null);
	  try { setReferenceSource(await readReferenceAudioSource(path)); } catch (error) { setNotice({ type: "error", message: messageOf(error) }); }
      setPage("library");
      setNotice({
        type: "success",
        message: text(locale, "Đã nhận audio mẫu từ File Explorer. KOVA chỉ lưu đường dẫn cho đến khi bạn tạo profile.", "Reference audio was received from File Explorer. KOVA keeps only its path until you create the profile."),
      });
    });
  }, [locale]);

  useEffect(() => {
    if (taskProgress?.status !== "running") return;
    const interval = window.setInterval(
      () => setProgressClock(Date.now()),
      1000,
    );
    return () => window.clearInterval(interval);
  }, [taskProgress?.status]);

  async function loadBootstrap() {
    try {
      const result = await bootstrap();
      const normalized = normalizeBootstrap(result);
      setData(normalized);
      setWorkerURL(normalized.worker_url);
      setSelectedID(normalized.selected_voice_id);
      setTheme(normalized.theme);
      setLocale(normalized.locale);
    } catch (error) {
      setNotice({ type: "error", message: messageOf(error) });
    }
  }

  async function saveLocalPreferences(
    next: Partial<{
      theme: string;
      locale: "vi" | "en";
      workerURL: string;
      audioOutputDir: string;
      selectedID: string;
    }> = {},
  ) {
    const request = {
      theme: next.theme ?? theme,
      locale: next.locale ?? locale,
      worker_url: next.workerURL ?? workerURL,
      audio_output_dir: next.audioOutputDir ?? data.audio_output_dir,
      selected_voice_id: next.selectedID ?? selectedID,
    };
    const result = await savePreferences(request);
    const normalized = normalizeBootstrap(result);
    setData(normalized);
    setTheme(normalized.theme);
    setLocale(normalized.locale);
    setWorkerURL(normalized.worker_url);
    setSelectedID(normalized.selected_voice_id);
  }

  async function run<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setNotice(null);
    try {
      return await task();
    } catch (error) {
      setNotice({ type: "error", message: messageOf(error) });
    } finally {
      setBusy("");
    }
  }

  const session = (): Session => ({
    base_url: workerURL.trim(),
    token: token.trim(),
  });

  async function beginColabPairing() {
    await run("notebook", async () => {
      setHealth(null);
      setToken("");
      await saveLocalPreferences({ workerURL: "" });
      await openColabNotebook();
      setNotice({
        type: "info",
        message: text(
          locale,
          "Đã mở Colab. Sau khi Run all xong, sao chép KOVA_VOICE_URL và KOVA_VOICE_TOKEN ở cell cuối, dán vào hai ô trong KOVA rồi bấm Kiểm tra kết nối.",
          "Colab is open. After Run all, copy KOVA_VOICE_URL and KOVA_VOICE_TOKEN from the final cell, paste them into KOVA, then click Check connection.",
        ),
      });
    });
  }

  async function chooseFile() {
    await run("choose", async () => {
      const path = await selectReferenceAudio();
      if (!path) return;
      setReferencePath(path);
	  setReferenceText("");
	  setTranscriptReviewed(false);
	  setTrimmedReference(null);
	  setReferenceSource(await readReferenceAudioSource(path));
    });
  }

  async function chooseAudioOutput() {
    await run("audioOutputDirectory", async () => {
      const directory = await selectAudioOutputDirectory();
      if (!directory) return;
      await saveLocalPreferences({ audioOutputDir: directory });
      setNotice({ type: "success", message: text(locale, "Đã chọn nơi lưu audio tạo mới.", "Selected where newly generated audio is saved.") });
    });
  }

  async function autoTranscribeSample() {
    await run("transcribeReference", async () => {
      if (!referencePath)
        throw new Error(text(locale, "Chọn audio mẫu trước khi tạo transcript nháp.", "Choose reference audio before requesting a transcript draft."));
      const draft = await autoTranscribeReference({
        ...session(),
        reference_path: referencePath,
        reference_data_url: trimmedReference ?? "",
        language: profileLanguage,
      });
      setReferenceText(draft);
      setTranscriptReviewed(false);
      setNotice({ type: "info", message: text(locale, "Đã nhận transcript nháp. Hãy nghe, sửa nếu cần và đánh dấu đã kiểm tra trước khi tạo profile.", "Transcript draft received. Listen, correct it if needed, then mark it reviewed before creating the profile.") });
    });
  }

  async function createProfile() {
    await run("create", async () => {
      if (!profileName.trim())
        throw new Error(
          text(
            locale,
            "Nhập tên cho giọng clone trước.",
            "Enter a name for the cloned voice first.",
          ),
        );
      if (!consent)
        throw new Error(
          text(
            locale,
            "Bạn cần xác nhận quyền sử dụng audio mẫu.",
            "You must confirm you have permission to use the reference audio.",
          ),
        );
	  if (!referenceText.trim())
		throw new Error(text(locale, "Hãy nhập đúng lời nói trong đoạn audio mẫu để OmniVoice bám theo giọng, không tự đoán lại.", "Enter the exact spoken words in the reference audio so OmniVoice does not guess them again."));
	  if (!transcriptReviewed)
		throw new Error(text(locale, "Hãy xác nhận rằng bạn đã xem và sửa transcript audio mẫu trước khi tạo profile.", "Confirm that you reviewed and corrected the reference transcript before creating the profile."));
      const activeSession = session();
	  const sourcePath = trimmedReference
		? await saveTrimmedReferenceAudio(trimmedReference)
		: referencePath;
      const profile = await createVoice({
        ...activeSession,
        name: profileName,
        language: profileLanguage,
        reference_path: sourcePath,
		  reference_text: referenceText,
        consent_confirmed: consent,
      });
      setData((current) => ({
        ...current,
        voices: [
          ...safeList(current.voices).filter(
            (voice) => voice.id !== profile.id,
          ),
          profile,
        ],
        selected_voice_id: profile.id,
      }));
      setSelectedID(profile.id);
      await saveLocalPreferences({ selectedID: profile.id });
      setProfileName("");
      setReferencePath("");
	  setReferenceText("");
	  setTranscriptReviewed(false);
	  setReferenceSource("");
	  setTrimmedReference(null);
      setConsent(false);
      setNotice({
        type: "success",
        message: text(
          locale,
          `Đã lưu giọng “${profile.name}”. Audio mẫu được sao lưu cục bộ để dùng lại sau này.`,
          `“${profile.name}” was saved. The reference is backed up locally for future sessions.`,
        ),
      });
    });
  }

  async function selectVoice(id: string) {
    setSelectedID(id);
    await run("select", async () => {
      await saveLocalPreferences({ selectedID: id });
    });
  }

  async function refreshLibrary() {
    await run("refresh", async () => {
      const voices = await refreshVoiceLibrary(session());
      setData((current) => ({ ...current, voices: safeList(voices) }));
      setNotice({
        type: "success",
        message: text(
          locale,
          "Đã đồng bộ thư viện từ worker. Các clone đã lưu cục bộ vẫn được giữ nguyên.",
          "The worker library has been synced. Local saved clones were kept intact.",
        ),
      });
    });
  }

  async function checkConnection() {
    await run("health", async () => {
      const activeSession = session();
      if (!activeSession.base_url || !activeSession.token) {
        const next = {
          reachable: false,
          message: text(
            locale,
            "Hãy dán URL worker và token từ cell cuối của Colab trước khi kiểm tra kết nối.",
            "Paste the worker URL and token from the final Colab cell before checking the connection.",
          ),
        };
        setHealth(next);
        throw new Error(next.message);
      }
      const next = await checkWorker(activeSession);
      setHealth(next);
      if (!next.reachable) throw new Error(next.message);
      setNotice({
        type: "success",
        message: next.message + (next.device ? ` · ${next.device}` : ""),
      });
    });
  }

  function speakDemo(voice: DemoVoice) {
    if (!("speechSynthesis" in window)) {
      setNotice({
        type: "error",
        message: text(
          locale,
          "Trình WebView hiện không hỗ trợ demo giọng hệ thống.",
          "This WebView does not support system voice previews.",
        ),
      });
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(voice.sample);
    utterance.lang = voice.language === "vi" ? "vi-VN" : "en-US";
    utterance.rate = voice.rate;
    utterance.pitch = voice.pitch;
    const candidates = window.speechSynthesis
      .getVoices()
      .filter((candidate) =>
        candidate.lang.toLowerCase().startsWith(voice.language),
      );
    if (candidates[0]) utterance.voice = candidates[0];
    window.speechSynthesis.speak(utterance);
  }

  async function previewSelected() {
    await run("preview", async () => {
      if (!selected)
        throw new Error(
          text(
            locale,
            "Hãy chọn một giọng clone đã lưu.",
            "Choose a saved cloned voice.",
          ),
        );
      const result = await previewVoice({
        ...session(),
        voice_id: selected.id,
        text: "",
        language: selected.language,
        speed,
        steps,
		style_prompt: "",
      });
      setOutput(result);
      setNotice({
        type: "success",
        message: text(
          locale,
          "Đã tạo audio thử. Nghe trực tiếp trước khi tạo nội dung dài.",
          "Preview audio is ready. Listen before generating a longer script.",
        ),
      });
    });
  }

  async function generateSelected() {
    await run("generate", async () => {
      if (!selected)
        throw new Error(
          text(
            locale,
            "Hãy chọn một giọng clone đã lưu.",
            "Choose a saved cloned voice.",
          ),
        );
      const result = await generateVoice({
        ...session(),
        voice_id: selected.id,
        text: script,
        language: scriptLanguage,
        speed,
        steps,
		style_prompt: "",
      });
      setOutput(result);
      setData((current) => ({
        ...current,
        history: result.history?.id
          ? [
              result.history,
              ...safeList(current.history).filter(
                (entry) => entry.id !== result.history.id,
              ),
            ]
          : safeList(current.history),
      }));
      setNotice({
        type: "success",
        message: text(
          locale,
          "Đã tạo và lưu audio vào lịch sử của ứng dụng.",
          "Audio was generated and saved to the application history.",
        ),
      });
    });
  }

  function choosePreset(preset: ScriptPreset) {
    setScriptPreset(preset);
    setScript(scriptPresets[scriptLanguage][preset].value);
    setImportedDocument(null);
    setReview(null);
  }

  async function importFromComputer() {
    await run("importDocument", async () => {
      const path = await selectTextDocument();
      if (!path) return;
      const document = await importTextDocument(path);
      setScript(document.text);
      setImportedDocument(document);
      setReview(null);
      setNotice({
        type: "success",
        message: text(
          locale,
          `Đã nhập ${document.file_name}; bạn có thể kiểm tra và sửa trước khi tạo audio.`,
          `Imported ${document.file_name}; review or edit it before generating audio.`,
        ),
      });
    });
  }

  async function importFromDrive() {
    await run("importDrive", async () => {
      if (!driveURL.trim())
        throw new Error(
          text(
            locale,
            "Dán link chia sẻ Google Drive trước.",
            "Paste a Google Drive sharing link first.",
          ),
        );
      const document = await importGoogleDriveDocument(driveURL);
      setScript(document.text);
      setImportedDocument(document);
      setReview(null);
      setNotice({
        type: "success",
        message: text(
          locale,
          `Đã nhập ${document.file_name} từ Google Drive.`,
          `Imported ${document.file_name} from Google Drive.`,
        ),
      });
    });
  }

  async function openDriveBrowser() {
    await run("openDrive", async () => {
      await openGoogleDrive();
      setNotice({
        type: "info",
        message: text(
          locale,
          "Đã mở Google Drive trong trình duyệt mặc định. Chọn tệp, tạo liên kết chia sẻ rồi dán liên kết vào ô bên cạnh để nhập.",
          "Google Drive opened in your default browser. Choose a file, create a sharing link, then paste it into the field beside it to import.",
        ),
      });
    });
  }

  async function loadFreeGatewayModels() {
    await run("gatewayModels", async () => {
      const models = await listGatewayModels({
        gateway_url: gatewayURL,
        api_key: gatewayKey,
      });
      setGatewayModels(models);
      setGatewayModel((current) =>
        models.some((model) => model.id === current)
          ? current
          : models[0]?.id ?? "",
      );
      const explicitlyFree = models.every((model) => model.pricing_known);
      setNotice({
        type: "success",
        message: text(
          locale,
          explicitlyFree
            ? `Đã tải ${models.length} model miễn phí từ API Gateway.`
            : `Đã tải ${models.length} model từ API Gateway. Gateway này không công bố giá, nên KOVA không tự khẳng định chúng miễn phí.` ,
          explicitlyFree
            ? `Loaded ${models.length} free model(s) from the API Gateway.`
            : `Loaded ${models.length} model(s) from the API Gateway. This gateway does not publish pricing, so KOVA does not label them as free.`,
        ),
      });
    });
  }

  async function reviewWithGateway() {
    await run("review", async () => {
      const activeGateway =
        gatewayMode === "catalog"
          ? { url: gatewayURL, key: gatewayKey, model: gatewayModel }
          : {
              url: customGatewayURL,
              key: customGatewayKey,
              model: customGatewayModel,
            };
      const result = await reviewTextWithGateway({
        gateway_url: activeGateway.url,
        api_key: activeGateway.key,
        model: activeGateway.model,
        text: script,
        language: scriptLanguage,
        source_format: importedDocument?.format ?? "text",
      });
      setReview(result);
      setNotice({
        type: "info",
        message: text(
          locale,
          "AI đã hoàn tất rà soát. Bản gốc chưa bị thay đổi; hãy xem rồi chọn áp dụng nếu muốn.",
          "AI review is ready. Your original text has not changed; inspect it and apply only if you want.",
        ),
      });
    });
  }

  async function applyEmotionWithAI() {
    await run("emotion", async () => {
      if (!selectedEmotion)
        throw new Error(text(locale, "Chưa có danh sách cảm xúc OmniVoice.", "No OmniVoice emotion list is available."));
      const activeGateway =
        gatewayMode === "catalog"
          ? { url: gatewayURL, key: gatewayKey, model: gatewayModel }
          : { url: customGatewayURL, key: customGatewayKey, model: customGatewayModel };
      const result = await applyEmotionWithGateway({
        gateway_url: activeGateway.url,
        api_key: activeGateway.key,
        model: activeGateway.model,
        text: script,
        language: scriptLanguage,
        emotion_id: selectedEmotion.id,
      });
      setReview(result);
      setNotice({
        type: "info",
        message: text(locale, "AI đã chuẩn bị bản đọc có cảm xúc. Hãy xem và bấm áp dụng nếu phù hợp.", "AI prepared an emotional reading. Review it and apply only if it fits."),
      });
    });
  }

  async function createSavedVoiceSample(voice: VoiceProfile) {
    return run("voiceSample", async () => {
      const dataURL = await readVoiceReferenceAudio(voice.id);
      setNotice({
        type: "success",
        message: text(
          locale,
          `Đang phát audio mẫu đã backup của ${voice.name}.`,
          `Playing the backed-up reference audio for ${voice.name}.`,
        ),
      });
      return dataURL;
    });
  }

  function applyReview() {
    if (!review?.revised_text) return;
    setScript(review.revised_text);
    setReview(null);
    setNotice({
      type: "success",
      message: text(
        locale,
        "Đã áp dụng bản văn bản do AI rà soát. Bạn vẫn có thể sửa thêm trước khi tạo audio.",
        "Applied the AI-reviewed text. You can still edit it before generating audio.",
      ),
    });
  }

  async function removeVoice(voice: VoiceProfile) {
    if (
      !window.confirm(
        text(
          locale,
          `Xóa “${voice.name}” khỏi thư viện cục bộ? Audio mẫu backup cũng sẽ bị xóa.`,
          `Remove “${voice.name}” from the local library? Its backup reference will also be removed.`,
        ),
      )
    )
      return;
    await run("deleteVoice", async () => {
      const voices = await deleteVoice(session(), voice.id);
      setData((current) => ({ ...current, voices: safeList(voices) }));
      if (selectedID === voice.id) setSelectedID("");
      setNotice({
        type: "success",
        message: text(
          locale,
          "Đã xóa voice profile.",
          "Voice profile deleted.",
        ),
      });
    });
  }

  async function removeHistory(item: GenerationHistory) {
    await run("deleteHistory", async () => {
      const items = await deleteHistory(item.id);
      setData((current) => ({ ...current, history: safeList(items) }));
      if (output?.history?.id === item.id) setOutput(null);
    });
  }

  const filteredVoices = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    if (!query) return savedVoices;
    return savedVoices.filter((voice) =>
      `${voice.name} ${voice.language} ${voice.kind}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [libraryQuery, savedVoices]);

  const labels: Record<Page, [string, string]> = {
    home: ["Tổng quan", "Overview"],
    studio: ["Phòng thu", "Studio"],
    library: ["Thư viện giọng", "Voice library"],
    history: ["Lịch sử", "History"],
    settings: ["Cấu hình", "Settings"],
  };

  return (
    <div className="app-shell">
      <aside
        className="sidebar"
        aria-label={text(locale, "Điều hướng chính", "Primary navigation")}
      >
        <div className="brand">
          <span className="brand-mark">K</span>
          <span>
            <strong>KOVA</strong>
            <small>VOICE STUDIO</small>
          </span>
        </div>
        <nav className="nav-list">
          {(Object.keys(labels) as Page[]).map((item) => (
            <button
              key={item}
              className={`nav-item ${page === item ? "active" : ""}`}
              onClick={() => setPage(item)}
            >
              <span className="nav-dot" />
              {text(locale, labels[item][0], labels[item][1])}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card">
            <span>◈</span>
            <div>
              <strong>
                {text(locale, "Dữ liệu riêng tư", "Private data")}
              </strong>
              <p>
                {text(
                  locale,
                  "Audio mẫu và lịch sử nằm trên máy này.",
                  "Reference audio and history stay on this computer.",
                )}
              </p>
            </div>
          </div>
          <span className="version">v{data.version}</span>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">KOVA VOICE STUDIO</p>
            <h1>{text(locale, labels[page][0], labels[page][1])}</h1>
          </div>
          <div className="topbar-actions">
            <span className={`connection ${health?.reachable ? "good" : ""}`}>
              <i />
              {health?.reachable
                ? text(locale, "Worker sẵn sàng", "Worker ready")
                : text(locale, "Chưa kết nối worker", "Worker not connected")}
            </span>
            <select
              aria-label="Language"
              value={locale}
              onChange={(event) =>
                void run("locale", async () => {
                  const next = event.target.value as "vi" | "en";
                  await saveLocalPreferences({ locale: next });
                })
              }
            >
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
            </select>
            <button
              className="icon-button"
              aria-label={text(locale, "Đổi giao diện", "Change appearance")}
              onClick={() =>
                void run("theme", async () => {
                  const next = theme === "dark" ? "light" : "dark";
                  await saveLocalPreferences({ theme: next });
                })
              }
            >
              {theme === "dark" ? "☼" : "◐"}
            </button>
          </div>
        </header>

        {notice && (
          <div className={`notice ${notice.type}`} role="status">
            <span>
              {notice.type === "error"
                ? "!"
                : notice.type === "success"
                  ? "✓"
                  : "i"}
            </span>
            <p>{notice.message}</p>
            <button aria-label="Dismiss" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        )}

        {taskProgress && (
          <TaskProgressPanel
            progress={taskProgress}
            clock={progressClock}
            locale={locale}
          />
        )}

        {page === "home" && (
          <HomePage
            locale={locale}
            savedVoices={savedVoices}
            history={history}
            demos={demos}
            workerURL={workerURL}
            token={token}
            setWorkerURL={setWorkerURL}
            setToken={setToken}
            health={health}
            busy={busy}
            onOpenNotebook={() => void beginColabPairing()}
            onCheck={checkConnection}
            onRefresh={refreshLibrary}
            onDemo={speakDemo}
            onGoStudio={() => setPage("studio")}
          />
        )}
        {page === "studio" && (
          <StudioPage
            locale={locale}
            voices={savedVoices}
            selected={selected}
            selectedID={selectedID}
            onSelect={selectVoice}
            script={script}
            setScript={setScript}
            scriptLanguage={scriptLanguage}
            setScriptLanguage={setScriptLanguage}
            scriptPreset={scriptPreset}
            onPreset={choosePreset}
            importedDocument={importedDocument}
            driveURL={driveURL}
            setDriveURL={setDriveURL}
            onOpenDrive={openDriveBrowser}
            gatewayURL={gatewayURL}
            setGatewayURL={setGatewayURL}
            gatewayKey={gatewayKey}
            setGatewayKey={setGatewayKey}
            gatewayModel={gatewayModel}
            setGatewayModel={setGatewayModel}
            gatewayModels={gatewayModels}
            gatewayMode={gatewayMode}
            setGatewayMode={setGatewayMode}
            customGatewayURL={customGatewayURL}
            setCustomGatewayURL={setCustomGatewayURL}
            customGatewayKey={customGatewayKey}
            setCustomGatewayKey={setCustomGatewayKey}
            customGatewayModel={customGatewayModel}
            setCustomGatewayModel={setCustomGatewayModel}
            onLoadGatewayModels={loadFreeGatewayModels}
            review={review}
            onImportComputer={importFromComputer}
            onImportDrive={importFromDrive}
            onReview={reviewWithGateway}
			emotionPresets={emotionPresets}
			emotionID={emotionID}
			setEmotionID={setEmotionID}
			onApplyEmotion={applyEmotionWithAI}
            onApplyReview={applyReview}
            onDismissReview={() => setReview(null)}
            speed={speed}
            setSpeed={setSpeed}
            steps={steps}
            setSteps={setSteps}
            output={output}
			audioOutputDir={data.audio_output_dir}
			onChooseAudioOutput={chooseAudioOutput}
            busy={busy}
            onPreview={previewSelected}
            onGenerate={generateSelected}
            onLibrary={() => setPage("library")}
          />
        )}
        {page === "library" && (
          <LibraryPage
            locale={locale}
            voices={filteredVoices}
            query={libraryQuery}
            setQuery={setLibraryQuery}
            selectedID={selectedID}
            onSelect={selectVoice}
            onDelete={removeVoice}
            profileName={profileName}
            setProfileName={setProfileName}
            profileLanguage={profileLanguage}
            setProfileLanguage={setProfileLanguage}
            referencePath={referencePath}
			referenceText={referenceText}
			setReferenceText={setReferenceText}
			transcriptReviewed={transcriptReviewed}
			setTranscriptReviewed={setTranscriptReviewed}
			referenceSource={referenceSource}
			onTrimmedReference={setTrimmedReference}
            consent={consent}
            setConsent={setConsent}
            busy={busy}
            onChoose={chooseFile}
			onAutoTranscribe={autoTranscribeSample}
            onCreate={createProfile}
            onOpenNotebook={() => void beginColabPairing()}
            onReadReferenceAudio={createSavedVoiceSample}
          />
        )}
        {page === "history" && (
          <HistoryPage
            locale={locale}
            history={history}
            output={output}
            busy={busy}
            onOpen={(item) =>
              void run("open", async () => {
                await openHistoryAudio(item.id);
              })
            }
            onDelete={removeHistory}
          />
        )}
        {page === "settings" && (
          <SettingsPage
            locale={locale}
            setLocale={(next) =>
              void run("locale", async () => {
                await saveLocalPreferences({ locale: next });
              })
            }
            theme={theme}
            setTheme={(next) =>
              void run("theme", async () => {
                await saveLocalPreferences({ theme: next });
              })
            }
            workerURL={workerURL}
            token={token}
            health={health}
            busy={busy}
			audioOutputDir={data.audio_output_dir}
            setWorkerURL={setWorkerURL}
            setToken={setToken}
			onChooseAudioOutput={() =>
			  void run("audioOutputDirectory", async () => {
				const directory = await selectAudioOutputDirectory();
				if (!directory) return;
				await saveLocalPreferences({ audioOutputDir: directory });
				setNotice({
				  type: "success",
				  message: text(
					locale,
					"Đã chọn thư mục lưu audio tạo mới.",
					"Selected the folder for newly generated audio.",
				  ),
				});
			  })
			}
			onUsePrivateAudioOutput={() =>
			  void run("audioOutputDirectory", async () => {
				await saveLocalPreferences({ audioOutputDir: "" });
				setNotice({
				  type: "success",
				  message: text(
					locale,
					"Audio tạo mới sẽ lưu trong thư mục riêng của KOVA.",
					"New audio will be saved in KOVA's private folder.",
				  ),
				});
			  })
			}
            onSave={() =>
              void run("save", async () => {
                await saveLocalPreferences();
                setNotice({
                  type: "success",
                  message: text(
                    locale,
                    "Đã lưu cấu hình. Token Colab không được lưu trên máy.",
                    "Preferences saved. The Colab token was not saved on this computer.",
                  ),
                });
              })
            }
            onCheck={checkConnection}
            onOpenNotebook={() => void beginColabPairing()}
          />
        )}
      </main>
    </div>
  );
}

function HomePage(props: {
  locale: "vi" | "en";
  savedVoices: VoiceProfile[];
  history: GenerationHistory[];
  demos: DemoVoice[];
  workerURL: string;
  token: string;
  setWorkerURL(value: string): void;
  setToken(value: string): void;
  health: Health | null;
  busy: string;
  onOpenNotebook(): void;
  onCheck(): void;
  onRefresh(): void;
  onDemo(voice: DemoVoice): void;
  onGoStudio(): void;
}) {
  const {
    locale,
    savedVoices,
    history,
    demos,
    workerURL,
    token,
    setWorkerURL,
    setToken,
    health,
    busy,
  } = props;
  return (
    <div className="page-grid home-page">
      <section className="hero panel">
        <div className="hero-flow" aria-hidden="true">
          <svg viewBox="0 0 2880 260" preserveAspectRatio="none">
            <defs>
              <linearGradient id="heroWaveGradient" x1="0" x2="1">
                <stop offset="0%" stopColor="#1775ef" />
                <stop offset="52%" stopColor="#14b8de" />
                <stop offset="100%" stopColor="#4e8dff" />
              </linearGradient>
            </defs>
            <path
              className="hero-wave hero-wave-main"
              d="M0 130 Q90 62 180 130 T360 130 T540 130 T720 130 T900 130 T1080 130 T1260 130 T1440 130 T1620 130 T1800 130 T1980 130 T2160 130 T2340 130 T2520 130 T2700 130 T2880 130"
            />
            <path
              className="hero-wave hero-wave-soft"
              d="M0 130 Q90 62 180 130 T360 130 T540 130 T720 130 T900 130 T1080 130 T1260 130 T1440 130 T1620 130 T1800 130 T1980 130 T2160 130 T2340 130 T2520 130 T2700 130 T2880 130"
            />
          </svg>
        </div>
        <div>
          <span className="pill">
            {text(
              locale,
              "Studio giọng nói riêng",
              "Your private voice studio",
            )}
          </span>
          <h2>
            {text(
              locale,
              "Mỗi giọng clone là một tài sản của bạn.",
              "Every cloned voice is an asset you own.",
            )}
          </h2>
          <p>
            {text(
              locale,
              "Tạo profile một lần từ audio mẫu; Phòng thu chỉ tái sử dụng profile đã lưu để tạo audio, không clone lại giọng.",
              "Create a profile once from reference audio; Studio only reuses saved profiles to generate audio and never reclones the voice.",
            )}
          </p>
          <div className="button-row">
            <button className="primary" onClick={props.onGoStudio}>
              ✦ {text(locale, "Mở phòng thu", "Open studio")}
            </button>
            <button className="secondary" onClick={props.onOpenNotebook}>
              ↗{" "}
              {text(
                locale,
                "Mở notebook Google Colab",
                "Open Google Colab notebook",
              )}
            </button>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="voice-signature">
            <div className="signature-label">
              <i />
              <span>{text(locale, "TÍN HIỆU GIỌNG", "VOICE SIGNAL")}</span>
            </div>
            <div className="signature-waveform">
              <i /><i /><i /><i /><i /><i /><i /><i /><i />
            </div>
            <div className="signature-footer">
              <span>{text(locale, "PROFILE CỤC BỘ", "LOCAL PROFILE")}</span>
              <strong>{text(locale, "Sẵn sàng", "Ready")}</strong>
            </div>
          </div>
        </div>
      </section>
      <section className="metrics">
        {" "}
        <Metric
          label={text(locale, "Clone đã lưu", "Saved clones")}
          value={String(savedVoices.length)}
          icon="◉"
        />
        <Metric
          label={text(locale, "Audio đã tạo", "Generated audio")}
          value={String(history.length)}
          icon="♬"
        />
        <Metric
          label={text(locale, "Backup sẵn sàng", "Backups ready")}
          value={String(
            savedVoices.filter((voice) => voice.backup_available).length,
          )}
          icon="◈"
        />
        <Metric
          label={text(locale, "Trạng thái GPU", "GPU status")}
          value={health?.reachable ? "Online" : "—"}
          icon="⌁"
        />
      </section>
      <section className="panel worker-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              01 · {text(locale, "KẾT NỐI BỘ MÁY", "CONNECT THE ENGINE")}
            </p>
            <h3>
              {text(
                locale,
                "Kết nối KOVA Voice Studio GPU",
                "Connect KOVA Voice Studio GPU",
              )}
            </h3>
          </div>
          <span
            className={`status-badge ${health?.reachable ? "ready" : "idle"}`}
          >
            {health?.reachable
              ? text(locale, "Sẵn sàng", "Ready")
              : text(locale, "Cần kết nối", "Connect")}
          </span>
        </div>
        <div className="notice info automatic-pairing-notice">
          {text(
            locale,
            "Kết nối thủ công: chạy Run all trong Colab, rồi dán KOVA_VOICE_URL và KOVA_VOICE_TOKEN từ cell cuối vào bên dưới. Token chỉ dùng cho phiên hiện tại.",
            "Manual connection: Run all in Colab, then paste KOVA_VOICE_URL and KOVA_VOICE_TOKEN from the final cell below. The token is session-only.",
          )}
        </div>
        <details className="manual-worker-config" open>
          <summary>
            {text(
              locale,
              "Dán URL worker và token từ Colab",
              "Paste the worker URL and token from Colab",
            )}
          </summary>
        <div className="form-grid">
          <label>
            {text(locale, "URL worker Colab", "Colab worker URL")}
            <input
              value={workerURL}
              onChange={(event) => setWorkerURL(event.target.value)}
              placeholder="https://xxxxx.trycloudflare.com"
            />
          </label>
          <label>
            {text(locale, "Token phiên Colab", "Colab session token")}
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              placeholder={text(
                locale,
                "Chỉ dùng trong phiên này",
                "Only used for this session",
              )}
            />
          </label>
        </div>
        <div className="helper">
          {text(
            locale,
            "Mở notebook bằng nút phía trên, chọn GPU rồi Run all. Ở cell cuối, sao chép KOVA_VOICE_URL và KOVA_VOICE_TOKEN, dán vào đây, sau đó bấm Kiểm tra kết nối. Token không được lưu vào ổ đĩa.",
            "Open the notebook above, select a GPU, and Run all. In the final cell, copy KOVA_VOICE_URL and KOVA_VOICE_TOKEN, paste them here, then click Check connection. The token is never saved to disk.",
          )}
        </div>
        </details>
        <div className="button-row">
          <button
            className="primary"
            disabled={busy !== ""}
            onClick={props.onCheck}
          >
            {busy === "health" ? "…" : "◌"}{" "}
            {text(locale, "Kiểm tra kết nối", "Check connection")}
          </button>
          <button
            className="secondary"
            disabled={busy !== ""}
            onClick={props.onRefresh}
          >
            ↻ {text(locale, "Đồng bộ thư viện", "Sync library")}
          </button>
        </div>
      </section>
      <section className="panel demo-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              {text(locale, "DEMO HỆ THỐNG", "SYSTEM DEMOS")}
            </p>
            <h3>
              {text(
                locale,
                "Nghe nhanh phong cách giọng",
                "Try system voice styles",
              )}
            </h3>
          </div>
          <span className="subtle">
            {text(locale, "Không phải voice clone", "Not cloned voices")}
          </span>
        </div>
        <div className="demo-grid">
          {demos.map((voice) => (
            <article className="demo-card" key={voice.id}>
              <div className={`avatar ${voice.language}`}>
                <span>{voice.name.slice(0, 1)}</span>
              </div>
              <div>
                <strong>{voice.name}</strong>
                <p>{voice.accent}</p>
              </div>
              <button
                className="play-button"
                onClick={() => props.onDemo(voice)}
                aria-label={`${text(locale, "Nghe", "Preview")} ${voice.name}`}
              >
                ▶
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function StudioPage(props: {
  locale: "vi" | "en";
  voices: VoiceProfile[];
  selected: VoiceProfile | null;
  selectedID: string;
  onSelect(id: string): Promise<void>;
  script: string;
  setScript(value: string): void;
  scriptLanguage: "vi" | "en";
  setScriptLanguage(value: "vi" | "en"): void;
  scriptPreset: ScriptPreset;
  onPreset(preset: ScriptPreset): void;
  importedDocument: ImportedDocument | null;
  driveURL: string;
  setDriveURL(value: string): void;
  onOpenDrive(): void;
  gatewayURL: string;
  setGatewayURL(value: string): void;
  gatewayKey: string;
  setGatewayKey(value: string): void;
  gatewayModel: string;
  setGatewayModel(value: string): void;
  gatewayModels: GatewayModel[];
  gatewayMode: GatewayMode;
  setGatewayMode(value: GatewayMode): void;
  customGatewayURL: string;
  setCustomGatewayURL(value: string): void;
  customGatewayKey: string;
  setCustomGatewayKey(value: string): void;
  customGatewayModel: string;
  setCustomGatewayModel(value: string): void;
  onLoadGatewayModels(): void;
  review: TextReviewResult | null;
  onImportComputer(): void;
  onImportDrive(): void;
  onReview(): void;
	 emotionPresets: EmotionPreset[];
	 emotionID: string;
	 setEmotionID(value: string): void;
	 onApplyEmotion(): void;
  onApplyReview(): void;
  onDismissReview(): void;
  speed: number;
  setSpeed(value: number): void;
  steps: number;
  setSteps(value: number): void;
  output: Generated | null;
	 audioOutputDir: string;
	 onChooseAudioOutput(): void;
  busy: string;
  onPreview(): void;
  onGenerate(): void;
  onLibrary(): void;
}) {
  const {
    locale,
    voices,
    selected,
    selectedID,
    script,
    setScript,
    scriptLanguage,
    setScriptLanguage,
    scriptPreset,
    importedDocument,
    driveURL,
    setDriveURL,
    gatewayModels,
    gatewayMode,
    gatewayURL,
    gatewayKey,
    gatewayModel,
    customGatewayURL,
    customGatewayKey,
    customGatewayModel,
    review,
	 emotionPresets,
	 emotionID,
	 setEmotionID,
    speed,
    setSpeed,
    steps,
    setSteps,
    output,
	 audioOutputDir,
    busy,
  } = props;
  return (
    <div className="studio-layout">
      <section className="panel composer">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              02 · {text(locale, "TẠO ÂM THANH", "GENERATE AUDIO")}
            </p>
            <h2>
              {text(
                locale,
                "Viết, nghe và xuất giọng nói",
                "Write, listen, and export voice",
              )}
            </h2>
          </div>
          <span className="character-count">
            {script.length.toLocaleString()}/10,000
          </span>
        </div>
        <div className="voice-selector">
          <label>
            {text(locale, "Giọng clone cố định", "Fixed cloned voice")}
            <select
              value={selectedID}
              onChange={(event) => void props.onSelect(event.target.value)}
            >
              <option value="">
                {text(locale, "Chưa chọn profile", "No profile selected")}
              </option>
              {voices.map((voice) => (
                <option value={voice.id} key={voice.id}>
                  {voice.name} ·{" "}
                  {voice.language === "vi" ? "Tiếng Việt" : "English"}
                  {voice.backup_available ? " · saved" : ""}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <div className="selected-voice">
              <span className="avatar vi">{selected.name.slice(0, 1)}</span>
              <div>
                <strong>{selected.name}</strong>
                <small>
                  {selected.backup_available
                    ? text(
                        locale,
                        "Backup cục bộ sẵn sàng",
                        "Local backup ready",
                      )
                    : text(locale, "Không có backup cục bộ", "No local backup")}
                </small>
              </div>
            </div>
          ) : (
            <button className="outline" onClick={props.onLibrary}>
              + {text(locale, "Tạo clone mới", "Create a clone")}
            </button>
          )}
        </div>
        <section className="script-tools" aria-label={text(locale, "Công cụ nội dung", "Script tools")}>
          <div className="preset-heading">
            <div>
              <strong>{text(locale, "Bản văn bản kiểm tra", "Test script")}</strong>
              <small>{text(locale, "Chọn một mẫu rồi sửa tự do", "Choose a starting point, then edit freely")}</small>
            </div>
            {importedDocument && <span className="document-chip">{importedDocument.file_name} · {importedDocument.format.toUpperCase()}</span>}
          </div>
          <div className="preset-row">
            {(Object.keys(scriptPresets[scriptLanguage]) as ScriptPreset[]).map((preset) => (
              <button key={preset} type="button" className={`preset-button ${scriptPreset === preset ? "active" : ""}`} onClick={() => props.onPreset(preset)}>
                <strong>{scriptPresets[scriptLanguage][preset].label}</strong><small>{scriptPresets[scriptLanguage][preset].hint}</small>
              </button>
            ))}
          </div>
          <div className="import-row">
            <button className="secondary compact" type="button" disabled={busy !== ""} onClick={props.onImportComputer}>⇪ {text(locale, "Nhập từ máy", "Import from computer")}</button>
            <button className="secondary compact" type="button" disabled={busy !== ""} onClick={props.onOpenDrive}>☁ {text(locale, "Mở Google Drive", "Open Google Drive")}</button>
            <label className="drive-input"><input value={driveURL} onChange={(event) => setDriveURL(event.target.value)} placeholder={text(locale, "Link chia sẻ Google Drive", "Google Drive sharing link")} /><button className="secondary compact" type="button" disabled={busy !== ""} onClick={props.onImportDrive}>{text(locale, "Nhập Drive", "Import Drive")}</button></label>
          </div>
          <p className="helper">{text(locale, "Nhận TXT, SRT, MD, DOCX, PDF. Nút Drive mở Drive trong trình duyệt mặc định; sau khi chọn tệp, chỉ cần dán liên kết chia sẻ để nhập.", "Supports TXT, SRT, MD, DOCX, and PDF. The Drive button opens Drive in the default browser; after choosing a file, paste its sharing link to import.")}</p>
        </section>
        <label className="script-area">
          {text(locale, "Nội dung đọc", "Script")}
          <textarea
            value={script}
            onChange={(event) => setScript(event.target.value.slice(0, 10000))}
            placeholder={text(
              locale,
              "Nhập nội dung bạn muốn giọng này đọc…",
              "Enter the text this voice should read…",
            )}
          />
        </label>
        <section className="gateway-review" aria-label={text(locale, "Rà soát AI Gateway", "AI Gateway review")}>
          <div className="section-heading compact-heading"><div><strong>{text(locale, "AI Gateway · kiểm tra nội dung", "AI Gateway · content review")}</strong><p>{text(locale, "Rà soát ngữ cảnh, logic, chính tả và dấu câu. Chọn model có sẵn từ Gateway hoặc dùng API/model riêng; khóa chỉ tồn tại trong phiên này.", "Review context, logic, spelling, and punctuation. Choose a model from the Gateway catalogue or use your own API/model; the key exists only in this session.")}</p></div></div>
          <div className="gateway-mode" role="tablist" aria-label={text(locale, "Nguồn AI Gateway", "AI Gateway source")}>
            <button type="button" className={gatewayMode === "catalog" ? "active" : ""} onClick={() => props.setGatewayMode("catalog")}>{text(locale, "Model miễn phí có sẵn", "Available free models")}</button>
            <button type="button" className={gatewayMode === "custom" ? "active" : ""} onClick={() => props.setGatewayMode("custom")}>{text(locale, "Nhập API / model riêng", "Custom API / model")}</button>
          </div>
          {gatewayMode === "catalog" ? (
            <div className="gateway-catalog">
              <div className="gateway-grid catalog-grid">
                <input value={gatewayURL} onChange={(event) => props.setGatewayURL(event.target.value)} placeholder={text(locale, "URL API Gateway (…/v1 hoặc host)", "API Gateway URL (…/v1 or host)")} />
                <input type="password" value={gatewayKey} onChange={(event) => props.setGatewayKey(event.target.value)} placeholder={text(locale, "API key · không lưu", "API key · not saved")} />
                <button className="secondary compact" type="button" disabled={busy !== ""} onClick={props.onLoadGatewayModels}>{busy === "gatewayModels" ? text(locale, "Đang tải…", "Loading…") : text(locale, "Tải model miễn phí", "Load free models")}</button>
              </div>
              <div className="gateway-grid catalog-select-row">
                <select value={gatewayModel} onChange={(event) => props.setGatewayModel(event.target.value)} aria-label={text(locale, "Model miễn phí", "Free model")}>{gatewayModels.map((model) => <option key={model.id} value={model.id}>{model.name}{model.free ? " · Free" : model.pricing_known ? "" : text(locale, " · Gateway chưa báo giá", " · Gateway pricing unavailable")}</option>)}</select>
                <button className="secondary compact" type="button" disabled={!script.trim() || busy !== ""} onClick={props.onReview}>{busy === "review" ? text(locale, "Đang rà soát…", "Reviewing…") : text(locale, "Rà soát bằng AI", "Review with AI")}</button>
              </div>
              <p className="helper">{text(locale, "KOVA chỉ hiển thị là “miễn phí” khi Gateway công bố giá bằng 0. Nếu Gateway không công bố giá, app vẫn liệt kê model nhưng không đoán chi phí.", "KOVA labels a model as free only when the Gateway reports zero pricing. If no pricing is published, the model is listed without guessing its cost.")}</p>
            </div>
          ) : (
            <div className="gateway-grid custom-grid">
              <input value={customGatewayURL} onChange={(event) => props.setCustomGatewayURL(event.target.value)} placeholder={text(locale, "URL API riêng (…/v1 hoặc host)", "Custom API URL (…/v1 or host)")} />
              <input type="password" value={customGatewayKey} onChange={(event) => props.setCustomGatewayKey(event.target.value)} placeholder={text(locale, "API key riêng · không lưu", "Custom API key · not saved")} />
              <input value={customGatewayModel} onChange={(event) => props.setCustomGatewayModel(event.target.value)} placeholder={text(locale, "Tên model riêng", "Custom model name")} />
              <button className="secondary compact" type="button" disabled={!script.trim() || busy !== ""} onClick={props.onReview}>{busy === "review" ? text(locale, "Đang rà soát…", "Reviewing…") : text(locale, "Rà soát bằng AI", "Review with AI")}</button>
            </div>
          )}
          {review && <div className="review-result"><strong>{text(locale, "Bản AI đề xuất", "AI suggestion")}</strong><p>{review.review_summary || text(locale, "AI đã chuẩn hóa nội dung để bạn kiểm tra.", "AI normalized the content for your review.")}</p>{review.warnings.length > 0 && <ul>{review.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>}<textarea readOnly value={review.revised_text} aria-label={text(locale, "Bản AI đề xuất", "AI suggestion")} /><div className="button-row"><button type="button" className="primary compact" onClick={props.onApplyReview}>{text(locale, "Áp dụng bản AI", "Apply AI version")}</button><button type="button" className="secondary compact" onClick={props.onDismissReview}>{text(locale, "Giữ bản hiện tại", "Keep current version")}</button></div></div>}
        </section>
		<section className="emotion-control" aria-label="OmniVoice vocal style">
		  <div><strong>{text(locale, "Cảm xúc trong nội dung", "Emotion in the script")}</strong><p>{text(locale, "OmniVoice clone không nhận prompt cảm xúc tự do. Chọn phong cách rồi dùng AI Gateway chèn thẻ hợp lệ vào bản văn; nút tạo audio không gửi các cụm prompt không hợp lệ tới worker.", "OmniVoice cloning does not accept free-form emotion prompts. Select a style and use AI Gateway to place valid tags in the script; generation never sends unsupported prompt phrases to the worker.")}</p></div>
		  <div className="emotion-fields">
			<select value={emotionID} onChange={(event) => setEmotionID(event.target.value)}>{emotionPresets.map((preset) => <option value={preset.id} key={preset.id}>{locale === "vi" ? preset.label_vi : preset.label_en}</option>)}</select>
			<button className="secondary compact" type="button" disabled={!script.trim() || busy !== ""} onClick={props.onApplyEmotion}>{busy === "emotion" ? text(locale, "Đang chuẩn bị…", "Preparing…") : text(locale, "Dùng AI chèn cảm xúc", "Use AI for emotion")}</button>
		  </div>
		  <details><summary>{text(locale, "Danh sách thẻ OmniVoice hợp lệ", "Allowed OmniVoice token list")}</summary><code>[laughter], [sigh], [confirmation-en], [question-en], [question-ah], [question-oh], [question-ei], [question-yi], [surprise-ah], [surprise-oh], [surprise-wa], [surprise-yo], [dissatisfaction-hnn]</code></details>
		</section>
        <div className="control-row">
          <label>
            {text(locale, "Ngôn ngữ", "Language")}
            <select
              value={scriptLanguage}
              onChange={(event) =>
                setScriptLanguage(event.target.value as "vi" | "en")
              }
            >
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
            </select>
          </label>
          <label>
            {text(locale, "Tốc độ", "Speed")}
            <div className="range-wrap">
              <input
                type="range"
                min="0.7"
                max="1.35"
                step="0.01"
                value={speed}
                onChange={(event) => setSpeed(Number(event.target.value))}
              />
              <input className="speed-number" type="number" min="0.70" max="1.35" step="0.01" value={speed.toFixed(2)} onChange={(event) => setSpeed(Math.min(1.35, Math.max(0.7, Number(event.target.value) || 1)))} aria-label="Enter speed" />
              <span>{speed.toFixed(2)}×</span>
            </div>
          </label>
          <label>
            {text(locale, "Chất lượng", "Quality")}
            <p className="helper">{text(locale, "Đây là số vòng giải mã (1–64), không phải phần trăm. 100 không phải mức chất lượng hợp lệ của OmniVoice.", "This is the number of decoding iterations (1–64), not a percentage. 100 is not a valid OmniVoice quality level.")}</p>
            <select
              value={steps}
              onChange={(event) => setSteps(Number(event.target.value))}
            >
              <option value={64}>Maximum · 64</option>
              <option value={16}>Nhanh · 16</option>
              <option value={32}>Cân bằng · 32</option>
              <option value={48}>Chi tiết · 48</option>
            </select>
          </label>
        </div>
        <div className="button-row studio-actions">
          <button
            className="secondary"
            disabled={!selected || busy !== ""}
            onClick={props.onPreview}
          >
            ▷{" "}
            {busy === "preview"
              ? text(locale, "Đang tạo…", "Creating…")
              : text(locale, "Nghe thử câu chuẩn", "Preview standard phrase")}
          </button>
          <button
            className="primary"
            disabled={!selected || !script.trim() || busy !== ""}
            onClick={props.onGenerate}
          >
            ✦{" "}
            {busy === "generate"
              ? text(locale, "Đang tạo audio…", "Generating audio…")
              : text(locale, "Tạo giọng nói", "Generate voice")}
          </button>
        </div>
      </section>
      <aside className="panel output-panel">
        <p className="eyebrow">OUTPUT</p>
        <h3>{text(locale, "Khu vực nghe thử", "Listening area")}</h3>
		<div className="output-location"><small>{text(locale, "Lưu audio mới", "New audio saves to")}: {audioOutputDir || text(locale, "thư mục riêng của KOVA", "KOVA private folder")}</small><button type="button" className="link-button" disabled={busy !== ""} onClick={props.onChooseAudioOutput}>{text(locale, "Chọn nơi lưu", "Choose folder")}</button></div>
        {output?.data_url ? (
          <>
            <div className="audio-art">
              <span>♪</span>
              <div className="eq">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
            </div>
            <audio controls src={output.data_url} autoPlay />
            <p className="helper">
              {output.history?.id
                ? text(
                    locale,
                    "Bản này đã được lưu vào Lịch sử.",
                    "This output has been saved to History.",
                  )
                : text(
                    locale,
                    "Đây là bản nghe thử; tạo audio để lưu lịch sử.",
                    "This is a preview; generate audio to save it to History.",
                  )}
            </p>
          </>
        ) : (
          <div className="empty-output">
            <span>⌁</span>
            <p>
              {text(
                locale,
                "Chọn profile, sau đó nghe thử hoặc tạo audio.",
                "Choose a profile, then preview or generate audio.",
              )}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function ReferenceTrimmer(props: {
  source: string;
  locale: "vi" | "en";
  onCropChange(value: string | null): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLAudioElement>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const dragRef = useRef<{ pointerID: number; mode: "start" | "end" | "move"; startX: number; initialStart: number; initialEnd: number } | null>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [decodeError, setDecodeError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function decode() {
      try {
        const response = await fetch(props.source);
        const bytes = await response.arrayBuffer();
        const context = new window.AudioContext();
        const decoded = await context.decodeAudioData(bytes.slice(0));
        await context.close();
        if (cancelled) return;
        audioBufferRef.current = decoded;
        setDuration(decoded.duration);
        setStart(0);
        setEnd(Math.min(decoded.duration, 10));
        setDecodeError("");
      } catch {
        if (!cancelled) setDecodeError(text(props.locale, "Trình phát không đọc được định dạng này để cắt. Hãy dùng WAV hoặc MP3, hoặc chọn đoạn đã cắt sẵn.", "This format cannot be decoded for trimming. Use WAV or MP3, or select an already trimmed clip."));
      }
    }
    void decode();
    return () => { cancelled = true; };
  }, [props.source, props.locale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const buffer = audioBufferRef.current;
    if (!canvas || !buffer || duration <= 0) return;
    const width = Math.max(1, Math.floor(canvas.clientWidth || 620));
    const height = 104;
    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(window.devicePixelRatio, window.devicePixelRatio);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#f4f8ff";
    context.fillRect(0, 0, width, height);
    const channel = buffer.getChannelData(0);
    const samplesPerBar = Math.max(1, Math.floor(channel.length / width));
    context.strokeStyle = "#3f7be8";
    context.lineWidth = 1.5;
    context.beginPath();
    for (let x = 0; x < width; x += 1) {
      const from = x * samplesPerBar;
      const until = Math.min(channel.length, from + samplesPerBar);
      let peak = 0;
      for (let index = from; index < until; index += 1) peak = Math.max(peak, Math.abs(channel[index] ?? 0));
      const amplitude = Math.max(2, peak * (height * 0.45));
      context.moveTo(x + 0.5, height / 2 - amplitude);
      context.lineTo(x + 0.5, height / 2 + amplitude);
    }
    context.stroke();
  }, [duration, props.source]);

  useEffect(() => {
    const buffer = audioBufferRef.current;
    if (!buffer || !duration || end <= start || isDragging) return;
    if (start < 0.02 && end >= duration - 0.02) {
      props.onCropChange(null);
      return;
    }
    props.onCropChange(encodeWAVCrop(buffer, start, end));
  }, [duration, start, end, isDragging, props.onCropChange]);

  const minimum = Math.min(3, duration);
  const updateStart = (value: number) => {
    if (!Number.isFinite(value)) return;
    setStart(Math.max(0, Math.min(value, end - minimum)));
  };
  const updateEnd = (value: number) => {
    if (!Number.isFinite(value)) return;
    setEnd(Math.min(duration, Math.max(value, start + minimum)));
  };
  const beginDrag = (event: React.PointerEvent<HTMLElement>, mode: "start" | "end" | "move") => {
    const track = trackRef.current;
    if (!track || !duration) return;
    event.preventDefault();
    event.stopPropagation();
    track.setPointerCapture(event.pointerId);
    dragRef.current = { pointerID: event.pointerId, mode, startX: event.clientX, initialStart: start, initialEnd: end };
    setIsDragging(true);
  };
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag || !track || drag.pointerID !== event.pointerId) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const delta = ((event.clientX - drag.startX) / rect.width) * duration;
    const min = Math.min(3, duration);
    if (drag.mode === "start") {
      setStart(Math.max(0, Math.min(drag.initialStart + delta, drag.initialEnd - min)));
      return;
    }
    if (drag.mode === "end") {
      setEnd(Math.min(duration, Math.max(drag.initialEnd + delta, drag.initialStart + min)));
      return;
    }
    const width = drag.initialEnd - drag.initialStart;
    const nextStart = Math.max(0, Math.min(drag.initialStart + delta, duration - width));
    setStart(nextStart);
    setEnd(nextStart + width);
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerID !== event.pointerId) return;
    const track = trackRef.current;
    if (track?.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setIsDragging(false);
  };
  const stopPreview = () => {
    const preview = previewRef.current;
    if (!preview) return;
    preview.pause();
    preview.currentTime = start;
    setPlayhead(start);
    setIsPlaying(false);
  };
  const togglePreview = async () => {
    const preview = previewRef.current;
    if (!preview) return;
    if (isPlaying) {
      stopPreview();
      return;
    }
    preview.pause();
    preview.currentTime = start;
    setPlayhead(start);
    try {
      await preview.play();
      setIsPlaying(true);
    } catch {
      setDecodeError(text(props.locale, "Không thể phát audio mẫu trong ứng dụng này.", "The reference audio could not be played in this app."));
    }
  };
  const updatePreview = () => {
    const preview = previewRef.current;
    if (!preview) return;
    if (isPlaying && preview.currentTime >= end) {
      preview.pause();
      preview.currentTime = start;
      setPlayhead(start);
      setIsPlaying(false);
      return;
    }
    setPlayhead(preview.currentTime);
  };

  if (decodeError) return <p className="helper trim-error">{decodeError}</p>;
  if (!duration) return <p className="helper">{text(props.locale, "Đang đọc sóng âm thanh…", "Reading waveform…")}</p>;
  const left = `${(start / duration) * 100}%`;
  const width = `${((end - start) / duration) * 100}%`;
  const playheadLeft = `${(Math.max(start, Math.min(end, playhead)) / duration) * 100}%`;
  return <section className="reference-trimmer">
    <div className="trim-heading"><strong>{text(props.locale, "Cắt đoạn mẫu để clone", "Trim sample for cloning")}</strong><span>{start.toFixed(2)}s – {end.toFixed(2)}s · {(end - start).toFixed(2)}s</span></div>
    <p>{text(props.locale, "Nghe toàn bộ file hoặc bấm nghe đoạn chọn. Kéo hai mép/khung thật chậm và chính xác, hoặc nhập thời gian theo giây.", "Listen to the full file or play the selected clip. Drag either edge/the frame precisely, or enter times in seconds.")}</p>
    <audio className="reference-preview" ref={previewRef} src={props.source} controls preload="metadata" onTimeUpdate={updatePreview} onPause={() => setIsPlaying(false)} onEnded={() => { setIsPlaying(false); setPlayhead(start); }} />
    <div className="trim-tools">
      <button type="button" className="secondary compact" onClick={() => void togglePreview()}>{isPlaying ? text(props.locale, "Dừng nghe đoạn", "Stop selection") : text(props.locale, "▷ Nghe đoạn chọn", "▷ Play selection")}</button>
      <div className="trim-time-grid">
        <label>{text(props.locale, "Bắt đầu (giây)", "Start (seconds)")}<input aria-label={text(props.locale, "Bắt đầu", "Start")} type="number" min="0" max={Math.max(0, end - minimum)} step="0.01" value={Number(start.toFixed(2))} onChange={(event) => updateStart(Number(event.target.value))} /></label>
        <label>{text(props.locale, "Kết thúc (giây)", "End (seconds)")}<input aria-label={text(props.locale, "Kết thúc", "End")} type="number" min={Math.min(duration, start + minimum)} max={duration} step="0.01" value={Number(end.toFixed(2))} onChange={(event) => updateEnd(Number(event.target.value))} /></label>
      </div>
    </div>
    <div ref={trackRef} className={`waveform-track${isDragging ? " is-dragging" : ""}`} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <canvas ref={canvasRef} />
      <div className="trim-playhead" style={{ left: playheadLeft }} aria-hidden="true" />
      <div className="trim-selection" style={{ left, width }} onPointerDown={(event) => beginDrag(event, "move")}>
        <button type="button" className="trim-handle start" aria-label="Trim start" onPointerDown={(event) => beginDrag(event, "start")} />
        <button type="button" className="trim-handle end" aria-label="Trim end" onPointerDown={(event) => beginDrag(event, "end")} />
      </div>
    </div>
    {duration < 3 && <p className="trim-error">{text(props.locale, "Đoạn mẫu ngắn hơn 3 giây; hãy chọn file dài hơn để clone ổn định.", "The sample is shorter than 3 seconds; choose a longer file for a stable clone.")}</p>}
    {end - start > 10 && <p className="trim-warning">{text(props.locale, "Đoạn đã chọn dài hơn 10 giây. OmniVoice có thể clone kém ổn định hơn; hãy thu ngắn về 3–10 giây.", "The selected clip is longer than 10 seconds. OmniVoice may clone less reliably; trim it to 3–10 seconds.")}</p>}
  </section>;
}

function encodeWAVCrop(buffer: AudioBuffer, startSecond: number, endSecond: number) {
  const firstSample = Math.max(0, Math.floor(startSecond * buffer.sampleRate));
  const lastSample = Math.min(buffer.length, Math.ceil(endSecond * buffer.sampleRate));
  const length = Math.max(1, lastSample - firstSample);
  const channels = buffer.numberOfChannels;
  const bytes = new ArrayBuffer(44 + length * channels * 2);
  const view = new DataView(bytes);
  const write = (offset: number, value: string) => Array.from(value).forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + length * channels * 2, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, length * channels * 2, true);
  let offset = 44;
  for (let sample = firstSample; sample < lastSample; sample += 1) for (let channel = 0; channel < channels; channel += 1) {
    const value = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[sample] ?? 0));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true); offset += 2;
  }
  const values = new Uint8Array(bytes); let binary = "";
  values.forEach((value) => { binary += String.fromCharCode(value); });
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function LibraryPage(props: {
  locale: "vi" | "en";
  voices: VoiceProfile[];
  query: string;
  setQuery(value: string): void;
  selectedID: string;
  onSelect(id: string): Promise<void>;
  onDelete(voice: VoiceProfile): Promise<void>;
  profileName: string;
  setProfileName(value: string): void;
  profileLanguage: "vi" | "en";
  setProfileLanguage(value: "vi" | "en"): void;
  referencePath: string;
	 referenceText: string;
	 setReferenceText(value: string): void;
	 transcriptReviewed: boolean;
	 setTranscriptReviewed(value: boolean): void;
	 referenceSource: string;
	 onTrimmedReference(value: string | null): void;
  consent: boolean;
  setConsent(value: boolean): void;
  busy: string;
  onChoose(): Promise<void>;
	 onAutoTranscribe(): Promise<void>;
  onCreate(): Promise<void>;
  onOpenNotebook(): void;
  onReadReferenceAudio(voice: VoiceProfile): Promise<string | undefined>;
}) {
  const {
    locale,
    voices,
    query,
    setQuery,
    selectedID,
    profileName,
    setProfileName,
    profileLanguage,
    setProfileLanguage,
    referencePath,
	 referenceText,
	 setReferenceText,
	 transcriptReviewed,
	 setTranscriptReviewed,
	 referenceSource,
    consent,
    setConsent,
    busy,
  } = props;
  const players = useRef<Record<string, HTMLAudioElement>>({});
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [playingVoiceID, setPlayingVoiceID] = useState("");

  useEffect(() => {
    return () => {
      Object.values(players.current).forEach((player) => player.pause());
    };
  }, []);

  async function toggleVoiceSample(voice: VoiceProfile) {
    const active = players.current[voice.id];
    if (playingVoiceID === voice.id && active && !active.paused) {
      active.pause();
      setPlayingVoiceID("");
      return;
    }
    Object.entries(players.current).forEach(([id, player]) => {
      if (id !== voice.id) player.pause();
    });
    let source = samples[voice.id];
    if (!source) {
      const referenceAudio = await props.onReadReferenceAudio(voice);
      if (!referenceAudio) return;
      source = referenceAudio;
      setSamples((current) => ({ ...current, [voice.id]: source }));
    }
    const player = players.current[voice.id] ?? new Audio(source);
    if (player.src !== source) player.src = source;
    players.current[voice.id] = player;
    player.onended = () => setPlayingVoiceID("");
    try {
      await player.play();
      setPlayingVoiceID(voice.id);
    } catch {
      setPlayingVoiceID("");
    }
  }
  return (
    <div className="library-layout">
      <section className="panel clone-form">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              03 · {text(locale, "TẠO PROFILE MỚI", "CREATE NEW PROFILE")}
            </p>
            <h2>{text(locale, "Clone giọng của bạn", "Clone your voice")}</h2>
            <p>
              {text(
                locale,
                "Profile gồm tên, audio mẫu đã sao lưu cục bộ và cấu hình worker. Lần sau mở app vẫn có trong thư viện.",
                "A profile includes its name, private local reference backup, and worker configuration. It remains in your library next time you open the app.",
              )}
            </p>
          </div>
          <button className="link-button" onClick={props.onOpenNotebook}>
            ↗ {text(locale, "Mở Colab", "Open Colab")}
          </button>
        </div>
        <div className="form-grid">
          <label>
            {text(locale, "Tên giọng", "Voice name")}
            <input
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              placeholder={text(
                locale,
                "Ví dụ: Giọng kể chuyện của An",
                "Example: An's narration voice",
              )}
              maxLength={120}
            />
          </label>
          <label>
            {text(locale, "Ngôn ngữ chính", "Primary language")}
            <select
              value={profileLanguage}
              onChange={(event) =>
                setProfileLanguage(event.target.value as "vi" | "en")
              }
            >
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <button className="dropzone" type="button" onClick={() => void props.onChoose()}>
          <span className="drop-icon">⇪</span>
          <strong>
            {referencePath
              ? referencePath.split(/[\\/]/).pop()
              : text(
                  locale,
                  "Kéo audio mẫu vào đây",
                  "Drop your reference audio here",
                )}
          </strong>
          <p>
            {referencePath
              ? text(
                  locale,
                  "Đã chọn audio mẫu. Tệp sẽ được sao lưu vào thư viện riêng tư.",
                  "Reference selected. It will be copied into the private library.",
                )
              : text(
                  locale,
                  "WAV, MP3 hoặc FLAC · tối đa 64 MiB · kéo từ File Explorer hoặc bấm để chọn",
                  "WAV, MP3, or FLAC · up to 64 MiB · drop from File Explorer or click to choose",
                )}
          </p>
        </button>
		{referenceSource && <ReferenceTrimmer source={referenceSource} locale={locale} onCropChange={props.onTrimmedReference} />}
		<label className="reference-transcript">
		  <div className="transcript-heading"><strong>{text(locale, "Lời nói chính xác trong đoạn đã chọn", "Exact words in the selected clip")}</strong><button className="secondary compact" type="button" disabled={!referencePath || busy !== ""} onClick={() => void props.onAutoTranscribe()}>{busy === "transcribeReference" ? text(locale, "Đang chép lời…", "Transcribing…") : text(locale, "Tạo nháp tự động", "Auto-transcribe draft")}</button></div>
		  <textarea value={referenceText} onChange={(event) => { setReferenceText(event.target.value.slice(0, 2000)); setTranscriptReviewed(false); }} placeholder={text(locale, "Nhập đúng những gì người nói đã đọc. Bạn là người duyệt cuối; app không tự dùng transcript đoán lại.", "Type exactly what the speaker says. You are the final reviewer; the app will not silently use a guessed transcript.")} />
		  <small>{text(locale, "Tự chép lời chỉ là nháp. Bắt buộc nghe lại và sửa trước khi xác nhận; transcript chuẩn ngăn đầu câu lặp lại lời trong audio mẫu.", "Auto-transcription is only a draft. Listen and correct it before confirming; the exact transcript prevents reference words from bleeding into new audio.")}</small>
		  <span className="consent transcript-confirm"><input type="checkbox" checked={transcriptReviewed} onChange={(event) => setTranscriptReviewed(event.target.checked)} /><span>{text(locale, "Tôi đã nghe, xem và sửa transcript đúng với đoạn audio đã chọn.", "I listened to, reviewed, and corrected this transcript for the selected clip.")}</span></span>
		</label>
        <div className="separation-note">
          <span>✦</span>
          <div><strong>{text(locale, "Làm sạch audio tham chiếu bằng GPU", "GPU reference cleanup")}</strong><p>{text(locale, "Bắt buộc: Colab dùng Demucs tách giọng nói khỏi nhạc trước khi OmniVoice tạo clone. Nếu không tách được, app dừng để tránh lưu một profile lẫn nhạc.", "Required: Colab uses Demucs to isolate speech from music before OmniVoice creates the clone. If cleanup fails, KOVA stops instead of saving a music-contaminated profile.")}</p></div>
        </div>
        <button className="file-button" onClick={() => void props.onChoose()}>
          {referencePath
            ? text(locale, "Chọn audio khác", "Choose another audio")
            : text(locale, "Chọn tệp audio", "Choose audio file")}
        </button>
        <label className="consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>
            {text(
              locale,
              "Tôi xác nhận có quyền sử dụng audio mẫu này để tạo voice profile.",
              "I confirm that I have permission to use this reference audio to create a voice profile.",
            )}
          </span>
        </label>
        <div className="backup-note">
          <span>◈</span>
          <p>
            <strong>
              {text(locale, "Lưu bền vững", "Persistent storage")}
            </strong>
            {text(
              locale,
              " KOVA sao chép audio mẫu vào vùng dữ liệu riêng tư của ứng dụng. Khi Colab reset, app có thể dùng bản sao đó để tạo lại profile mà không cần bạn upload lại.",
              " KOVA copies the reference into the app's private data area. If Colab resets, the app can use that backup to restore the profile without uploading it again.",
            )}
          </p>
        </div>
        <button
          className="primary full"
          disabled={busy !== "" || !referencePath || !referenceText.trim() || !transcriptReviewed}
          onClick={() => void props.onCreate()}
        >
          ✦{" "}
          {busy === "create"
            ? text(
                locale,
                "Đang lưu và tạo profile…",
                "Saving and creating profile…",
              )
            : text(
                locale,
                "Tạo & lưu voice profile",
                "Create & save voice profile",
              )}
        </button>
      </section>
      <section className="panel library-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              {text(locale, "THƯ VIỆN CỦA BẠN", "YOUR LIBRARY")}
            </p>
            <h2>{text(locale, "Giọng đã lưu", "Saved voices")}</h2>
          </div>
          <span className="count">{voices.length}</span>
        </div>
        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={text(locale, "Tìm tên giọng…", "Search voices…")}
        />
        {voices.length ? (
          <div className="voice-list">
            {voices.map((voice) => (
              <article
                key={voice.id}
                className={`voice-card ${selectedID === voice.id ? "selected" : ""}`}
              >
                <button
                  className="voice-main"
                  onClick={() => void props.onSelect(voice.id)}
                >
                  <span className={`avatar ${voice.language}`}>
                    {voice.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{voice.name}</strong>
                    <small>
                      {voice.language === "vi" ? "Tiếng Việt" : "English"} ·{" "}
                      {voice.kind === "cloned"
                        ? text(locale, "Clone", "Clone")
                        : text(locale, "Worker", "Worker")}
                    </small>
                  </span>
                </button>
                <div className="voice-badges">
                  <span
                    className={
                      voice.backup_available ? "backup yes" : "backup no"
                    }
                  >
                    {voice.backup_available
                      ? text(locale, "Đã backup", "Backed up")
                      : text(locale, "Không backup", "No backup")}
                  </span>
                  <button
                    className={`sample-toggle ${playingVoiceID === voice.id ? "playing" : ""}`}
                    type="button"
                    aria-label={text(locale, "Phát hoặc dừng audio mẫu đã backup", "Play or pause the backed-up reference audio")}
                    title={text(locale, "Nghe audio mẫu đã backup", "Play backed-up reference audio")}
                    disabled={busy !== ""}
                    onClick={() => void toggleVoiceSample(voice)}
                  >
                    {playingVoiceID === voice.id ? "❚❚" : "▶"}
                  </button>
                  <button
                    className="trash"
                    aria-label={text(locale, "Xóa giọng", "Delete voice")}
                    disabled={busy !== ""}
                    onClick={() => void props.onDelete(voice)}
                  >
                    ⌫
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <span>◎</span>
            <h3>{text(locale, "Chưa có giọng nào", "No voices saved yet")}</h3>
            <p>
              {text(
                locale,
                "Tạo profile ở cột bên trái. Sau đó profile luôn có sẵn ở đây khi bạn mở lại app.",
                "Create a profile on the left. It will remain available here the next time you open the app.",
              )}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryPage(props: {
  locale: "vi" | "en";
  history: GenerationHistory[];
  output: Generated | null;
  busy: string;
  onOpen(item: GenerationHistory): void;
  onDelete(item: GenerationHistory): Promise<void>;
}) {
  const { locale, history, output, busy } = props;
  return (
    <section className="panel history-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            {text(locale, "AUDIO ĐÃ LƯU", "SAVED AUDIO")}
          </p>
          <h2>{text(locale, "Lịch sử tạo giọng", "Generation history")}</h2>
          <p>
            {text(
              locale,
              "Mỗi audio được lưu cục bộ trong KOVA Voice Studio, sẵn sàng để mở lại hoặc dọn dẹp.",
              "Each audio file is stored locally in KOVA Voice Studio, ready to open again or clean up.",
            )}
          </p>
        </div>
        <span className="count">{history.length}</span>
      </div>
      {output?.history?.id && (
        <div className="current-output">
          <span>♪</span>
          <div>
            <strong>{text(locale, "Bản vừa tạo", "Latest output")}</strong>
            <p>{output.history.voice_name}</p>
          </div>
          <audio controls src={output.data_url} />
        </div>
      )}
      {history.length ? (
        <div className="history-list">
          {history.map((item) => (
            <article className="history-row" key={item.id}>
              <span className="audio-thumb">♪</span>
              <div className="history-text">
                <strong>{item.voice_name}</strong>
                <p>{item.text}</p>
                <small>
                  {formatDate(item.created_at, locale)} ·{" "}
                  {(item.size_bytes / 1024).toFixed(1)} KB ·{" "}
                  {item.language === "vi" ? "Tiếng Việt" : "English"}
                </small>
              </div>
              <button
                className="secondary compact"
                disabled={busy !== ""}
                onClick={() => props.onOpen(item)}
              >
                ↗ {text(locale, "Mở", "Open")}
              </button>
              <button
                className="ghost-danger"
                disabled={busy !== ""}
                onClick={() => void props.onDelete(item)}
              >
                ⌫
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state history-empty">
          <span>♬</span>
          <h3>{text(locale, "Chưa có audio đã lưu", "No saved audio")}</h3>
          <p>
            {text(
              locale,
              "Tạo audio trong Phòng thu để bắt đầu lịch sử.",
              "Generate audio in Studio to start your history.",
            )}
          </p>
        </div>
      )}
    </section>
  );
}

function SettingsPage(props: {
  locale: "vi" | "en";
  setLocale(value: "vi" | "en"): void;
  theme: string;
  setTheme(value: string): void;
  workerURL: string;
  token: string;
  health: Health | null;
  busy: string;
	audioOutputDir: string;
  setWorkerURL(value: string): void;
  setToken(value: string): void;
	onChooseAudioOutput(): void;
	onUsePrivateAudioOutput(): void;
  onSave(): void;
  onCheck(): void;
  onOpenNotebook(): void;
}) {
  const {
    locale,
    setLocale,
    theme,
    setTheme,
    workerURL,
    token,
    health,
    busy,
	audioOutputDir,
    setWorkerURL,
    setToken,
  } = props;
  return (
    <div className="settings-layout">
      <section className="panel settings-card">
        <p className="eyebrow">
          {text(locale, "CẤU HÌNH WORKER", "WORKER CONFIGURATION")}
        </p>
        <h2>
          {text(
            locale,
            "Google Colab / Remote GPU",
            "Google Colab / Remote GPU",
          )}
        </h2>
        <p>
          {text(
            locale,
            "KOVA Voice Studio là app desktop; Colab chỉ cung cấp GPU cho model clone. Sau khi Run all, dán URL worker và token ở cell cuối vào hai ô bên dưới để kết nối phiên hiện tại.",
            "KOVA Voice Studio is a desktop app; Colab only supplies GPU for the clone model. After Run all, paste the worker URL and token from the final cell below to connect the current session.",
          )}
        </p>
        <label>
          {text(locale, "URL worker", "Worker URL")}
          <input
            value={workerURL}
            onChange={(event) => setWorkerURL(event.target.value)}
            placeholder="https://xxxxx.trycloudflare.com"
          />
        </label>
        <label>
          {text(
            locale,
            "Token phiên (không được lưu)",
            "Session token (not saved)",
          )}
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={text(
              locale,
              "Dán token từ cell cuối Colab",
              "Paste the token from the final Colab cell",
            )}
          />
        </label>
        <div className="button-row">
          <button
            className="primary"
            disabled={busy !== ""}
            onClick={props.onCheck}
          >
            ◌ {text(locale, "Kiểm tra", "Check")}
          </button>
          <button className="secondary" onClick={props.onOpenNotebook}>
            ↗ {text(locale, "Mở notebook", "Open notebook")}
          </button>
        </div>
        {health && (
          <div className={`health-result ${health.reachable ? "ok" : "bad"}`}>
            {health.reachable ? "✓" : "!"} {health.message}{" "}
            {health.device && `· ${health.device}`}
          </div>
        )}
      </section>
      <section className="panel settings-card">
        <p className="eyebrow">
          {text(locale, "RIÊNG TƯ VÀ GIAO DIỆN", "PRIVACY AND APPEARANCE")}
        </p>
        <h2>
          {text(locale, "Lưu dữ liệu có chủ đích", "Intentional data storage")}
        </h2>
        <div className="setting-item">
          <div>
            <strong>{text(locale, "Theme", "Theme")}</strong>
            <p>
              {text(
                locale,
                "Màu hiện dùng được lưu cho lần mở tiếp theo.",
                "Your chosen color mode is remembered on the next launch.",
              )}
            </p>
          </div>
          <select className="appearance-select" value={theme} onChange={(event) => setTheme(event.target.value)}>
            <option value="dark">{text(locale, "Tối", "Dark")}</option>
            <option value="light">{text(locale, "Sáng", "Light")}</option>
            <option value="system">{text(locale, "Theo hệ thống", "System")}</option>
          </select>
        </div>
        <div className="setting-item">
          <div><strong>{text(locale, "Ngôn ngữ ứng dụng", "Application language")}</strong><p>{text(locale, "Toàn bộ nhãn giao diện đổi ngay và được lưu ở lần mở tiếp theo.", "All UI labels change immediately and are saved for the next launch.")}</p></div>
          <select className="appearance-select" value={locale} onChange={(event) => setLocale(event.target.value as "vi" | "en")}><option value="vi">Tiếng Việt</option><option value="en">English</option></select>
        </div>
        <div className="setting-item">
          <div>
            <strong>{text(locale, "Voice profile", "Voice profiles")}</strong>
            <p>
              {text(
                locale,
                "Lưu tên, ngôn ngữ, profile ID và bản sao audio mẫu riêng tư để mở lại app vẫn có.",
                "Name, language, profile ID, and a private reference backup are saved so profiles remain after reopening the app.",
              )}
            </p>
          </div>
          <span className="check-chip">
            ✓ {text(locale, "Được lưu", "Saved")}
          </span>
        </div>
        <div className="setting-item audio-output-setting">
          <div>
            <strong>{text(locale, "Thư mục lưu audio", "Audio output folder")}</strong>
            <p>
              {text(
                locale,
                "Audio tạo mới được lưu trực tiếp vào thư mục này. Các mục lịch sử cũ vẫn giữ vị trí đã lưu ban đầu.",
                "New audio is saved directly in this folder. Existing history keeps the location where it was originally saved.",
              )}
            </p>
            <code className="output-path">
              {audioOutputDir || text(locale, "Thư mục riêng của KOVA", "KOVA private folder")}
            </code>
          </div>
          <div className="audio-output-actions">
            <button className="secondary" type="button" disabled={busy !== ""} onClick={props.onChooseAudioOutput}>
              {text(locale, "Chọn thư mục", "Choose folder")}
            </button>
            {audioOutputDir && (
              <button className="link-button" type="button" disabled={busy !== ""} onClick={props.onUsePrivateAudioOutput}>
                {text(locale, "Dùng mặc định", "Use default")}
              </button>
            )}
          </div>
        </div>
        <div className="setting-item">
          <div>
            <strong>{text(locale, "Token Colab", "Colab token")}</strong>
            <p>
              {text(
                locale,
                "Không được lưu vào ổ đĩa hay profile. Nhập lại khi cần để giảm rủi ro lộ token.",
                "Never written to disk or profiles. Re-enter when needed to reduce token exposure.",
              )}
            </p>
          </div>
          <span className="muted-chip">
            {text(locale, "Chỉ phiên này", "Session only")}
          </span>
        </div>
        <button
          className="primary full"
          disabled={busy !== ""}
          onClick={props.onSave}
        >
          ✓ {text(locale, "Lưu cấu hình", "Save preferences")}
        </button>
      </section>
    </div>
  );
}

function TaskProgressPanel(props: {
  progress: TaskProgress;
  clock: number;
  locale: "vi" | "en";
}) {
  const { progress, clock, locale } = props;
  const started = Date.parse(progress.started_at);
  const elapsed =
    progress.status === "running" && !Number.isNaN(started)
      ? Math.max(progress.elapsed_ms, clock - started)
      : progress.elapsed_ms;
  const title =
    progress.task === "clone"
      ? text(locale, "Tiến độ tạo clone", "Clone progress")
      : progress.task === "preview"
        ? text(locale, "Tiến độ nghe thử", "Preview progress")
        : text(locale, "Tiến độ tạo audio", "Audio generation progress");
  const status =
    progress.status === "running"
      ? text(locale, "Đang chạy", "Running")
      : progress.status === "complete"
        ? text(locale, "Hoàn tất", "Complete")
        : text(locale, "Có lỗi", "Failed");
  return (
    <section className={`task-progress ${progress.status}`} aria-live="polite">
      <div>
        <p className="eyebrow">THEO DÕI TÁC VỤ</p>
        <h3>{title}</h3>
      </div>
      <span className="task-status">{status}</span>
      <div className="progress-meta">
        <span>
          {Math.max(0, Math.min(100, progress.percent))}% ·{" "}
          {formatElapsed(elapsed)}
        </span>
        <span>{text(locale, "Thời gian thực", "Elapsed time")}</span>
      </div>
      <div className="progress-track">
        <i
          style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
        />
      </div>
      <p>{progress.message}</p>
      <small>
        {text(
          locale,
          "Phần trăm phản ánh các giai đoạn worker đã hoàn tất; đồng hồ được cập nhật mỗi giây.",
          "The percentage reflects completed worker stages; the timer updates every second.",
        )}
      </small>
    </section>
  );
}

function Metric(props: { label: string; value: string; icon: string }) {
  return (
    <article className="metric">
      <span>{props.icon}</span>
      <div>
        <strong>{props.value}</strong>
        <p>{props.label}</p>
      </div>
    </article>
  );
}
