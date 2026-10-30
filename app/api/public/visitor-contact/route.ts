import {NextResponse} from 'next/server';
import {PrismaClient} from '@prisma/client';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 let body:unknown;
 try{body=await request.json()}catch{return NextResponse.json({error:'Invalid request'},{status:400})}
 if(!body||typeof body!=='object')return NextResponse.json({error:'Invalid request'},{status:400});
 const {name,mobile,countryCode}=body as {name?:unknown;mobile?:unknown;countryCode?:unknown};
 const codes=['91','1','44','971','61','65','966','974','965','49'];
 if(typeof name!=='string'||typeof mobile!=='string'||typeof countryCode!=='string'||name.trim().length<2||name.length>80||!codes.includes(countryCode)||(countryCode==='91'?!/^[6-9]\d{9}$/.test(mobile):!/^[0-9]{6,14}$/.test(mobile)))return NextResponse.json({error:'Invalid details'},{status:400});
 const db=new PrismaClient();
 try{
  await db.visitorContact.create({data:{name:name.trim(),mobile:'+'+countryCode+mobile,source:'homepage-popup',consentText:'By submitting, you agree to be contacted about your enquiry.'}});
  const ownerEmail=process.env.STUDIO_OWNER_NOTIFICATION_EMAIL;const apiKey=process.env.RESEND_API_KEY;const from=process.env.STUDIO_NOTIFICATION_FROM_EMAIL;
  let notified=false;
  if(ownerEmail&&apiKey&&from){try{const notice=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({from,to:[ownerEmail],subject:'Studio X — New visitor contact',text:'Name: '+name.trim()+'\\nPhone: +'+countryCode+mobile+'\\nSource: Visitor popup\\nTime: '+new Date().toISOString()})});notified=notice.ok}catch{}}
  return NextResponse.json({ok:true,ownerNotified:notified},{status:201,headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Unable to save'},{status:503})}
 finally{await db.$disconnect()}
}