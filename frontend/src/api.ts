import {
  ApplyEmotionWithGateway as bridgeApplyEmotionWithGateway,
	AutoTranscribeReference as bridgeAutoTranscribeReference,
  Bootstrap as bridgeBootstrap,
	CancelWorkerJob as bridgeCancelWorkerJob,
  CheckWorker as bridgeCheckWorker,
  CreateVoice as bridgeCreateVoice,
	DebugLogLocation as bridgeDebugLogLocation,
  DeleteHistory as bridgeDeleteHistory,
  DeleteVoice as bridgeDeleteVoice,
  GenerateVoice as bridgeGenerateVoice,
  ImportGoogleDriveDocument as bridgeImportGoogleDriveDocument,
  ImportTextDocument as bridgeImportTextDocument,
  ListGatewayModels as bridgeListGatewayModels,
  OpenColabNotebook as bridgeOpenColabNotebook,
  OpenGoogleDrive as bridgeOpenGoogleDrive,
  OpenHistoryAudio as bridgeOpenHistoryAudio,
  PreviewVoice as bridgePreviewVoice,
	ReadVoiceReferenceAudio as bridgeReadVoiceReferenceAudio,
	ReadReferenceAudioSource as bridgeReadReferenceAudioSource,
  RefreshVoiceLibrary as bridgeRefreshVoiceLibrary,
  ReviewTextWithGateway as bridgeReviewTextWithGateway,
	SaveTrimmedReferenceAudio as bridgeSaveTrimmedReferenceAudio,
  SavePreferences as bridgeSavePreferences,
	SelectAudioOutputDirectory as bridgeSelectAudioOutputDirectory,
  SelectReferenceAudio as bridgeSelectReferenceAudio,
  SelectTextDocument as bridgeSelectTextDocument,
} from "../wailsjs/go/main/App";
import type { main } from "../wailsjs/go/models";

type Plain<T> = {
  [Key in keyof T as T[Key] extends (...args: any[]) => any ? never : Key]: T[Key];
};

export type VoiceProfile = Plain<main.VoiceProfile>;
export type GenerationHistory = Plain<main.GenerationHistory>;
export type DemoVoice = Plain<main.DemoVoice>;
export type Bootstrap = Omit<Plain<main.StudioBootstrap>, "locale"> & {
  locale: "vi" | "en";
};
export type Session = Plain<main.WorkerSession>;
export type Health = Plain<main.WorkerHealth>;
export type Generated = Plain<main.GenerationResult>;
export type CreatePayload = Plain<main.VoiceCreateRequest>;
export type GeneratePayload = Plain<main.GenerateRequest>;
export type ImportedDocument = Plain<main.ImportedDocument>;
export type TextReviewRequest = Plain<main.TextReviewRequest>;
export type TextReviewResult = Plain<main.TextReviewResult>;
export type GatewayModelsRequest = Plain<main.GatewayModelsRequest>;
export type GatewayModel = Plain<main.GatewayModel>;
export type EmotionPreset = Plain<main.EmotionPreset>;
export type EmotionTextRequest = Plain<main.EmotionTextRequest>;
export type ReferenceTranscriptRequest = Plain<main.ReferenceTranscriptRequest>;

export type TaskProgress = {
	job_id?: string;
  task: "clone" | "preview" | "generate";
  phase: string;
  percent: number;
  started_at: string;
  updated_at: string;
  elapsed_ms: number;
  message: string;
  status: "running" | "complete" | "failed";
};

declare global {
  interface Window {
    go?: { main?: { App?: unknown } };
  }
}

function desktop() {
  if (!window.go?.main?.App) {
    throw new Error(
      "KOVA Voice Studio desktop bridge is unavailable. Open the desktop app, not a browser preview.",
    );
  }
}

export const bootstrap = async (): Promise<Bootstrap> => {
  desktop();
  return (await bridgeBootstrap()) as Bootstrap;
};
export const savePreferences = async (request: main.PreferencesRequest) => {
  desktop();
  return (await bridgeSavePreferences(request)) as Bootstrap;
};
export const openColabNotebook = async () => {
  desktop();
  return bridgeOpenColabNotebook();
};
export const openGoogleDrive = async () => {
  desktop();
  return bridgeOpenGoogleDrive();
};
export const checkWorker = async (session: Session) => {
  desktop();
  return bridgeCheckWorker(session);
};
export const cancelWorkerJob = async (session: Session, jobID: string) => {
  desktop();
  return bridgeCancelWorkerJob(session, jobID);
};
export const debugLogLocation = async () => {
  desktop();
  return bridgeDebugLogLocation();
};
export const selectReferenceAudio = async () => {
  desktop();
  return bridgeSelectReferenceAudio();
};
export const selectAudioOutputDirectory = async () => {
  desktop();
  return bridgeSelectAudioOutputDirectory();
};
export const selectTextDocument = async () => {
  desktop();
  return bridgeSelectTextDocument();
};
export const importTextDocument = async (path: string) => {
  desktop();
  return bridgeImportTextDocument(path);
};
export const importGoogleDriveDocument = async (sharedURL: string) => {
  desktop();
  return bridgeImportGoogleDriveDocument(sharedURL);
};
export const reviewTextWithGateway = async (request: TextReviewRequest) => {
  desktop();
  return bridgeReviewTextWithGateway(request);
};
export const applyEmotionWithGateway = async (request: EmotionTextRequest) => {
  desktop();
  return bridgeApplyEmotionWithGateway(request);
};
export const autoTranscribeReference = async (request: ReferenceTranscriptRequest) => {
  desktop();
  return bridgeAutoTranscribeReference(request);
};
export const listGatewayModels = async (request: GatewayModelsRequest) => {
  desktop();
  return bridgeListGatewayModels(request);
};
export const refreshVoiceLibrary = async (session: Session) => {
  desktop();
  return bridgeRefreshVoiceLibrary(session);
};
export const createVoice = async (request: CreatePayload) => {
  desktop();
  return bridgeCreateVoice(request);
};
export const previewVoice = async (request: GeneratePayload) => {
  desktop();
  return bridgePreviewVoice(request);
};
export const readVoiceReferenceAudio = async (session: Session, voiceID: string) => {
  desktop();
  return bridgeReadVoiceReferenceAudio(session, voiceID);
};
export const readReferenceAudioSource = async (path: string) => {
  desktop();
  return bridgeReadReferenceAudioSource(path);
};
export const saveTrimmedReferenceAudio = async (dataURL: string) => {
  desktop();
  return bridgeSaveTrimmedReferenceAudio(dataURL);
};
export const generateVoice = async (request: GeneratePayload) => {
  desktop();
  return bridgeGenerateVoice(request);
};
export const deleteVoice = async (session: Session, id: string) => {
  desktop();
  return bridgeDeleteVoice(session, id);
};
export const deleteHistory = async (id: string) => {
  desktop();
  return bridgeDeleteHistory(id);
};
export const openHistoryAudio = async (id: string) => {
  desktop();
  return bridgeOpenHistoryAudio(id);
};
