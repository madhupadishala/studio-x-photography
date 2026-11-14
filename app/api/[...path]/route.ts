import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  audit, createLead, deliverOtp, hashOtp, newOtp, normalizePhoneOrNull,
  ownerSession, presignUpload, resolvePublicTenant, signSession, tenantBy,
  SESSION_COOKIE, withTenant, isTenantAsset, type Db
} from "../../../lib/server";
import { buildWhatsAppLink } from "../../../lib/domain";

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
async function writeAudit(db:Db,tenantId:string,actor:string,role:string,action:string,id:string|null,after:unknown) {
  await audit(db,tenantId,actor,role,action,"lead",id,after);
}

export async function GET(req:Request,context:Context) {
  const {path}=await context.params;
  const route=path.join("/");
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
  const raw=await bodyJson(req);

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
\n  if(route==="publish/presign") {
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
    const parsed=z.object({action:z.enum(["mark_addressed","mark_booked","mark_lost","redeem_coupon"]),lostReason:z.enum(lostReasons).optional()}).safeParse(raw);
    if(!parsed.success || (parsed.data.action==="mark_lost" && !parsed.data.lostReason)) return json({error:"invalid"},400);
    const result=await withTenant(auth.session.tenantId,async db=>{
      let changed;
      if(parsed.data.action==="mark_addressed") changed=await db.query("UPDATE leads SET status='addressed',bot_paused_until=now()+interval '24 hours',updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 RETURNING id",[match[1],auth.session.tenantId]);
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
