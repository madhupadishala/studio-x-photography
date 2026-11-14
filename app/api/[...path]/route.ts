import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  audit, createLead, deliverOtp, hashOtp, newOtp, normalizePhoneOrNull,
  ownerSession, presignUpload, resolvePublicTenant, signSession, tenantBy,
  tenantByProviderAccount, persistInboundEvent, tenantIntegration, listActiveTenantIds, integrationStatuses, saveTenantIntegration, rawQuery, SESSION_COOKIE, withTenant, isTenantAsset, type Db
} from "../../../lib/server";
import { buildWhatsAppLink, normalizeIndianPhone, type ConversationState, type ConversationAnswers } from "../../../lib/domain";
import { allow, clientKey } from "../../../lib/rate-limit";
import { normalizeInstagramWebhook, normalizeWhatsAppWebhook, verifyMetaSignature } from "../../../lib/integrations/meta";
import { processWhatsAppInbound } from "../../../lib/integrations/whatsapp-webhook";
import { processInstagramComment } from "../../../lib/integrations/instagram-webhook";
import { sendInstagramPrivateReply, sendWhatsAppButtons, sendWhatsAppList, sendWhatsAppText } from "../../../lib/integrations/meta-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context={params:Promise<{path:string[]}>};
const json=(body:unknown,status=200)=>NextResponse.json(body,{status});
const bodyJson=async(req:Request)=>req.json().catch(()=>null);
const leadSchema=z.object({
  firstName:z.string().trim().max(80).default(""),
  lastName:z.string().trim().max(80).default(""),
  phone:z.string().trim().optional().default(""),
  occasion:z.string().trim().min(1).max(50),
  eventDate:z.string().trim().max(80).optional().default(""),
  venue:z.string().trim().max(160).optional().default(""),
  budgetBand:z.enum(["essential","signature","premium"]).nullable().optional(),
  pagePath:z.string().max(120).default("/"),
  consentContact:z.boolean().default(false),
  consentText:z.string().max(500).default(""),
  source:z.enum(["smart_inquiry_form","entry_popup","whatsapp_intent"]).default("smart_inquiry_form"),
  utm:z.record(z.string().max(160)).default({})
});
const lostReasons=["price","date_taken","no_reply","out_of_area","chose_other","not_serious"] as const;

async function authRequired() {
  const session=await ownerSession();
  return session ? {session} : {response:json({error:"unauthorized"},401)};
}
async function dashboardSummary(tenantId:string) {
  return withTenant(tenantId,async db=>{
    const summary=await db.query<Record<string,string>>(
      "SELECT (SELECT count(DISTINCT visitor_id) FROM pageviews WHERE tenant_id=$1 AND created_at>=now()-interval '7 days') AS visitors_7d,(SELECT count(DISTINCT visitor_id) FROM pageviews WHERE tenant_id=$1 AND created_at>=now()-interval '30 days') AS visitors_30d,(SELECT count(*) FROM leads WHERE tenant_id=$1) AS inquiries,(SELECT count(*) FROM events WHERE tenant_id=$1 AND type='wa_tap') AS wa_taps,(SELECT count(*) FROM leads WHERE tenant_id=$1 AND status='new') AS unaddressed",
      [tenantId]);
    const demand=await db.query<{occasion:string;n:string}>(
      "SELECT occasion,count(*)::int AS n FROM leads WHERE tenant_id=$1 AND occasion<>'' AND status<>'spam' GROUP BY occasion ORDER BY n DESC",[tenantId]);
    return {summary:Object.fromEntries(Object.entries(summary.rows[0]??{}).map(([k,v])=>[k,Number(v)])),demand:demand.rows.map(r=>({occasion:r.occasion,count:Number(r.n)}))};
  });
}
async function dashboardLeads(tenantId:string,status:string|null) {
  return withTenant(tenantId,db=>db.query(
    "SELECT id,first_name,last_name,phone_e164,occasion,event_date,venue,score,tier,status,source,created_at,next_action_at FROM leads WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY score DESC,created_at DESC LIMIT 100",
    [tenantId,status]));
}

