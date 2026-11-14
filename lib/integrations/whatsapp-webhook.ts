import {createHmac} from "node:crypto";
import {createLead,withTenant,type TenantRow} from "../server";
import {
  extractOccasionFromText,initialGreeting,normalizeIndianPhone,scoreLead,stepConversation,
  type ConversationAnswers,type ConversationContext,type ConversationLanguage,type ConversationState,type LeadEvent
} from "../domain";
import type {NormalizedInboundEvent} from "./contracts";

const POINTS:Record<LeadEvent,number>={phone_valid:20,fast_reply:10,occasion_high_value:20,event_within_90d:30,event_later:10,venue_given:10,budget_upper:15,budget_essential:5,asked_price:10,asked_availability:10,viewed_samples:5,msgs_3plus:5,just_checking:-20,out_of_area:-30,silent_48h:-10};
const HIGH_VALUE=["wedding","reception","prewed","roka"];
const validRef=(value:string)=>/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(value.toUpperCase());
const hashSubject=(phone:string)=>{const pepper=process.env.OTP_PEPPER??"";if(pepper.length<32)throw new Error("OTP_PEPPER must contain at least 32 characters");return createHmac("sha256",pepper).update(phone).digest("hex");};
const asObject=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};

function context(tenant:TenantRow,knownOccasion?:string):ConversationContext {
  const base=asObject(tenant.price_book.base);
  const budget=tenant.budget_bands??{essential:"Essential",signature:"Signature",premium:"Premium"};
  const price=knownOccasion?base[knownOccasion]:undefined;
  return {
    studioName:tenant.studio_name,address:tenant.address,hours:tenant.working_hours,
    passportPrice:base.passport===undefined?"":String(base.passport),
    floorLabel:price===undefined||price===null||price===""?"": "₹"+String(price),
    ownerSla:tenant.owner_reply_sla,
    budgetLabels:{essential:budget.essential??"Essential",signature:budget.signature??"Signature",premium:budget.premium??"Premium"},
    knownOccasion,now:new Date()
  };
}
function inboundKind(event:NormalizedInboundEvent):"text"|"button"|"list"|"media" {
  if(event.metadata.messageType==="interactive")return event.metadata.interactiveKind==="list"?"list":"button";
  if(event.metadata.messageType==="text")return "text";
  return "media";
}
function referralCode(text:string):string|null {
  const match=text.match(/\[ref:\s*([A-Z0-9]{6})\]/i);
  if(!match)return null;
  const code=match[1].toUpperCase();return validRef(code)?code:null;
}
function inferIntentEvents(text:string):LeadEvent[] {
  const events:LeadEvent[]=[];const lower=text.toLowerCase();
  if(/\b(price|prices|rate|rates|cost|package)\b/.test(lower))events.push("asked_price");
  if(/\b(available|availability|date|dates|when)\b/.test(lower))events.push("asked_availability");
  if(/\bjust checking\b|\bjust asking\b/.test(lower))events.push("just_checking");
  return events;
}
function pointsFor(event:LeadEvent):number{return POINTS[event];}
async function addLeadEvent(db:{query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[];rowCount:number|null}>},tenantId:string,leadId:string,event:LeadEvent,meta:unknown={}){
  await db.query("INSERT INTO lead_events (tenant_id,lead_id,type,points,meta) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,lead_id,type) DO NOTHING",
    [tenantId,leadId,event,pointsFor(event),JSON.stringify(meta)]);
}
async function updateScore(db:{query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[];rowCount:number|null}>},tenantId:string,leadId:string){
  const rows=await db.query<{type:string}>("SELECT type FROM lead_events WHERE tenant_id=$1 AND lead_id=$2",[tenantId,leadId]);
  const events=rows.rows.map(row=>row.type).filter((value):value is LeadEvent=>Object.prototype.hasOwnProperty.call(POINTS,value));
  const score=scoreLead(events),tier=score>=70?"hot":score>=40?"warm":"cold";
  const before=await db.query<{tier:string}>("SELECT tier FROM leads WHERE tenant_id=$1 AND id=$2",[tenantId,leadId]);
  await db.query("UPDATE leads SET score=$3,tier=$4,score_reasons=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [tenantId,leadId,score,tier,JSON.stringify(events)]);
  if(before.rows[0]&&before.rows[0].tier!==tier&&tier==="hot") {
    await db.query("INSERT INTO events (tenant_id,type,meta) VALUES ($1,'owner_alert',$2)",
      [tenantId,JSON.stringify({leadId,reason:"lead_became_hot",score,tier})]);
  }
}
async function queueActions(db:{query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[];rowCount:number|null}>},tenant:TenantRow,leadId:string,phone:string,actions:ReturnType<typeof stepConversation>["actions"],eventId:string){
  for(let index=0;index<actions.length;index++){
    const action=actions[index];
    if(action.type==="send_text"||action.type==="send_buttons"||action.type==="send_list"||action.type==="send_samples"){
      await db.query("INSERT INTO message_outbox (tenant_id,lead_id,channel,recipient,message_type,payload,idempotency_key) VALUES ($1,$2,'whatsapp',$3,$4,$5,$6) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING",
        [tenant.id,leadId,phone,action.type,JSON.stringify(action),eventId+":reply:"+index]);
    }
    if(action.type==="pause_bot_24h")await db.query("UPDATE leads SET bot_paused_until=now()+interval '24 hours' WHERE id=$1 AND tenant_id=$2",[leadId,tenant.id]);
    if(action.type==="set_opt_in"){
      await db.query("UPDATE conversation_state SET opt_in_marketing=$3,opt_in_at=CASE WHEN $3 THEN now() ELSE opt_in_at END,opt_in_text=$4,opted_out_at=CASE WHEN $3 THEN NULL ELSE now() END WHERE tenant_id=$1 AND lead_id=$2",
        [tenant.id,leadId,action.value,action.text]);
      await db.query("UPDATE leads SET consent_marketing=$3 WHERE tenant_id=$1 AND id=$2",[tenant.id,leadId,action.value]);
      await db.query("INSERT INTO consent_events (tenant_id,lead_id,subject_ref,purpose,action,evidence) VALUES ($1,$2,$3,'marketing',$4,$5)",
        [tenant.id,leadId,hashSubject(phone),action.value?"granted":"revoked",action.text]);
    }
    if(action.type==="alert_owner")await db.query("INSERT INTO events (tenant_id,type,meta) VALUES ($1,'owner_alert',$2)",[tenant.id,JSON.stringify({leadId,reason:action.reason})]);
    if(action.type==="add_event"&&action.event!=="express")await addLeadEvent(db,tenant.id,leadId,action.event,{source:"conversation"});
    if(action.type==="add_event"&&action.event==="express")await db.query("UPDATE leads SET next_action_at=NULL WHERE tenant_id=$1 AND id=$2",[tenant.id,leadId]);
  }
}

