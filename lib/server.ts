import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { Pool, type PoolClient } from "@neondatabase/serverless";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { normalizeIndianPhone, scoreLeadDetails, type LeadEvent } from "./domain";

export type Db = {
  query<T=Record<string,unknown>>(sql:string, values?:unknown[]):Promise<{rows:T[];rowCount:number|null}>;
};
let pool:Pool|undefined;
function getPool():Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (!pool) pool = new Pool({connectionString:process.env.DATABASE_URL});
  return pool;
}
export async function withTenant<T>(tenantId:string, work:(db:Db)=>Promise<T>):Promise<T> {
  const client:PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    const result = await work(client as unknown as Db);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface TenantRow {
  id:string; slug:string; studio_name:string; owner_name:string; city:string; address:string;
  landmark:string; maps_url:string; working_hours:string; whatsapp_number:string;
  owner_alert_number:string; theme_preset:string; tagline:string|null; owner_story:string|null;
  scarcity_text:string|null; landmarks:unknown; price_book:Record<string,unknown>;
  budget_bands:Record<string,string>; coupon_rules:Record<string,unknown>;
  service_area:string; owner_reply_sla:string; delivery_sla:string; onboarding_step:number;
  onboarding_completed:boolean; bot_enabled:boolean; status:string;
}
const TENANT_FIELDS = "id,slug,studio_name,owner_name,city,address,landmark,maps_url,working_hours,whatsapp_number,owner_alert_number,theme_preset,tagline,owner_story,scarcity_text,landmarks,price_book,budget_bands,coupon_rules,service_area,owner_reply_sla,delivery_sla,onboarding_step,onboarding_completed,bot_enabled,status";
export async function tenantBy(column:"id"|"slug",value:string):Promise<TenantRow|null> {
  const result = await getPool().query("SELECT "+TENANT_FIELDS+" FROM tenants WHERE "+column+" = $1 AND status = 'active' LIMIT 1",[value]);
  return (result.rows[0] as TenantRow|undefined) ?? null;
}
export async function publicTenant(slug:string):Promise<Record<string,unknown>|null> {
  const t=await tenantBy("slug",slug);
  if(!t) return null;
  return {slug:t.slug,studioName:t.studio_name,city:t.city,address:t.address,landmark:t.landmark,
    mapsUrl:t.maps_url,workingHours:t.working_hours,whatsappNumber:t.whatsapp_number,tagline:t.tagline??""};
}
export async function resolvePublicTenant(req:Request):Promise<TenantRow|null> {
  const origin=req.headers.get("origin") ?? req.headers.get("referer");
  if(!origin) return null;
  let hostname="";
  try { hostname=new URL(origin).hostname.toLowerCase(); } catch { return null; }
  const mapped=await getPool().query("SELECT tenant_id FROM tenant_domains WHERE hostname=$1 AND verification_status='verified' LIMIT 1",[hostname]);
  if(mapped.rows[0]) return tenantBy("id",String((mapped.rows[0] as {tenant_id:string}).tenant_id));
  const previewHosts=(process.env.PREVIEW_HOSTS ?? "studio-x-blush.vercel.app").split(",").map(x=>x.trim().toLowerCase());
  if(previewHosts.includes(hostname) && process.env.PREVIEW_TENANT_SLUG) return tenantBy("slug",process.env.PREVIEW_TENANT_SLUG);
  return null;
}

export interface Session { tenantId:string; phone:string; role:string; exp:number }
export const SESSION_COOKIE="studio_x_owner_session";
function sessionSecret():string {
  const value=process.env.SESSION_SECRET;
  if(!value || value.length<32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  return value;
}
export function signSession(session:Session):string {
  const body=Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature=createHmac("sha256",sessionSecret()).update(body).digest("base64url");
  return body+"."+signature;
}
export function verifySession(token:string|undefined,now=Date.now()):Session|null {
  if(!token) return null;
  const parts=token.split(".");
  if(parts.length!==2) return null;
  try {
    const expected=createHmac("sha256",sessionSecret()).update(parts[0]).digest();
    const supplied=Buffer.from(parts[1],"base64url");
    if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return null;
    const value=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8")) as Session;
    if(!value.tenantId || !value.phone || !value.role || value.exp<=now) return null;
    return value;
  } catch { return null; }
}
export async function ownerSession():Promise<Session|null> {
  const jar=await cookies();
  const session=verifySession(jar.get(SESSION_COOKIE)?.value);
  if(!session) return null;
  const membership=await withTenant(session.tenantId,db=>db.query<{role:string}>(
    "SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND phone_e164=$2 AND status='active' LIMIT 1",
    [session.tenantId,session.phone]
  ));
  const role=membership.rows[0]?.role;
  if(!role || role!==session.role) return null;
  return session;
}
export function newOtp():string { return String(randomInt(0,1000000)).padStart(6,"0"); }
function consentSubject(value:string):string { const pepper=process.env.OTP_PEPPER??""; if(pepper.length<32) throw new Error("OTP_PEPPER must contain at least 32 characters"); return createHmac("sha256",pepper).update(value).digest("hex"); }
function otpPepper():string {
  const value=process.env.OTP_PEPPER;
  if(!value || value.length<32) throw new Error("OTP_PEPPER must contain at least 32 characters");
  return value;
}
export function hashOtp(code:string,phone:string):string {
  return createHmac("sha256",otpPepper()).update(phone+":"+code).digest("hex");
}
export function otpMatches(code:string,phone:string,hash:string):boolean {
  const a=Buffer.from(hashOtp(code,phone),"hex"), b=Buffer.from(hash,"hex");
  return a.length===b.length && timingSafeEqual(a,b);
}
async function sendWhatsAppTemplate(to:string,name:string,params:string[]):Promise<void> {
  const token=process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID;
  if(!token || !phoneId) {
    if(process.env.NODE_ENV!=="production") { console.info("[dev-only] WhatsApp template suppressed for",to); return; }
    throw new Error("WhatsApp Cloud API is not configured");
  }
  const response=await fetch("https://graph.facebook.com/"+(process.env.META_GRAPH_API_VERSION??"v27.0")+"/"+phoneId+"/messages",{
    method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
    body:JSON.stringify({messaging_product:"whatsapp",to,type:"template",template:{
      name,language:{code:process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en"},
      components:[{type:"body",parameters:params.map(text=>({type:"text",text}))}]
    }})
  });
  if(!response.ok) throw new Error("WhatsApp provider rejected template ("+response.status+")");
}
export async function deliverOtp(phone:string,code:string):Promise<void> {
  const template=process.env.WHATSAPP_OTP_TEMPLATE;
  if(!template) {
    if(process.env.NODE_ENV!=="production") { console.info("[dev-only] OTP for",phone,":",code); return; }
    throw new Error("Approved WhatsApp authentication template is not configured");
  }
  await sendWhatsAppTemplate(phone,template,[code]);
}

export async function audit(db:Db,tenantId:string,actor:string,role:string,action:string,entityType:string,entityId:string|null,after:unknown):Promise<void> {
  await db.query("INSERT INTO audit_events (tenant_id,actor_ref,actor_role,action,entity_type,entity_id,after_data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [tenantId,actor,role,action,entityType,entityId,JSON.stringify(after ?? null)]);
}
export async function createLead(input:{
  tenant:TenantRow; phone:string|null; firstName:string; lastName:string; occasion:string;
  eventDate:string|null; venue:string; budgetBand:string|null; source:string; pagePath:string;
  consent:boolean; utm:Record<string,string>; consentText:string;
}):Promise<{leadId:string;coupon:{code:string;pct:number}|null}> {
  const scoreEvents:LeadEvent[]=[];
  if(input.phone) scoreEvents.push("phone_valid");
  if(["wedding","reception","prewed","roka","pre-wedding"].includes(input.occasion.toLowerCase())) scoreEvents.push("occasion_high_value");
  if(input.venue) scoreEvents.push("venue_given");
  if(input.eventDate){const days=(new Date(input.eventDate+"T00:00:00Z").getTime()-Date.now())/86400000;scoreEvents.push(days<=90?"event_within_90d":"event_later");}
  if(input.budgetBand)scoreEvents.push(input.budgetBand==="essential"?"budget_essential":"budget_upper");
  const scored=scoreLeadDetails(scoreEvents);
  return withTenant(input.tenant.id,async db=>{
    let contactId:string|null=null;
    if(input.phone) {
      const contact=await db.query<{id:string}>(
        "INSERT INTO contacts (tenant_id,phone_e164,display_name,consent_state) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,phone_e164) WHERE phone_e164 IS NOT NULL DO UPDATE SET display_name=CASE WHEN excluded.display_name<>'' THEN excluded.display_name ELSE contacts.display_name END,consent_state=CASE WHEN excluded.consent_state='contact' THEN 'contact' ELSE contacts.consent_state END,updated_at=now() RETURNING id",
        [input.tenant.id,input.phone,[input.firstName,input.lastName].filter(Boolean).join(" "),input.consent?"contact":"unknown"]
      );
      contactId=contact.rows[0].id;
    }
    const inserted=await db.query<{id:string}>(
      "INSERT INTO leads (tenant_id,contact_id,first_name,last_name,phone_e164,occasion,event_date,venue,budget_band,source,source_first,source_last,utm,score,tier,score_reasons,consent_contact,consent_marketing,consent_text,consent_at,express) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,$11,$12,$13,$14,$15,false,$16,CASE WHEN $15 THEN now() ELSE NULL END,$17) RETURNING id",
      [input.tenant.id,contactId,input.firstName,input.lastName,input.phone,input.occasion,input.eventDate,input.venue,input.budgetBand,input.source,JSON.stringify(input.utm),scored.score,scored.tier,JSON.stringify(scored.reasons),input.consent,input.consentText,["passport","portrait","brand"].includes(input.occasion.toLowerCase())]
    );
    const leadId=inserted.rows[0].id;
    if(input.consent) await db.query(
      "INSERT INTO consent_events (tenant_id,lead_id,subject_ref,purpose,action,evidence) VALUES ($1,$2,$3,'contact','granted',$4)",
      [input.tenant.id,leadId,consentSubject(input.phone??leadId),input.consentText]
    );
    let coupon:null|{code:string;pct:number}=null;
    const rules=input.tenant.coupon_rules as {enabled?:boolean;expressCode?:string;expressPct?:number;validHours?:number};
    if(input.phone && input.consent && rules.enabled && rules.expressCode && Number(rules.expressPct)>=1) {
      const code=String(rules.expressCode).slice(0,32)+"-"+randomUUID().slice(0,4).toUpperCase();
      const saved=await db.query<{code:string;discount_pct:number}>(
        "INSERT INTO coupons (tenant_id,lead_id,phone_e164,code,discount_pct,expires_at) VALUES ($1,$2,$3,$4,$5,now()+($6::int * interval '1 hour')) ON CONFLICT (tenant_id,phone_e164) DO NOTHING RETURNING code,discount_pct",
        [input.tenant.id,leadId,input.phone,code,Math.min(50,Number(rules.expressPct)),Math.max(1,Math.min(168,Number(rules.validHours ?? 48)))]
      );
      if(saved.rows[0]) coupon={code:saved.rows[0].code,pct:saved.rows[0].discount_pct};
    }
    await audit(db,input.tenant.id,"public","public","lead.created","lead",leadId,{source:input.source});
    return {leadId,coupon};
  });
}

const r2Client=():S3Client=>{
  const {R2_ACCOUNT_ID,R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY}=process.env;
  if(!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) throw new Error("R2 storage is not configured");
  return new S3Client({region:"auto",endpoint:"https://"+R2_ACCOUNT_ID+".r2.cloudflarestorage.com",
    credentials:{accessKeyId:R2_ACCESS_KEY_ID,secretAccessKey:R2_SECRET_ACCESS_KEY}});
};
export async function presignUpload(tenantId:string,kind:string,contentType:string):Promise<{uploadUrl:string;publicUrl:string}> {
  const bucket=process.env.R2_BUCKET, base=(process.env.R2_PUBLIC_BASE ?? "").replace(/\/$/,"");
  if(!bucket || !base) throw new Error("R2_BUCKET and R2_PUBLIC_BASE are required");
  const extension=contentType==="image/webp"?"webp":contentType==="image/jpeg"?"jpg":"pdf";
  const key=tenantId+"/"+kind+"/"+randomUUID()+"."+extension;
  const command=new PutObjectCommand({Bucket:bucket,Key:key,ContentType:contentType});
  return {uploadUrl:await getSignedUrl(r2Client(),command,{expiresIn:300}),publicUrl:base+"/"+key};
}
export function isTenantAsset(url:string,tenantId:string):boolean {
  const base=(process.env.R2_PUBLIC_BASE ?? "").replace(/\/$/,"");
  return Boolean(base && url.startsWith(base+"/"+tenantId+"/"));
}
export function createRequestId():string { return randomUUID(); }
export function normalizePhoneOrNull(value:string):string|null { return normalizeIndianPhone(value); }


export async function tenantByProviderAccount(provider:"whatsapp"|"instagram"|"facebook"|"youtube",externalAccountId:string):Promise<TenantRow|null> {
  if(!externalAccountId) return null;
  const result=await getPool().query<{tenant_id:string}>(
    "SELECT tenant_id FROM provider_account_routes WHERE provider=$1 AND external_account_id=$2 LIMIT 1",
    [provider,externalAccountId]
  );
  const id=result.rows[0]?.tenant_id;
  return id?tenantBy("id",id):null;
}
export async function persistInboundEvent(input:{tenantId:string;provider:string;eventId:string;eventType:string;payload:unknown;signatureValid:boolean;occurredAt?:string}):Promise<boolean> {
  const result=await withTenant(input.tenantId,db=>db.query<{id:string}>(
    "INSERT INTO inbound_events (tenant_id,provider,provider_event_id,event_type,payload,signature_valid,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,provider,provider_event_id) DO NOTHING RETURNING id",
    [input.tenantId,input.provider,input.eventId,input.eventType,JSON.stringify(input.payload),input.signatureValid,input.occurredAt??null]
  ));
  return Boolean(result.rows[0]);
}


export interface TenantIntegration {
  provider:"whatsapp"|"instagram"|"facebook"|"youtube";
  externalAccountId:string|null;
  accessToken:string;
  refreshToken:string|null;
  status:string;
  expiresAt:string|null;
  scopes:string[];
}
function integrationKey():Buffer {
  const raw=process.env.INTEGRATION_ENCRYPTION_KEY??"";
  const key=Buffer.from(raw,"hex");
  if(key.length!==32) throw new Error("INTEGRATION_ENCRYPTION_KEY must be 32 bytes encoded as hex");
  return key;
}
export function encryptIntegrationSecret(value:string):string {
  const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",integrationKey(),iv);
  const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return [iv.toString("hex"),cipher.getAuthTag().toString("hex"),encrypted.toString("hex")].join(".");
}
export function decryptIntegrationSecret(value:string):string {
  const [ivHex,tagHex,dataHex]=value.split(".");
  if(!ivHex||!tagHex||!dataHex) throw new Error("Invalid encrypted integration secret");
  const decipher=createDecipheriv("aes-256-gcm",integrationKey(),Buffer.from(ivHex,"hex"));
  decipher.setAuthTag(Buffer.from(tagHex,"hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex,"hex")),decipher.final()]).toString("utf8");
}
export async function tenantIntegration(tenantId:string,provider:"whatsapp"|"instagram"|"facebook"|"youtube"):Promise<TenantIntegration|null> {
  const result=await withTenant(tenantId,db=>db.query<{external_account_id:string|null;external_business_id:string|null;encrypted_access_token:string|null;encrypted_refresh_token:string|null;status:string;token_expires_at:string|null;granted_scopes:string[]}>(
    "SELECT external_account_id,external_business_id,encrypted_access_token,encrypted_refresh_token,status,token_expires_at,granted_scopes FROM tenant_integrations WHERE tenant_id=$1 AND provider=$2 LIMIT 1",[tenantId,provider]
  ));
  const row=result.rows[0];
  if(!row?.encrypted_access_token) return null;
  let accessToken=decryptIntegrationSecret(row.encrypted_access_token);
  const refreshToken=row.encrypted_refresh_token?decryptIntegrationSecret(row.encrypted_refresh_token):null;
  let expiresAt=row.token_expires_at;
  let status=row.status;
  const expiry=expiresAt?new Date(expiresAt).getTime():Number.POSITIVE_INFINITY;
  if(status==="authorized" && expiry<Date.now()+7*86400000) {
    try {
      let refreshed:{access_token:string;expires_in:number;refresh_token?:string}|null=null;
      if(provider==="instagram") {
        const url=new URL("https://graph.instagram.com/refresh_access_token");
        url.searchParams.set("grant_type","ig_refresh_token");url.searchParams.set("access_token",accessToken);
        const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error("Instagram token refresh failed");
        refreshed=await response.json() as {access_token:string;expires_in:number};
      } else if(provider==="youtube" && refreshToken) {
        const form=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID??"",client_secret:process.env.GOOGLE_CLIENT_SECRET??"",refresh_token:refreshToken,grant_type:"refresh_token"});
        const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form,signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error("YouTube token refresh failed");
        refreshed=await response.json() as {access_token:string;expires_in:number};
      } else if(provider==="whatsapp" || provider==="facebook") {
        throw new Error("Provider token requires owner reconnection");
      }
      if(refreshed) {
        accessToken=refreshed.access_token;
        expiresAt=new Date(Date.now()+refreshed.expires_in*1000).toISOString();
        await saveTenantIntegration({tenantId,provider,externalAccountId:row.external_account_id??"",externalBusinessId:row.external_business_id,accessToken,refreshToken:refreshed.refresh_token??refreshToken,expiresAt,scopes:row.granted_scopes??[]});
      }
    } catch {
      status="expired";
      await withTenant(tenantId,db=>db.query("UPDATE tenant_integrations SET status='expired',updated_at=now() WHERE tenant_id=$1 AND provider=$2",[tenantId,provider]));
    }
  }
  return {provider,externalAccountId:row.external_account_id,accessToken,refreshToken,status,expiresAt,scopes:row.granted_scopes??[]};
}
export async function listActiveTenantIds():Promise<string[]> {
  const result=await getPool().query<{id:string}>("SELECT id FROM tenants WHERE status='active' ORDER BY created_at LIMIT 500");
  return result.rows.map(row=>row.id);
}


export async function saveTenantIntegration(input:{
  tenantId:string;provider:"whatsapp"|"instagram"|"facebook"|"youtube";externalAccountId:string;externalBusinessId?:string|null;
  accessToken:string;refreshToken?:string|null;expiresAt?:string|null;scopes:string[];
}):Promise<void> {
  const encryptedAccess=encryptIntegrationSecret(input.accessToken);
  const encryptedRefresh=input.refreshToken?encryptIntegrationSecret(input.refreshToken):null;
  await withTenant(input.tenantId,async db=>{
    await db.query(
      "INSERT INTO tenant_integrations (tenant_id,provider,external_account_id,external_business_id,encrypted_access_token,encrypted_refresh_token,token_expires_at,granted_scopes,status,last_verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'authorized',now()) ON CONFLICT (tenant_id,provider) DO UPDATE SET external_account_id=excluded.external_account_id,external_business_id=excluded.external_business_id,encrypted_access_token=excluded.encrypted_access_token,encrypted_refresh_token=coalesce(excluded.encrypted_refresh_token,tenant_integrations.encrypted_refresh_token),token_expires_at=excluded.token_expires_at,granted_scopes=excluded.granted_scopes,status='authorized',last_verified_at=now(),updated_at=now()",
      [input.tenantId,input.provider,input.externalAccountId,input.externalBusinessId??null,encryptedAccess,encryptedRefresh,input.expiresAt??null,JSON.stringify(input.scopes)]
    );
    await db.query("DELETE FROM provider_account_routes WHERE tenant_id=$1 AND provider=$2",[input.tenantId,input.provider]);
    await db.query("INSERT INTO provider_account_routes (provider,external_account_id,tenant_id) VALUES ($1,$2,$3) ON CONFLICT (provider,external_account_id) DO UPDATE SET tenant_id=excluded.tenant_id",[input.provider,input.externalAccountId,input.tenantId]);
  });
}
export async function integrationStatuses(tenantId:string):Promise<Array<{provider:string;status:string;externalAccountId:string|null;expiresAt:string|null}>> {
  const result=await withTenant(tenantId,db=>db.query<{provider:string;status:string;external_account_id:string|null;token_expires_at:string|null}>(
    "SELECT provider,status,external_account_id,token_expires_at FROM tenant_integrations WHERE tenant_id=$1 ORDER BY provider",[tenantId]
  ));
  return result.rows.map(row=>({provider:row.provider,status:row.status,externalAccountId:row.external_account_id,expiresAt:row.token_expires_at}));
}

export async function rawQuery<T=Record<string,unknown>>(sql:string,values:unknown[]=[]):Promise<T[]> {
  const result=await getPool().query(sql,values);
  return result.rows as T[];
}