async function dispatchOutbox():Promise<{processed:number;failed:number;skipped:number}> {
  await rawQuery("DELETE FROM rate_hits WHERE window_start < now() - interval '1 day'");
  let processed=0,failed=0,skipped=0;
  const tenantIds=await listActiveTenantIds();
  for(const tenantId of tenantIds) {
    const tenant=await tenantBy("id",tenantId);
    if(!tenant) continue;
    const batch=await withTenant(tenantId,async db=>{
      await db.query("UPDATE message_outbox SET state='queued' WHERE tenant_id=$1 AND state='processing' AND created_at<now()-interval '10 minutes'",[tenantId]);
      const claimed=await db.query<{id:string;lead_id:string|null;channel:string;recipient:string;message_type:string;payload:Record<string,unknown>;attempts:number}>(
        "WITH picked AS (SELECT id FROM message_outbox WHERE tenant_id=$1 AND state='queued' AND due_at<=now() ORDER BY due_at LIMIT 20 FOR UPDATE SKIP LOCKED) UPDATE message_outbox m SET state='processing' FROM picked WHERE m.id=picked.id RETURNING m.id,m.lead_id,m.channel,m.recipient,m.message_type,m.payload,m.attempts",
        [tenantId]
      );
      return claimed.rows;
    });
    const integrations=new Map<string,Awaited<ReturnType<typeof tenantIntegration>>>();
    for(const item of batch) {
      try {
        if(item.channel==="whatsapp") {
          if(!integrations.has("whatsapp")) integrations.set("whatsapp",await tenantIntegration(tenantId,"whatsapp"));
          const integration=integrations.get("whatsapp");
          if(!integration||integration.status!=="authorized"||!integration.externalAccountId) throw new Error("WhatsApp integration is not authorized");
          const policy=await withTenant(tenantId,db=>db.query<{last_inbound_at:string|null;bot_enabled:boolean;opted_out_at:string|null}>(
            "SELECT l.last_inbound_at,t.bot_enabled,cs.opted_out_at FROM leads l JOIN tenants t ON t.id=l.tenant_id LEFT JOIN conversation_state cs ON cs.tenant_id=l.tenant_id AND cs.lead_id=l.id WHERE l.tenant_id=$1 AND l.id=$2",
            [tenantId,item.lead_id]
          ));
          const row=policy.rows[0];
          if(!row?.bot_enabled||!row.last_inbound_at||Date.now()-new Date(row.last_inbound_at).getTime()>24*60*60*1000) {
            await withTenant(tenantId,db=>db.query("UPDATE message_outbox SET state='skipped' WHERE id=$1 AND tenant_id=$2",[item.id,tenantId]));skipped++;continue;
          }
          const payload=item.payload as {type?:string;text?:string;buttons?:{id:string;title:string}[]};
          if(row.opted_out_at && !(payload.text??"").startsWith("Okay, we will not message you again")) {
            await withTenant(tenantId,db=>db.query("UPDATE message_outbox SET state='skipped' WHERE id=$1 AND tenant_id=$2",[item.id,tenantId]));skipped++;continue;
          }
          if(item.message_type==="send_buttons") await sendWhatsAppButtons({token:integration.accessToken,phoneNumberId:integration.externalAccountId,to:item.recipient,text:payload.text??"",buttons:payload.buttons??[]});
          else if(item.message_type==="send_list") await sendWhatsAppList({token:integration.accessToken,phoneNumberId:integration.externalAccountId,to:item.recipient,text:payload.text??"",buttonLabel:String(payload.buttonLabel??"Choose"),rows:(payload.rows??[]) as {id:string;title:string}[]});
          else if(item.message_type==="send_samples") await sendWhatsAppText({token:integration.accessToken,phoneNumberId:integration.externalAccountId,to:item.recipient,text:"Here is some of our "+String(payload.occasion??"studio")+" work: https://studio-x-blush.vercel.app/"+tenant.slug+"/gallery"});
          else await sendWhatsAppText({token:integration.accessToken,phoneNumberId:integration.externalAccountId,to:item.recipient,text:payload.text??""});
          await withTenant(tenantId,async db=>{
            await db.query("UPDATE message_outbox SET state='sent',sent_at=now() WHERE id=$1 AND tenant_id=$2",[item.id,tenantId]);
            await db.query("INSERT INTO bot_messages (tenant_id,lead_id,direction,channel,message_type,body,delivery_status) VALUES ($1,$2,'outbound','whatsapp',$3,$4,'sent')",[tenantId,item.lead_id,item.message_type,payload.text??""]);
            if(item.lead_id) await db.query("UPDATE leads SET last_outbound_at=now() WHERE id=$1 AND tenant_id=$2",[item.lead_id,tenantId]);
          });
          processed++;
        } else if(item.channel==="instagram") {
          if(!integrations.has("instagram")) integrations.set("instagram",await tenantIntegration(tenantId,"instagram"));
          const integration=integrations.get("instagram");
          if(!integration||integration.status!=="authorized") throw new Error("Instagram integration is not authorized");
          const payload=item.payload as {commentId?:string;text?:string};
          const comment=await withTenant(tenantId,db=>db.query<{private_reply_sent_at:string|null}>("SELECT private_reply_sent_at FROM ig_comments WHERE tenant_id=$1 AND ig_comment_id=$2",[tenantId,payload.commentId??""]));
          if(!comment.rows[0]||comment.rows[0].private_reply_sent_at) {
            await withTenant(tenantId,db=>db.query("UPDATE message_outbox SET state='skipped' WHERE id=$1 AND tenant_id=$2",[item.id,tenantId]));skipped++;continue;
          }
          await sendInstagramPrivateReply({token:integration.accessToken,commentId:payload.commentId??"",text:payload.text??""});
          await withTenant(tenantId,async db=>{
            await db.query("UPDATE ig_comments SET status='replied',private_reply_sent_at=now() WHERE tenant_id=$1 AND ig_comment_id=$2 AND private_reply_sent_at IS NULL",[tenantId,payload.commentId??""]);
            await db.query("UPDATE message_outbox SET state='sent',sent_at=now() WHERE id=$1 AND tenant_id=$2",[item.id,tenantId]);
          });
          processed++;
        } else {
          await withTenant(tenantId,db=>db.query("UPDATE message_outbox SET state='skipped' WHERE id=$1 AND tenant_id=$2",[item.id,tenantId]));skipped++;
        }
      } catch(error) {
        const message=error instanceof Error?error.message:"provider_error";
        await withTenant(tenantId,async db=>{
          const attempts=item.attempts+1;const state=attempts>=5?"dead":"queued";
          await db.query("UPDATE message_outbox SET state=$3,attempts=$4,last_error=$5,due_at=now()+($4::int * interval '2 minutes') WHERE id=$1 AND tenant_id=$2",[item.id,tenantId,state,attempts,message.slice(0,500)]);
          if(state==="dead") await db.query("INSERT INTO dead_letter_jobs (tenant_id,job_type,payload,error,attempts) VALUES ($1,'message_outbox',$2,$3,$4)",[tenantId,JSON.stringify({outboxId:item.id}),message.slice(0,500),attempts]);
        });
        failed++;
      }
    }
  }
  return {processed,failed,skipped};
}