export async function processWhatsAppInbound(tenant:TenantRow,event:NormalizedInboundEvent):Promise<void>{
  if(!event.externalActorId)return;
  const phone=normalizeIndianPhone(event.externalActorId);
  if(!phone)return;
  const kind=inboundKind(event),text=event.text??"";
  const code=kind==="text"?referralCode(text):null;
  const ref=code?await withTenant(tenant.id,db=>db.query<{keyword:string|null;occasion:string|null;claimed_at:string|null}>(
    "SELECT keyword,occasion,claimed_at FROM attribution_refs WHERE tenant_id=$1 AND ref_code=$2 LIMIT 1",[tenant.id,code]
  )):null;
  const attribution=ref?.rows[0]&&!ref.rows[0].claimed_at?ref.rows[0]:null;
  const knownOccasion=attribution?.occasion??(attribution?.keyword?attribution.keyword.toLowerCase():undefined)??extractOccasionFromText(text);
  const occasion=knownOccasion??"general enquiry";
  let leadId=await withTenant(tenant.id,async db=>{
    const found=await db.query<{id:string}>("SELECT id FROM leads WHERE tenant_id=$1 AND phone_e164=$2 AND status NOT IN ('booked','won','lost','spam') ORDER BY created_at DESC LIMIT 1",[tenant.id,phone]);
    return found.rows[0]?.id??null;
  });
  if(!leadId){
    const created=await createLead({tenant,phone,firstName:event.metadata.displayName??"",lastName:"",occasion,eventDate:null,venue:"",budgetBand:null,source:attribution?"instagram_dm":"whatsapp_bot",pagePath:attribution?"/instagram":"/whatsapp",consent:false,utm:{},consentText:""});
    leadId=created.leadId;
  }
  const waId=event.externalActorId.replace(/\D/g,"");
  await withTenant(tenant.id,async db=>{
    await db.query("INSERT INTO bot_messages (tenant_id,lead_id,provider_message_id,direction,channel,message_type,body) VALUES ($1,$2,$3,'inbound','whatsapp',$4,$5) ON CONFLICT DO NOTHING",
      [tenant.id,leadId,event.providerEventId,event.metadata.messageType,text]);
    await db.query("UPDATE leads SET last_inbound_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2",[leadId,tenant.id]);
    if(attribution&&code){
      await db.query("UPDATE attribution_refs SET claimed_at=now(),lead_id=$3 WHERE tenant_id=$1 AND ref_code=$2 AND claimed_at IS NULL",[tenant.id,code,leadId]);
      await db.query("UPDATE leads SET source='instagram_dm',source_first='instagram_dm',source_last='instagram_dm',occasion=$3 WHERE tenant_id=$1 AND id=$2",[tenant.id,leadId,occasion]);
    }
    const prior=await db.query<{state:string;answers:ConversationAnswers;unrecognized_count:number;lang:ConversationLanguage;opted_out_at:string|null}>(
      "SELECT state,answers,unrecognized_count,lang,opted_out_at FROM conversation_state WHERE tenant_id=$1 AND lead_id=$2",[tenant.id,leadId]);
    await addLeadEvent(db,tenant.id,leadId,"phone_valid");
    if(!tenant.bot_enabled){await updateScore(db,tenant.id,leadId);return;}
    if(prior.rows[0]?.state==="OWNER_HANDOFF"||prior.rows[0]?.state==="DONE"||prior.rows[0]?.opted_out_at)return;
    const lead=await db.query<{bot_paused_until:string|null;created_at:string;last_outbound_at:string|null}>(
      "SELECT bot_paused_until,created_at,last_outbound_at FROM leads WHERE tenant_id=$1 AND id=$2",[tenant.id,leadId]);
    if(lead.rows[0]?.bot_paused_until&&new Date(lead.rows[0].bot_paused_until).getTime()>Date.now())return;
    if(!prior.rows[0]&&kind==="text"&&!knownOccasion&&!/\b(stop|unsubscribe|cancel|owner|human|agent|call)\b/i.test(text)){
      await db.query("INSERT INTO conversation_state (tenant_id,lead_id,wa_id,state,lang,answers,last_inbound_at) VALUES ($1,$2,$3,'GREETED','en','{}',now()) ON CONFLICT (tenant_id,lead_id) DO NOTHING",[tenant.id,leadId,waId]);
      const greet=initialGreeting(context(tenant));
      await queueActions(db,tenant,leadId,phone,[greet],event.providerEventId);
      await updateScore(db,tenant.id,leadId);
      return;
    }
    const state=(prior.rows[0]?.state??"GREETED") as ConversationState;
    const answers=(prior.rows[0]?.answers??(knownOccasion?{occasion:knownOccasion}:{})) as ConversationAnswers;
    const lang=prior.rows[0]?.lang??"en";
    const ctx=context(tenant,knownOccasion);
    const result=stepConversation(state,answers,Number(prior.rows[0]?.unrecognized_count??0),{kind,value},lang,ctx);
    await db.query("INSERT INTO conversation_state (tenant_id,lead_id,wa_id,state,lang,answers,unrecognized_count,last_inbound_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT (tenant_id,lead_id) DO UPDATE SET state=excluded.state,lang=excluded.lang,answers=excluded.answers,unrecognized_count=excluded.unrecognized_count,last_inbound_at=now()",
      [tenant.id,leadId,waId,result.state,result.lang,JSON.stringify(result.answers),result.unrecognized]);
    const intentEvents=inferIntentEvents(text);
    for(const eventType of intentEvents)await addLeadEvent(db,tenant.id,leadId,eventType);
    if(result.answers.occasion&&HIGH_VALUE.includes(result.answers.occasion))await addLeadEvent(db,tenant.id,leadId,"occasion_high_value");
    if(result.answers.dateISO){
      const days=(new Date(result.answers.dateISO+"T00:00:00Z").getTime()-Date.now())/86400000;
      await addLeadEvent(db,tenant.id,leadId,days<=90?"event_within_90d":"event_later");
    }
    if(result.answers.venue)await addLeadEvent(db,tenant.id,leadId,"venue_given");
    if(result.answers.budget)await addLeadEvent(db,tenant.id,leadId,result.answers.budget==="essential"?"budget_essential":"budget_upper");
    const msgCount=await db.query<{n:number}>("SELECT count(*)::int AS n FROM bot_messages WHERE tenant_id=$1 AND lead_id=$2 AND direction='inbound'",[tenant.id,leadId]);
    if(Number(msgCount.rows[0]?.n??0)>=3)await addLeadEvent(db,tenant.id,leadId,"msgs_3plus");
    if(lead.rows[0]?.last_outbound_at&&Date.now()-new Date(lead.rows[0].last_outbound_at).getTime()<=5*60*1000)await addLeadEvent(db,tenant.id,leadId,"fast_reply");
    await queueActions(db,tenant,leadId,phone,result.actions,event.providerEventId);
    await updateScore(db,tenant.id,leadId);
    if(result.state!=="DONE"&&result.state!=="OWNER_HANDOFF"){
      await db.query("UPDATE nudge_queue SET cancelled_at=now() WHERE tenant_id=$1 AND lead_id=$2 AND sent_at IS NULL AND cancelled_at IS NULL",[tenant.id,leadId]);
      await db.query("INSERT INTO nudge_queue (tenant_id,lead_id,kind,due_at) VALUES ($1,$2,'soft_3h',now()+interval '3 hours'),($1,$2,'final_22h',now()+interval '22 hours') ON CONFLICT (lead_id,kind) DO UPDATE SET due_at=excluded.due_at,cancelled_at=NULL WHERE nudge_queue.sent_at IS NULL",[tenant.id,leadId]);
    }else{
      await db.query("UPDATE nudge_queue SET cancelled_at=now() WHERE tenant_id=$1 AND lead_id=$2 AND sent_at IS NULL AND cancelled_at IS NULL",[tenant.id,leadId]);
    }
  });
}
