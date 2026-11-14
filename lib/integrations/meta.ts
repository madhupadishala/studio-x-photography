import {createHmac,timingSafeEqual} from "node:crypto";
import type {CapabilityReport,NormalizedInboundEvent,Provider} from "./contracts";

type JsonRecord=Record<string,unknown>;
const record=(v:unknown):JsonRecord=>v&&typeof v==="object"&&!Array.isArray(v)?v as JsonRecord:{};
const arr=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const str=(v:unknown)=>typeof v==="string"?v:"";

export function verifyMetaSignature(rawBody:string,signature:string|null,appSecret:string|undefined):boolean {
  if(!signature||!appSecret||!signature.startsWith("sha256="))return false;
  const expected=createHmac("sha256",appSecret).update(rawBody).digest();
  let supplied:Buffer;
  try{supplied=Buffer.from(signature.slice(7),"hex");}catch{return false;}
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}

export function normalizeWhatsAppWebhook(payload:unknown):NormalizedInboundEvent[]{
  const events:NormalizedInboundEvent[]=[];
  for(const entry of arr(record(payload).entry)){
    for(const change of arr(record(entry).changes)){
      const value=record(record(change).value);const metadata=record(value.metadata);
      for(const message of arr(value.messages)){
        const item=record(message);const contact=record(arr(value.contacts)[0]);const profile=record(contact.profile);
        const text=record(item.text);
        events.push({provider:"whatsapp",providerEventId:str(item.id),eventType:"message."+str(item.type),externalActorId:str(item.from),occurredAt:str(item.timestamp),text:str(text.body),metadata:{phoneNumberId:str(metadata.phone_number_id),displayName:str(profile.name),messageType:str(item.type)}});
      }
      for(const status of arr(value.statuses)){
        const item=record(status);events.push({provider:"whatsapp",providerEventId:"status:"+str(item.id)+":"+str(item.status),eventType:"message.status."+str(item.status),occurredAt:str(item.timestamp),metadata:{recipient:str(item.recipient_id)}});
      }
    }
  }
  return events.filter(event=>event.providerEventId.length>0);
}

export function normalizeInstagramWebhook(payload:unknown):NormalizedInboundEvent[]{
  const events:NormalizedInboundEvent[]=[];
  for(const entry of arr(record(payload).entry)){
    for(const change of arr(record(entry).changes)){
      const value=record(record(change).value);const field=str(record(change).field);
      if(field==="comments"||field==="live_comments"){
        const from=record(value.from);const media=record(value.media);
        events.push({provider:"instagram",providerEventId:str(value.id),eventType:"comment.created",externalActorId:str(from.id),occurredAt:new Date().toISOString(),text:str(value.text),sourceAssetId:str(media.id),metadata:{username:str(from.username),mediaId:str(media.id),entryId:str(record(entry).id)}});
      }
    }
    for(const messaging of arr(record(entry).messaging)){
      const item=record(messaging);const message=record(item.message);
      if(message.mid)events.push({provider:"instagram",providerEventId:str(message.mid),eventType:"message.received",externalActorId:str(record(item.sender).id),occurredAt:new Date().toISOString(),text:str(record(message.text).body??message.text),metadata:{entryId:str(record(entry).id)}});
    }
  }
  return events.filter(event=>event.providerEventId.length>0);
}

export function metaCapability(provider:Provider,configured:boolean,authorized:boolean,scopes:string[]):CapabilityReport {
  const actions=provider==="whatsapp"?["receive_messages","send_session_messages","send_approved_templates"]:
    provider==="instagram"?["receive_eligible_comments","send_one_eligible_private_reply"]:
    provider==="facebook"?["page_webhooks"]:["channel_links","read_authorized_channel_analytics"];
  return {provider,state:!configured?"unsupported":authorized?"authorized":"configured",scopes,supportedActions:actions,missingConfiguration:configured?[]:["provider_app_credentials"]};
}
