export type Provider = "whatsapp" | "instagram" | "youtube" | "facebook";
export type CapabilityState = "configured" | "authorized" | "unsupported" | "paused" | "failed";
export interface CapabilityReport { provider:Provider; state:CapabilityState; scopes:string[]; supportedActions:string[]; missingConfiguration:string[] }
export interface NormalizedInboundEvent { provider:Provider; providerEventId:string; eventType:string; externalActorId?:string; occurredAt:string; text?:string; sourceAssetId?:string; metadata:Record<string,string> }
export interface ChannelAdapter { provider:Provider; capabilityReport():CapabilityReport; verifyWebhook(rawBody:string,signature:string|null):boolean; normalize(payload:unknown):NormalizedInboundEvent[] }