async function writeAudit(db:Db,tenantId:string,actor:string,role:string,action:string,id:string|null,after:unknown) {
  await audit(db,tenantId,actor,role,action,"lead",id,after);
}

export async function GET(req:Request,context:Context) {
  const {path}=await context.params;
  const route=path.join("/");
  if(route==="cron/outbox") {
    const secret=process.env.CRON_SECRET;if(!secret||req.headers.get("authorization")!=="Bearer "+secret) return json({error:"unauthorized"},401);
    return json(await dispatchOutbox());
  }

  if(route==="integrations/status") {
    const auth=await authRequired();if("response" in auth)return auth.response;
    return json({integrations:await integrationStatuses(auth.session.tenantId)});
  }
  if(route==="integrations/instagram/connect") {
    const auth=await authRequired();if("response" in auth)return auth.response;
    const appId=process.env.INSTAGRAM_APP_ID,redirectUri=process.env.INSTAGRAM_REDIRECT_URI;
    if(!appId||!redirectUri)return json({error:"instagram_oauth_not_configured"},503);
    const state=randomUUID();const jar=await cookies();
    jar.set("sx_ig_oauth_state",state,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/api/integrations/instagram/callback",maxAge:600});
    const url=new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set("client_id",appId);url.searchParams.set("redirect_uri",redirectUri);url.searchParams.set("response_type","code");
    url.searchParams.set("scope",process.env.INSTAGRAM_OAUTH_SCOPES??"instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages");
    url.searchParams.set("state",state);url.searchParams.set("enable_fb_login","0");
    return NextResponse.redirect(url);
  }
  if(route==="integrations/youtube/connect") {
    const auth=await authRequired();if("response" in auth)return auth.response;
    const clientId=process.env.GOOGLE_CLIENT_ID,redirectUri=process.env.YOUTUBE_REDIRECT_URI;
    if(!clientId||!redirectUri)return json({error:"youtube_oauth_not_configured"},503);
    const state=randomUUID();const jar=await cookies();
    jar.set("sx_yt_oauth_state",state,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/api/integrations/youtube/callback",maxAge:600});
    const url=new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id",clientId);url.searchParams.set("redirect_uri",redirectUri);url.searchParams.set("response_type","code");
    url.searchParams.set("scope",process.env.YOUTUBE_OAUTH_SCOPES??"https://www.googleapis.com/auth/youtube.readonly");
    url.searchParams.set("access_type","offline");url.searchParams.set("prompt","consent");url.searchParams.set("include_granted_scopes","true");url.searchParams.set("state",state);
    return NextResponse.redirect(url);
  }
  if(route==="integrations/whatsapp/connect") {
    const auth=await authRequired();if("response" in auth)return auth.response;
    if(!process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || !process.env.NEXT_PUBLIC_META_APP_ID) return json({error:"whatsapp_embedded_signup_not_configured"},503);
    return json({error:"whatsapp_embedded_signup_client_pending"},501);
  }
  if(route==="integrations/instagram/callback") {
    const auth=await authRequired();if("response" in auth)return NextResponse.redirect(new URL("/dashboard?integration=unauthorized",req.url));
    const url=new URL(req.url),state=url.searchParams.get("state"),code=url.searchParams.get("code"),jar=await cookies();
    const saved=jar.get("sx_ig_oauth_state")?.value;jar.set("sx_ig_oauth_state","",{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/api/integrations/instagram/callback",maxAge:0});
    if(!state||!saved||state!==saved||!code)return NextResponse.redirect(new URL("/dashboard?integration=instagram_failed",req.url));
    try{
      const form=new URLSearchParams({client_id:process.env.INSTAGRAM_APP_ID??"",client_secret:process.env.INSTAGRAM_APP_SECRET??"",grant_type:"authorization_code",redirect_uri:process.env.INSTAGRAM_REDIRECT_URI??"",code});
      const shortResponse=await fetch("https://api.instagram.com/oauth/access_token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form});
      if(!shortResponse.ok)throw new Error("Instagram token exchange failed");
      const shortToken=await shortResponse.json() as {access_token:string;user_id:string};
      const longUrl=new URL("https://graph.instagram.com/access_token");longUrl.searchParams.set("grant_type","ig_exchange");longUrl.searchParams.set("client_secret",process.env.INSTAGRAM_APP_SECRET??"");longUrl.searchParams.set("access_token",shortToken.access_token);
      const longResponse=await fetch(longUrl);if(!longResponse.ok)throw new Error("Instagram long-lived token exchange failed");
      const longToken=await longResponse.json() as {access_token:string;expires_in:number};
      const profileUrl=new URL("https://graph.instagram.com/me");profileUrl.searchParams.set("fields","id,username");profileUrl.searchParams.set("access_token",longToken.access_token);
      const profileResponse=await fetch(profileUrl);if(!profileResponse.ok)throw new Error("Instagram profile lookup failed");
      const profile=await profileResponse.json() as {id:string};
      const subscribeUrl=new URL("https://graph.instagram.com/"+(process.env.META_GRAPH_API_VERSION??"v27.0")+"/"+encodeURIComponent(profile.id)+"/subscribed_apps");
      subscribeUrl.searchParams.set("subscribed_fields","comments,messages");subscribeUrl.searchParams.set("access_token",longToken.access_token);
      const subscribed=await fetch(subscribeUrl,{method:"POST"});
      if(!subscribed.ok)throw new Error("Instagram webhook subscription failed");
      const scopes=(process.env.INSTAGRAM_OAUTH_SCOPES??"instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages").split(",");
      await saveTenantIntegration({tenantId:auth.session.tenantId,provider:"instagram",externalAccountId:profile.id,accessToken:longToken.access_token,expiresAt:new Date(Date.now()+longToken.expires_in*1000).toISOString(),scopes});
      return NextResponse.redirect(new URL("/dashboard?integration=instagram_connected",req.url));
    }catch{return NextResponse.redirect(new URL("/dashboard?integration=instagram_failed",req.url));}
  }
  if(route==="integrations/youtube/callback") {
    const auth=await authRequired();if("response" in auth)return NextResponse.redirect(new URL("/dashboard?integration=unauthorized",req.url));
    const url=new URL(req.url),state=url.searchParams.get("state"),code=url.searchParams.get("code"),jar=await cookies();
    const saved=jar.get("sx_yt_oauth_state")?.value;jar.set("sx_yt_oauth_state","",{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/api/integrations/youtube/callback",maxAge:0});
    if(!state||!saved||state!==saved||!code)return NextResponse.redirect(new URL("/dashboard?integration=youtube_failed",req.url));
    try{
      const form=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID??"",client_secret:process.env.GOOGLE_CLIENT_SECRET??"",code,grant_type:"authorization_code",redirect_uri:process.env.YOUTUBE_REDIRECT_URI??""});
      const tokenResponse=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form});
      if(!tokenResponse.ok)throw new Error("Google token exchange failed");
      const token=await tokenResponse.json() as {access_token:string;refresh_token?:string;expires_in:number;scope?:string};
      const channelResponse=await fetch("https://youtube.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true",{headers:{Authorization:"Bearer "+token.access_token}});
      if(!channelResponse.ok)throw new Error("YouTube channel lookup failed");
      const channel=await channelResponse.json() as {items?:Array<{id:string}>};
      const channelId=channel.items?.[0]?.id;if(!channelId)throw new Error("No authorized YouTube channel found");
      await saveTenantIntegration({tenantId:auth.session.tenantId,provider:"youtube",externalAccountId:channelId,accessToken:token.access_token,refreshToken:token.refresh_token??null,expiresAt:new Date(Date.now()+token.expires_in*1000).toISOString(),scopes:(token.scope??"").split(" ").filter(Boolean)});
      return NextResponse.redirect(new URL("/dashboard?integration=youtube_connected",req.url));
    }catch{return NextResponse.redirect(new URL("/dashboard?integration=youtube_failed",req.url));}
  }

  if(route==="auth/session") {
    const session=await ownerSession();
    return session?json({authenticated:true,role:session.role}):json({authenticated:false},401);
  }
  if(route==="webhooks/whatsapp" || route==="webhooks/instagram") {
    const url=new URL(req.url);
    const mode=url.searchParams.get("hub.mode");
    const token=url.searchParams.get("hub.verify_token");
    const challenge=url.searchParams.get("hub.challenge");
    if(mode==="subscribe" && token && token===process.env.META_WEBHOOK_VERIFY_TOKEN && challenge) {
      return new Response(challenge,{status:200,headers:{"Content-Type":"text/plain"}});
    }
    return json({error:"verification_failed"},403);
  }

  if(route==="social/profiles") {
    const auth=await authRequired();if("response" in auth)return auth.response;
    const result=await withTenant(auth.session.tenantId,db=>db.query("SELECT provider,profile_url,handle FROM social_profiles WHERE tenant_id=$1 ORDER BY provider",[auth.session.tenantId]));
    return json({profiles:result.rows});
  }

  if(route==="dashboard/summary" || route==="dashboard/leads") {
    const auth=await authRequired();
    if("response" in auth) return auth.response;
    if(route==="dashboard/summary") return json(await dashboardSummary(auth.session.tenantId));
    const status=new URL(req.url).searchParams.get("status");
    if(status && !["new","addressed","qualified","quote_requested","quoted","negotiating","booked","won","lost","spam"].includes(status)) return json({error:"invalid_status"},400);
    const result=await dashboardLeads(auth.session.tenantId,status);
    return json({leads:result.rows});
  }
  return json({error:"not_found"},404);
}

export async function POST(req:Request,context:Context) {
  const {path}=await context.params;
  const route=path.join("/");
  const rawText=await req.text();
  let raw:unknown=null;try{raw=JSON.parse(rawText);}catch{}
  const limits:Record<string,[number,number]>={"auth/request-otp":[5,600],"auth/verify-otp":[10,600],"public/enquiries":[10,600],"analytics/pageview":[120,600],"leads/intent":[60,600]};
  if(limits[route]){const [limit,windowSec]=limits[route];if(!(await allow(clientKey(req,route),limit,windowSec)))return json({error:"too_many"},429);}

  if(route==="webhooks/whatsapp" || route==="webhooks/instagram") {
    const signature=req.headers.get("x-hub-signature-256");
    if(!verifyMetaSignature(rawText,signature,process.env.META_APP_SECRET)) return json({error:"invalid_signature"},401);
    const provider=route.endsWith("whatsapp")?"whatsapp":"instagram";
    const events=provider==="whatsapp"?normalizeWhatsAppWebhook(raw):normalizeInstagramWebhook(raw);
    for(const event of events) {
      const externalId=provider==="whatsapp"?event.metadata.phoneNumberId:event.metadata.entryId;
      const tenant=await tenantByProviderAccount(provider,externalId);
      if(!tenant) continue;
      const occurredAt=event.occurredAt?new Date(/^\d+$/.test(event.occurredAt)?Number(event.occurredAt)*1000:event.occurredAt).toISOString():undefined;
      const fresh=await persistInboundEvent({tenantId:tenant.id,provider,eventId:event.providerEventId,eventType:event.eventType,payload:event,signatureValid:true,occurredAt});
      if(!fresh) continue;
      if(provider==="whatsapp" && event.eventType.startsWith("message.") && !event.eventType.startsWith("message.status.")) await processWhatsAppInbound(tenant,event);
      if(provider==="instagram" && event.eventType==="comment.created") await processInstagramComment(tenant,event);
    }
    return json({received:true,accepted:events.length},202);
  }


  if(route==="social/profiles") {
    const auth=await authRequired();if("response" in auth)return auth.response;
    const parsed=z.object({provider:z.enum(["instagram","facebook","youtube"]),profileUrl:z.string().url().max(500)}).safeParse(raw);
    if(!parsed.success)return json({error:"invalid"},400);
    const url=new URL(parsed.data.profileUrl);
    const allowed:Record<string,string[]>={instagram:["instagram.com","www.instagram.com"],facebook:["facebook.com","www.facebook.com","fb.com"],youtube:["youtube.com","www.youtube.com","youtu.be"]};
    if(url.protocol!=="https:"||!allowed[parsed.data.provider].includes(url.hostname.toLowerCase()))return json({error:"profile_domain_invalid"},400);
    const handle=url.pathname.split("/").filter(Boolean)[0]??"";
    await withTenant(auth.session.tenantId,db=>db.query(
      "INSERT INTO social_profiles (tenant_id,provider,profile_url,handle) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,provider) DO UPDATE SET profile_url=excluded.profile_url,handle=excluded.handle,updated_at=now()",
      [auth.session.tenantId,parsed.data.provider,url.toString(),handle]
    ));
    return json({ok:true},201);
  }

  if(route==="auth/request-otp") {
    const parsed=z.object({tenantSlug:z.string().min(2).max(64),phone:z.string().min(10).max(16)}).safeParse(raw);
    if(!parsed.success) return json({error:"invalid"},400);
    const tenant=await tenantBy("slug",parsed.data.tenantSlug);
    const phone=normalizePhoneOrNull(parsed.data.phone);
    const ownerPhone=tenant?normalizePhoneOrNull(tenant.owner_alert_number):null;
    if(!tenant || !phone || phone!==ownerPhone) return json({ok:true});
    const allowed=await withTenant(tenant.id,async db=>{
      const count=await db.query<{n:string}>("SELECT count(*) AS n FROM otps WHERE tenant_id=$1 AND phone=$2 AND consumed_at IS NULL AND expires_at>now() AND created_at>now()-interval '30 minutes'",[tenant.id,phone]);
      if(Number(count.rows[0]?.n??0)>=3) return false;
      const code=newOtp();
      await db.query("INSERT INTO otps (tenant_id,phone,code_hash,expires_at) VALUES ($1,$2,$3,now()+interval '10 minutes')",[tenant.id,phone,hashOtp(code,phone)]);
      return code;
    });
    if(!allowed) return json({error:"too_many_requests"},429);
    try { await deliverOtp(phone,allowed); }
    catch { return json({error:"delivery_unavailable"},503); }
    return json({ok:true});
  }

  if(route==="auth/verify-otp") {
    const parsed=z.object({tenantSlug:z.string().min(2).max(64),phone:z.string().min(10).max(16),code:z.string().regex(/^\d{6}$/)}).safeParse(raw);
    if(!parsed.success) return json({error:"invalid"},400);
    const tenant=await tenantBy("slug",parsed.data.tenantSlug);
    const phone=normalizePhoneOrNull(parsed.data.phone);
    if(!tenant || !phone || phone!==normalizePhoneOrNull(tenant.owner_alert_number)) return json({error:"invalid_code"},401);
    const result=await withTenant(tenant.id,async db=>{
      const found=await db.query<{id:string;code_hash:string;attempts:number}>(
        "SELECT id,code_hash,attempts FROM otps WHERE tenant_id=$1 AND phone=$2 AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[tenant.id,phone]);
      const otp=found.rows[0];
      if(!otp) return "invalid";
      if(otp.attempts>=5) return "locked";
      const {otpMatches}=await import("../../../lib/server");
      if(!otpMatches(parsed.data.code,phone,otp.code_hash)) {
        await db.query("UPDATE otps SET attempts=attempts+1 WHERE id=$1 AND tenant_id=$2",[otp.id,tenant.id]);
        return otp.attempts+1>=5?"locked":"invalid";
      }
      await db.query("UPDATE otps SET consumed_at=now() WHERE id=$1 AND tenant_id=$2",[otp.id,tenant.id]);
      await db.query("INSERT INTO tenant_memberships (tenant_id,phone_e164,role,status) VALUES ($1,$2,'studio.owner','active') ON CONFLICT (tenant_id,phone_e164) DO UPDATE SET status='active'",[tenant.id,phone]);
      await db.query("INSERT INTO audit_events (tenant_id,actor_ref,actor_role,action,entity_type) VALUES ($1,$2,'studio.owner','auth.login','session')",[tenant.id,phone]);
      return "ok";
    });
    if(result==="locked") return json({error:"locked"},429);
    if(result!=="ok") return json({error:"invalid_code"},401);
    const jar=await cookies();
    jar.set(SESSION_COOKIE,signSession({tenantId:tenant.id,phone,role:"studio.owner",exp:Date.now()+7*86400000}),{
      httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:7*86400
    });
    return json({ok:true});
  }

  if(route==="auth/logout") {
    const jar=await cookies();
    jar.set(SESSION_COOKIE,"",{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:0});
    return json({ok:true});
  }


  if(route==="integrations/whatsapp/exchange") {
    const auth=await authRequired();if("response" in auth)return auth.response;
    const parsed=z.object({code:z.string().min(10).max(4096),wabaId:z.string().min(4).max(160),phoneNumberId:z.string().min(4).max(160)}).safeParse(raw);
    if(!parsed.success)return json({error:"invalid"},400);
    const appId=process.env.META_APP_ID??process.env.NEXT_PUBLIC_META_APP_ID;
    const appSecret=process.env.META_APP_SECRET;
    if(!appId||!appSecret)return json({error:"meta_app_not_configured"},503);
    const version=process.env.META_GRAPH_API_VERSION??"v27.0";
    try {
      const tokenUrl=new URL("https://graph.facebook.com/"+version+"/oauth/access_token");
      tokenUrl.searchParams.set("client_id",appId);tokenUrl.searchParams.set("client_secret",appSecret);tokenUrl.searchParams.set("code",parsed.data.code);
      const tokenResponse=await fetch(tokenUrl,{signal:AbortSignal.timeout(10000)});
      if(!tokenResponse.ok)throw new Error("Meta authorization code exchange failed");
      const token=await tokenResponse.json() as {access_token:string;expires_in?:number};
      const phoneUrl=new URL("https://graph.facebook.com/"+version+"/"+encodeURIComponent(parsed.data.wabaId)+"/phone_numbers");
      phoneUrl.searchParams.set("fields","id,display_phone_number,verified_name");
      const phoneResponse=await fetch(phoneUrl,{headers:{Authorization:"Bearer "+token.access_token},signal:AbortSignal.timeout(10000)});
      if(!phoneResponse.ok)throw new Error("WhatsApp phone number lookup failed");
      const phoneData=await phoneResponse.json() as {data?:Array<{id:string;display_phone_number?:string}>};
      const phone=phoneData.data?.find(item=>item.id===parsed.data.phoneNumberId);
      if(!phone)throw new Error("The selected phone number does not belong to the authorized WhatsApp Business Account");
      const subscribeUrl="https://graph.facebook.com/"+version+"/"+encodeURIComponent(parsed.data.wabaId)+"/subscribed_apps";
      const subscribeResponse=await fetch(subscribeUrl,{method:"POST",headers:{Authorization:"Bearer "+token.access_token}});
      if(!subscribeResponse.ok)throw new Error("WhatsApp webhook subscription failed");
      await saveTenantIntegration({tenantId:auth.session.tenantId,provider:"whatsapp",externalAccountId:phone.id,externalBusinessId:parsed.data.wabaId,accessToken:token.access_token,expiresAt:token.expires_in?new Date(Date.now()+token.expires_in*1000).toISOString():null,scopes:["whatsapp_business_management","whatsapp_business_messaging"]});
      await withTenant(auth.session.tenantId,db=>db.query("UPDATE tenants SET whatsapp_phone_number_id=$2,whatsapp_number=$3,updated_at=now() WHERE id=$1",[auth.session.tenantId,phone.id,phone.display_phone_number??""]));
      return json({ok:true,phoneNumber:phone.display_phone_number??""});
    }catch(error){return json({error:error instanceof Error?error.message:"whatsapp_connection_failed"},502);}
  }

  if(route==="public/enquiries") {
    const parsed=leadSchema.safeParse(raw);
    if(!parsed.success) return json({error:"invalid",details:parsed.error.flatten()},400);
    const tenant=await resolvePublicTenant(req);
    if(!tenant) return json({error:"studio_not_found"},404);
    const phone=parsed.data.phone?normalizePhoneOrNull(parsed.data.phone):null;
    if(parsed.data.phone && !phone) return json({error:"invalid_phone"},400);
    const eventDate=parsed.data.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.data.eventDate)?parsed.data.eventDate:null;
    const result=await createLead({tenant,phone,firstName:parsed.data.firstName,lastName:parsed.data.lastName,
      occasion:parsed.data.occasion,eventDate,venue:parsed.data.venue,budgetBand:parsed.data.budgetBand??null,
      source:parsed.data.source,pagePath:parsed.data.pagePath,consent:parsed.data.consentContact,
      utm:parsed.data.utm,consentText:parsed.data.consentText});
    const message="Hello "+tenant.studio_name+", I would like to enquire about "+parsed.data.occasion+".";
    return json({leadId:result.leadId,coupon:result.coupon,waUrl:buildWhatsAppLink(tenant.whatsapp_number,message)},201);
  }

  if(route==="analytics/pageview" || route==="leads/intent") {
    const tenant=await resolvePublicTenant(req);
    if(!tenant) return json({ok:true});
    if(route==="analytics/pageview") {
      const parsed=z.object({path:z.string().max(120),visitorId:z.string().min(8).max(40),utm:z.record(z.string().max(160)).default({})}).safeParse(raw);
      if(!parsed.success) return json({error:"invalid"},400);
      await withTenant(tenant.id,db=>db.query("INSERT INTO pageviews (tenant_id,visitor_id,path,utm) VALUES ($1,$2,$3,$4)",[tenant.id,parsed.data.visitorId,parsed.data.path,JSON.stringify(parsed.data.utm)]));
      return json({ok:true});
    }
    const parsed=z.object({pagePath:z.string().max(120),button:z.string().max(40)}).safeParse(raw);
    if(!parsed.success) return json({error:"invalid"},400);
    await withTenant(tenant.id,db=>db.query("INSERT INTO events (tenant_id,type,meta) VALUES ($1,'wa_tap',$2)",[tenant.id,JSON.stringify({page:parsed.data.pagePath,button:parsed.data.button})]));
    return json({ok:true});
  }


  if(route==="dashboard/leads") {
    const auth=await authRequired(); if("response" in auth) return auth.response;
    const parsed=z.object({name:z.string().trim().min(2).max(120),phone:z.string().min(10).max(16),occasion:z.string().min(1).max(50),source:z.enum(["smart_inquiry_form","entry_popup","whatsapp_intent","walk_in","referral","unknown"]).default("unknown")}).safeParse(raw);
    if(!parsed.success) return json({error:"invalid"},400);
    const phone=normalizePhoneOrNull(parsed.data.phone);
    if(!phone) return json({error:"invalid_phone"},400);
    const tenant=await tenantBy("id",auth.session.tenantId);
    if(!tenant) return json({error:"not_found"},404);
    const parts=parsed.data.name.split(/\\s+/);
    const result=await createLead({tenant,phone,firstName:parts.shift()??"",lastName:parts.join(" "),occasion:parsed.data.occasion,eventDate:null,venue:"",budgetBand:null,source:parsed.data.source,pagePath:"/dashboard",consent:false,utm:{},consentText:""});
    return json({ok:true,leadId:result.leadId},201);
  }

  if(route==="publish/presign") {
    const auth=await authRequired(); if("response" in auth) return auth.response;
    const parsed=z.object({kind:z.enum(["gallery","hero","about","owner","effects_raw","effects_graded","reel_poster","brochure"]),contentType:z.enum(["image/webp","image/jpeg","application/pdf"])}).safeParse(raw);
    if(!parsed.success) return json({error:"invalid"},400);
    try { return json(await presignUpload(auth.session.tenantId,parsed.data.kind,parsed.data.contentType)); }
    catch { return json({error:"storage_unavailable"},503); }
  }

  if(route==="gallery") {
    const auth=await authRequired(); if("response" in auth) return auth.response;
    const parsed=z.object({kind:z.enum(["gallery","hero","about","owner","effects_raw","effects_graded","reel_poster"]),occasion:z.string().max(50).optional(),imageUrl:z.string().url(),thumbUrl:z.string().url().optional(),alt:z.string().max(160).default(""),caption:z.string().max(140).optional()}).safeParse(raw);
    if(!parsed.success) return json({error:"invalid"},400);
    if(!isTenantAsset(parsed.data.imageUrl,auth.session.tenantId) || (parsed.data.thumbUrl && !isTenantAsset(parsed.data.thumbUrl,auth.session.tenantId))) return json({error:"asset_scope_invalid"},400);
    const id=await withTenant(auth.session.tenantId,async db=>{
      const order=await db.query<{n:number}>("SELECT coalesce(max(sort_order),0)+1 AS n FROM gallery_items WHERE tenant_id=$1 AND kind=$2",[auth.session.tenantId,parsed.data.kind]);
      const inserted=await db.query<{id:string}>("INSERT INTO gallery_items (tenant_id,kind,occasion,sort_order,image_url,thumb_url,alt,caption) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [auth.session.tenantId,parsed.data.kind,parsed.data.occasion??null,order.rows[0].n,parsed.data.imageUrl,parsed.data.thumbUrl??null,parsed.data.alt,parsed.data.caption??null]);
      await audit(db,auth.session.tenantId,auth.session.phone,auth.session.role,"gallery.created","gallery_item",inserted.rows[0].id,{kind:parsed.data.kind});
      return inserted.rows[0].id;
    });
    const tenant=await tenantBy("id",auth.session.tenantId);
    if(tenant) { revalidatePath("/"+tenant.slug); revalidatePath("/"+tenant.slug+"/gallery"); }
    return json({ok:true,id},201);
  }

  return json({error:"not_found"},404);
}

export async function PATCH(req:Request,context:Context) {
  const {path}=await context.params;
  const route=path.join("/");
  const raw=await bodyJson(req);

  if(route==="onboarding/step") {
    const auth=await authRequired(); if("response" in auth) return auth.response;
    const parsed=z.object({step:z.number().int().min(1).max(5),data:z.record(z.unknown())}).safeParse(raw);
    if(!parsed.success) return json({error:"invalid"},400);
    const fields:Record<number,Record<string,(v:unknown)=>unknown>>={
      1:{studio_name:v=>z.string().min(2).max(120).parse(v),owner_name:v=>z.string().max(120).parse(v),tagline:v=>z.string().max(200).parse(v),city:v=>z.string().max(100).parse(v),address:v=>z.string().max(500).parse(v),landmark:v=>z.string().max(200).parse(v),maps_url:v=>z.string().max(500).parse(v),working_hours:v=>z.string().max(500).parse(v),whatsapp_number:v=>z.string().max(24).parse(v),owner_alert_number:v=>z.string().max(24).parse(v),theme_preset:v=>z.enum(["royal_ivory","festive","minimal","warm","editorial","classic"]).parse(v)},
      2:{pricing:v=>z.record(z.unknown()).parse(v),price_book:v=>z.record(z.unknown()).parse(v),budget_bands:v=>z.record(z.string().max(80)).parse(v),service_area:v=>z.string().max(500).parse(v),owner_reply_sla:v=>z.string().max(80).parse(v),delivery_sla:v=>z.string().max(120).parse(v)},
      3:{coupon_rules:v=>z.object({enabled:z.boolean(),expressCode:z.string().max(32),expressPct:z.number().int().min(1).max(50),standardCode:z.string().max(32),standardPct:z.number().int().min(1).max(50),validHours:z.number().int().min(1).max(168)}).strict().parse(v)},
      4:{brochure_pdf_url:v=>z.string().url().parse(v)},
      5:{}
    };
    const allowed=fields[parsed.data.step];
    const keys=Object.keys(parsed.data.data);
    if(keys.some(k=>!allowed[k])) return json({error:"unknown_field"},400);
    let entries:Array<[string,unknown]>;
    try { entries=keys.map(k=>[k,allowed[k](parsed.data.data[k])]); }
    catch { return json({error:"invalid_field"},400); }
    await withTenant(auth.session.tenantId,async db=>{
      const values:unknown[]=[auth.session.tenantId];
      const assignments=entries.map(([key,value])=>{values.push(typeof value==="object"?JSON.stringify(value):value);return key+"=$"+values.length+(typeof value==="object"?"::jsonb":"");});
      values.push(Math.min(5,parsed.data.step));
      const set=assignments.length?assignments.join(",")+",":"";
      await db.query("UPDATE tenants SET "+set+" onboarding_step=GREATEST(onboarding_step,$"+values.length+"),onboarding_completed=CASE WHEN $"+values.length+"=5 THEN true ELSE onboarding_completed END,updated_at=now() WHERE id=$1",values);
      await audit(db,auth.session.tenantId,auth.session.phone,auth.session.role,"onboarding.step_saved","tenant",auth.session.tenantId,{step:parsed.data.step,fields:keys});
    });
    return json({ok:true,step:parsed.data.step});
  }

  const match=route.match(/^leads\/([0-9a-f-]{36})$/i);
  if(match) {
    const auth=await authRequired(); if("response" in auth) return auth.response;
    const parsed=z.object({action:z.enum(["mark_addressed","mark_qualified","mark_booked","mark_lost","redeem_coupon"]),lostReason:z.enum(lostReasons).optional()}).safeParse(raw);
    if(!parsed.success || (parsed.data.action==="mark_lost" && !parsed.data.lostReason)) return json({error:"invalid"},400);
    const result=await withTenant(auth.session.tenantId,async db=>{
      let changed;
      if(parsed.data.action==="mark_addressed") changed=await db.query("UPDATE leads SET status='addressed',bot_paused_until=now()+interval '24 hours',updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 RETURNING id",[match[1],auth.session.tenantId]);
      else if(parsed.data.action==="mark_qualified") changed=await db.query("UPDATE leads SET status='qualified',updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 RETURNING id",[match[1],auth.session.tenantId]);
      else if(parsed.data.action==="mark_booked") changed=await db.query("UPDATE leads SET status='booked',updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 RETURNING id",[match[1],auth.session.tenantId]);
      else if(parsed.data.action==="mark_lost") changed=await db.query("UPDATE leads SET status='lost',lost_reason=$3,updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 RETURNING id",[match[1],auth.session.tenantId,parsed.data.lostReason]);
      else changed=await db.query("UPDATE coupons SET redeemed_at=now() WHERE lead_id=$1 AND tenant_id=$2 AND redeemed_at IS NULL AND expires_at>now() RETURNING id",[match[1],auth.session.tenantId]);
      if(!changed.rowCount) return false;
      await writeAudit(db,auth.session.tenantId,auth.session.phone,auth.session.role,"lead."+parsed.data.action,match[1],parsed.data);
      return true;
    });
    return result?json({ok:true}):json({error:"not_applicable"},409);
  }
  return json({error:"not_found"},404);
}

export async function DELETE(req:Request,context:Context) {
  const {path}=await context.params;
  if(path.join("/")!=="auth/logout") return json({error:"not_found"},404);
  const jar=await cookies();
  jar.set(SESSION_COOKIE,"",{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:0});
  return json({ok:true});
}
