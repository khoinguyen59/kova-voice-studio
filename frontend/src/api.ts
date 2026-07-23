export type VoiceProfile = {
  id: string;
  remote_id: string;
  name: string;
  language: string;
  status: string;
  kind: string;
  backup_available: boolean;
  worker_url?: string;
  created_at: string;
  reference_clean: boolean;
};
export type GenerationHistory = {
  id: string;
  voice_id: string;
  voice_name: string;
  text: string;
  language: string;
  file_name: string;
  created_at: string;
  size_bytes: number;
};
export type DemoVoice = {
  id: string;
  name: string;
  language: string;
  accent: string;
  rate: number;
  pitch: number;
  sample: string;
};
export type Bootstrap = {
  app_name: string;
  version: string;
  notebook_url: string;
  theme: string;
  locale: "vi" | "en";
  worker_url: string;
  selected_voice_id: string;
  voices: VoiceProfile[];
  history: GenerationHistory[];
  demo_voices: DemoVoice[];
};
export type Session = { base_url: string; token: string };
export type Health = { reachable: boolean; message: string; device?: string };
export type Generated = { history: GenerationHistory; data_url: string };
export type PairingSession = {
  worker_url: string;
  token: string;
  message: string;
};
export type TaskProgress = {
  task: "clone" | "preview" | "generate";
  phase: string;
  percent: number;
  started_at: string;
  updated_at: string;
  elapsed_ms: number;
  message: string;
  status: "running" | "complete" | "failed";
};
export type CreatePayload = Session & {
  name: string;
  language: string;
  reference_path: string;
  consent_confirmed: boolean;
};
export type DropPayload = Session & {
  name: string;
  language: string;
  reference_base64: string;
  reference_name: string;
  consent_confirmed: boolean;
};
export type GeneratePayload = Session & {
  voice_id: string;
  text: string;
  language: string;
  speed: number;
  steps: number;
};
export type ImportedDocument = {
  file_name: string;
  format: string;
  text: string;
  characters: number;
};
export type TextReviewRequest = {
  gateway_url: string;
  api_key: string;
  model: string;
  text: string;
  language: string;
  source_format: string;
};
export type TextReviewResult = {
  revised_text: string;
  review_summary: string;
  warnings: string[];
};
export type GatewayModelsRequest = {
  gateway_url: string;
  api_key: string;
};
export type GatewayModel = {
  id: string;
  name: string;
  free: boolean;
  pricing_known: boolean;
};

declare global {
  interface Window {
    go?: {
      main?: {
        App?: {
          Bootstrap: () => Promise<Bootstrap>;
          SavePreferences: (request: {
            theme: string;
            locale: string;
            worker_url: string;
            selected_voice_id: string;
          }) => Promise<Bootstrap>;
          OpenColabNotebook: () => Promise<void>;
          OpenGoogleDrive: () => Promise<void>;
          ConsumeIncomingColabPairing: () => Promise<PairingSession | null>;
          CheckWorker: (session: Session) => Promise<Health>;
          SelectReferenceAudio: () => Promise<string>;
          SelectTextDocument: () => Promise<string>;
          ImportTextDocument: (path: string) => Promise<ImportedDocument>;
          ImportGoogleDriveDocument: (
            sharedURL: string,
          ) => Promise<ImportedDocument>;
          ReviewTextWithGateway: (
            request: TextReviewRequest,
          ) => Promise<TextReviewResult>;
          ListGatewayModels: (
            request: GatewayModelsRequest,
          ) => Promise<GatewayModel[]>;
          RefreshVoiceLibrary: (session: Session) => Promise<VoiceProfile[]>;
          CreateVoice: (request: CreatePayload) => Promise<VoiceProfile>;
          CreateVoiceFromDrop: (request: DropPayload) => Promise<VoiceProfile>;
          PreviewVoice: (request: GeneratePayload) => Promise<Generated>;
          GenerateVoice: (request: GeneratePayload) => Promise<Generated>;
          DeleteVoice: (
            session: Session,
            voiceID: string,
          ) => Promise<VoiceProfile[]>;
          DeleteHistory: (id: string) => Promise<GenerationHistory[]>;
          OpenHistoryAudio: (id: string) => Promise<void>;
        };
      };
    };
  }
}

function desktop() {
  const app = window.go?.main?.App;
  if (!app)
    throw new Error(
      "KOVA Voice Studio desktop bridge is unavailable. Open the desktop app, not a browser preview.",
    );
  return app;
}

export const bootstrap = () => desktop().Bootstrap();
export const savePreferences = (request: {
  theme: string;
  locale: string;
  worker_url: string;
  selected_voice_id: string;
}) => desktop().SavePreferences(request);
export const openColabNotebook = () => desktop().OpenColabNotebook();
export const openGoogleDrive = () => desktop().OpenGoogleDrive();
export const consumeIncomingColabPairing = () =>
  desktop().ConsumeIncomingColabPairing();
export const checkWorker = (session: Session) => desktop().CheckWorker(session);
export const selectReferenceAudio = () => desktop().SelectReferenceAudio();
export const selectTextDocument = () => desktop().SelectTextDocument();
export const importTextDocument = (path: string) =>
  desktop().ImportTextDocument(path);
export const importGoogleDriveDocument = (sharedURL: string) =>
  desktop().ImportGoogleDriveDocument(sharedURL);
export const reviewTextWithGateway = (request: TextReviewRequest) =>
  desktop().ReviewTextWithGateway(request);
export const listGatewayModels = (request: GatewayModelsRequest) =>
  desktop().ListGatewayModels(request);
export const refreshVoiceLibrary = (session: Session) =>
  desktop().RefreshVoiceLibrary(session);
export const createVoice = (request: CreatePayload) =>
  desktop().CreateVoice(request);
export const createVoiceFromDrop = (request: DropPayload) =>
  desktop().CreateVoiceFromDrop(request);
export const previewVoice = (request: GeneratePayload) =>
  desktop().PreviewVoice(request);
export const generateVoice = (request: GeneratePayload) =>
  desktop().GenerateVoice(request);
export const deleteVoice = (session: Session, id: string) =>
  desktop().DeleteVoice(session, id);
export const deleteHistory = (id: string) => desktop().DeleteHistory(id);
export const openHistoryAudio = (id: string) => desktop().OpenHistoryAudio(id);
