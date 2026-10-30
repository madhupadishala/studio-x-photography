import {NextResponse} from 'next/server';
import {PrismaClient} from '@prisma/client';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 let body:unknown;
 try{body=await request.json()}catch{return NextResponse.json({error:'Invalid request'},{status:400})}
 if(!body||typeof body!=='object')return NextResponse.json({error:'Invalid request'},{status:400});
 const {name,mobile}=body as {name?:unknown;mobile?:unknown};
 if(typeof name!=='string'||typeof mobile!=='string'||name.trim().length<2||name.length>80||!(/^(?:91)?[6-9]\d{9}$/.test(mobile)))return NextResponse.json({error:'Invalid details'},{status:400});
 const db=new PrismaClient();
 try{
  await db.visitorContact.create({data:{name:name.trim(),mobile:mobile.replace(/^91(?=[6-9]\d{9}$)/,''),source:'homepage-popup',consentText:'By submitting, you agree to be contacted about your enquiry.'}});
  return NextResponse.json({ok:true},{status:201,headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Unable to save'},{status:503})}
 finally{await db.$disconnect()}
}