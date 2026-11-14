import {randomInt} from "node:crypto";
import {NextResponse} from "next/server";
import {buildWhatsAppLink} from "../../../lib/domain";
import {rawQuery,tenantBy,withTenant} from "../../../lib/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";

type Context={params:Promise<{slug:string}>};
const alphabet="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeRef():string{return Array.from({length:6},()=>alphabet[randomInt(0,alphabet.length)]).join("");}

export async function GET(req:Request,context:Context){
  const {slug}=await context.params;
  if(!/^[a-z0-9-]{1,80}$/i.test(slug))return new Response("Not found",{status:404});
  const url=new URL(req.url);
  const host=(req.headers.get("x-forwarded-host")??req.headers.get("host")??"").split(":")[0].toLowerCase();
  const mapped=host?await rawQuery<{tenant_id:string}>("SELECT tenant_id FROM tenant_domains WHERE hostname=$1 AND verification_status='verified' LIMIT 1",[host]):[];
  const tenant=mapped[0]?await tenantBy("id",mapped[0].tenant_id):await tenantBy("slug",url.searchParams.get("studio")??"");
  if(!tenant||!tenant.whatsapp_number)return new Response("Studio link is unavailable",{status:404});
  const keyword=slug.toLowerCase()==="youtube"?"channel":slug.toLowerCase();
  let refCode="";
  for(let attempt=0;attempt<8;attempt++){
    const candidate=makeRef();
    const inserted=await withTenant(tenant.id,db=>db.query<{ref_code:string}>(
      "INSERT INTO attribution_refs (tenant_id,ref_code,channel,keyword) VALUES ($1,$2,'youtube',$3) ON CONFLICT (tenant_id,ref_code) DO NOTHING RETURNING ref_code",
      [tenant.id,candidate,keyword]
    ));
    if(inserted.rows[0]){refCode=candidate;break;}
  }
  if(!refCode)return new Response("Please try again",{status:503});
  const message=keyword==="channel"?"Hi! I found your studio through your YouTube channel [ref: "+refCode+"]":"Hi! I saw your "+keyword+" video [ref: "+refCode+"]";
  return NextResponse.redirect(buildWhatsAppLink(tenant.whatsapp_number,message),302);
}
