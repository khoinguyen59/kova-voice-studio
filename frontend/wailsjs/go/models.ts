export namespace main {
	
	export class DemoVoice {
	    id: string;
	    name: string;
	    language: string;
	    accent: string;
	    rate: number;
	    pitch: number;
	    sample: string;
	
	    static createFrom(source: any = {}) {
	        return new DemoVoice(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.language = source["language"];
	        this.accent = source["accent"];
	        this.rate = source["rate"];
	        this.pitch = source["pitch"];
	        this.sample = source["sample"];
	    }
	}
	export class GatewayModel {
	    id: string;
	    name: string;
	    free: boolean;
	    pricing_known: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GatewayModel(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.free = source["free"];
	        this.pricing_known = source["pricing_known"];
	    }
	}
	export class GatewayModelsRequest {
	    gateway_url: string;
	    api_key: string;
	
	    static createFrom(source: any = {}) {
	        return new GatewayModelsRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.gateway_url = source["gateway_url"];
	        this.api_key = source["api_key"];
	    }
	}
	export class GenerateRequest {
	    base_url: string;
	    token: string;
	    voice_id: string;
	    text: string;
	    language: string;
	    speed: number;
	    steps: number;
	
	    static createFrom(source: any = {}) {
	        return new GenerateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.base_url = source["base_url"];
	        this.token = source["token"];
	        this.voice_id = source["voice_id"];
	        this.text = source["text"];
	        this.language = source["language"];
	        this.speed = source["speed"];
	        this.steps = source["steps"];
	    }
	}
	export class GenerationHistory {
	    id: string;
	    voice_id: string;
	    voice_name: string;
	    text: string;
	    language: string;
	    file_name: string;
	    created_at: string;
	    size_bytes: number;
	
	    static createFrom(source: any = {}) {
	        return new GenerationHistory(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.voice_id = source["voice_id"];
	        this.voice_name = source["voice_name"];
	        this.text = source["text"];
	        this.language = source["language"];
	        this.file_name = source["file_name"];
	        this.created_at = source["created_at"];
	        this.size_bytes = source["size_bytes"];
	    }
	}
	export class GenerationResult {
	    history: GenerationHistory;
	    data_url: string;
	
	    static createFrom(source: any = {}) {
	        return new GenerationResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.history = this.convertValues(source["history"], GenerationHistory);
	        this.data_url = source["data_url"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ImportedDocument {
	    file_name: string;
	    format: string;
	    text: string;
	    characters: number;
	
	    static createFrom(source: any = {}) {
	        return new ImportedDocument(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file_name = source["file_name"];
	        this.format = source["format"];
	        this.text = source["text"];
	        this.characters = source["characters"];
	    }
	}
	export class PairingSession {
	    worker_url: string;
	    token: string;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new PairingSession(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.worker_url = source["worker_url"];
	        this.token = source["token"];
	        this.message = source["message"];
	    }
	}
	export class PreferencesRequest {
	    theme: string;
	    locale: string;
	    worker_url: string;
	    selected_voice_id: string;
	
	    static createFrom(source: any = {}) {
	        return new PreferencesRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.theme = source["theme"];
	        this.locale = source["locale"];
	        this.worker_url = source["worker_url"];
	        this.selected_voice_id = source["selected_voice_id"];
	    }
	}
	export class VoiceProfile {
	    id: string;
	    remote_id: string;
	    name: string;
	    language: string;
	    status: string;
	    kind: string;
	    reference_file?: string;
	    backup_available: boolean;
	    worker_url?: string;
	    created_at: string;
	    reference_clean: boolean;
	
	    static createFrom(source: any = {}) {
	        return new VoiceProfile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.remote_id = source["remote_id"];
	        this.name = source["name"];
	        this.language = source["language"];
	        this.status = source["status"];
	        this.kind = source["kind"];
	        this.reference_file = source["reference_file"];
	        this.backup_available = source["backup_available"];
	        this.worker_url = source["worker_url"];
	        this.created_at = source["created_at"];
	        this.reference_clean = source["reference_clean"];
	    }
	}
	export class StudioBootstrap {
	    app_name: string;
	    version: string;
	    notebook_url: string;
	    theme: string;
	    locale: string;
	    worker_url: string;
	    selected_voice_id: string;
	    voices: VoiceProfile[];
	    history: GenerationHistory[];
	    demo_voices: DemoVoice[];
	
	    static createFrom(source: any = {}) {
	        return new StudioBootstrap(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.app_name = source["app_name"];
	        this.version = source["version"];
	        this.notebook_url = source["notebook_url"];
	        this.theme = source["theme"];
	        this.locale = source["locale"];
	        this.worker_url = source["worker_url"];
	        this.selected_voice_id = source["selected_voice_id"];
	        this.voices = this.convertValues(source["voices"], VoiceProfile);
	        this.history = this.convertValues(source["history"], GenerationHistory);
	        this.demo_voices = this.convertValues(source["demo_voices"], DemoVoice);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TextReviewRequest {
	    gateway_url: string;
	    api_key: string;
	    model: string;
	    text: string;
	    language: string;
	    source_format: string;
	
	    static createFrom(source: any = {}) {
	        return new TextReviewRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.gateway_url = source["gateway_url"];
	        this.api_key = source["api_key"];
	        this.model = source["model"];
	        this.text = source["text"];
	        this.language = source["language"];
	        this.source_format = source["source_format"];
	    }
	}
	export class TextReviewResult {
	    revised_text: string;
	    review_summary: string;
	    warnings: string[];
	
	    static createFrom(source: any = {}) {
	        return new TextReviewResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.revised_text = source["revised_text"];
	        this.review_summary = source["review_summary"];
	        this.warnings = source["warnings"];
	    }
	}
	export class VoiceCreateRequest {
	    base_url: string;
	    token: string;
	    name: string;
	    language: string;
	    reference_path: string;
	    consent_confirmed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new VoiceCreateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.base_url = source["base_url"];
	        this.token = source["token"];
	        this.name = source["name"];
	        this.language = source["language"];
	        this.reference_path = source["reference_path"];
	        this.consent_confirmed = source["consent_confirmed"];
	    }
	}
	export class VoiceDropCreateRequest {
	    base_url: string;
	    token: string;
	    name: string;
	    language: string;
	    reference_base64: string;
	    reference_name: string;
	    consent_confirmed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new VoiceDropCreateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.base_url = source["base_url"];
	        this.token = source["token"];
	        this.name = source["name"];
	        this.language = source["language"];
	        this.reference_base64 = source["reference_base64"];
	        this.reference_name = source["reference_name"];
	        this.consent_confirmed = source["consent_confirmed"];
	    }
	}
	
	export class WorkerHealth {
	    reachable: boolean;
	    message: string;
	    device?: string;
	
	    static createFrom(source: any = {}) {
	        return new WorkerHealth(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reachable = source["reachable"];
	        this.message = source["message"];
	        this.device = source["device"];
	    }
	}
	export class WorkerSession {
	    base_url: string;
	    token: string;
	
	    static createFrom(source: any = {}) {
	        return new WorkerSession(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.base_url = source["base_url"];
	        this.token = source["token"];
	    }
	}

}

