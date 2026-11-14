import {randomInt} from "node:crypto";
import {buildWhatsAppLink} from "../domain";
import {tenantIntegration,withTenant,type TenantRow} from "../server";
import type {NormalizedInboundEvent} from "./contracts";

const TAXONOMY=["WEDDING","RECEPTION","PREWED","ROKA","MATERNITY","BABYSHOWER","NEWBORN","BIRTHDAY","TRADITIONAL","PORTRAIT","BRAND","PASSPORT"] as const;
const ALPHABET="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function matchKeyword(text:string):string|null {
  const lower=text.toLowerCase();
  for(const keyword of TAXONOMY)if(new RegExp("\\b"+keyword.toLowerCase()+"\\b","i").test(lower))return keyword;
  return null;
}
function makeRef():string {
  return Array.from({length:6},()=>ALPHABET[randomInt(0,ALPHABET.length)]).join("");
}
export async function processInstagramComment(tenant:TenantRow,event:NormalizedInboundEvent):Promise<void>{
  if(!event.externalActorId||!event.providerEventId)return;
  const integration=await tenantIntegration(tenant.id,"instagram");
  if(!integration||integration.status!=="authorized")return;
  if(event.externalActorId===integration.externalAccountId)return;
  const createdAt=new Date(event.occurredAt).getTime();
  if(!Number.isFinite(createdAt)||Date.now()-createdAt>6*86400000||createdAt>Date.now()+5*60000)return;
  const keyword=matchKeyword(event.text??"");
  const inserted=await withTenant(tenant.id,db=>db.query<{id:string}>(
    "INSERT INTO ig_comments (tenant_id,ig_comment_id,ig_media_id,ig_user_id,ig_username,comment_text,keyword,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,ig_comment_id) DO NOTHING RETURNING id",
    [tenant.id,event.providerEventId,event.sourceAssetId??null,event.externalActorId,event.metadata.username??null,event.text??"",keyword,keyword?"matched":"skipped",new Date(createdAt).toISOString()]
  ));
  if(!inserted.rows[0]||!keyword)return;
  if(!tenant.whatsapp_number){
    await withTenant(tenant.id,db=>db.query("UPDATE ig_comments SET status='skipped',error='Studio WhatsApp number is not configured' WHERE tenant_id=$1 AND ig_comment_id=$2",[tenant.id,event.providerEventId]));
    return;
  }
  let refCode="";
  for(let attempt=0;attempt<5;attempt++){
    const candidate=makeRef();
    const saved=await withTenant(tenant.id,db=>db.query<{ref_code:string}>(
      "INSERT INTO attribution_refs (tenant_id,ref_code,channel,ig_comment_id,ig_media_id,keyword) VALUES ($1,$2,'instagram',$3,$4,$5) ON CONFLICT (tenant_id,ref_code) DO NOTHING RETURNING ref_code",
      [tenant.id,candidate,event.providerEventId,event.sourceAssetId??null,keyword]
    ));
    if(saved.rows[0]){refCode=candidate;break;}
  }
  if(!refCode){
    await withTenant(tenant.id,db=>db.query("UPDATE ig_comments SET status='failed',error='Could not allocate a unique attribution code' WHERE tenant_id=$1 AND ig_comment_id=$2",[tenant.id,event.providerEventId]));
    return;
  }
  const link=buildWhatsAppLink(tenant.whatsapp_number,"Hi! I saw your "+keyword+" reel [ref: "+refCode+"]");
  const username=event.metadata.username?event.metadata.username+"!":"there!";
  const text="Hi "+username+" Thanks for commenting 😊\nTap to chat on WhatsApp and get dates and rates: "+link;
  await withTenant(tenant.id,db=>db.query(
    "INSERT INTO message_outbox (tenant_id,channel,recipient,message_type,payload,idempotency_key) VALUES ($1,'instagram',$2,'private_reply',$3,$4) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING",
    [tenant.id,event.externalActorId,JSON.stringify({commentId:event.providerEventId,text}),"ig-comment:"+event.providerEventId]
  ));
}
