type Button={id:string;title:string};
const graphVersion=()=>process.env.META_GRAPH_API_VERSION??"v27.0";
async function graphPost(url:string,token:string,body:Record<string,unknown>):Promise<void>{
  const response=await fetch(url,{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!response.ok){const payload=await response.json().catch(()=>({}));const error=payload as {error?:{code?:number;type?:string}};throw new Error("Meta API request failed ("+response.status+", "+String(error.error?.code??"unknown")+")");}
}
export async function sendWhatsAppText(input:{token:string;phoneNumberId:string;to:string;text:string}):Promise<void>{
  await graphPost("https://graph.facebook.com/"+graphVersion()+"/"+encodeURIComponent(input.phoneNumberId)+"/messages",input.token,{messaging_product:"whatsapp",recipient_type:"individual",to:input.to,type:"text",text:{preview_url:false,body:input.text}});
}
export async function sendWhatsAppButtons(input:{token:string;phoneNumberId:string;to:string;text:string;buttons:Button[]}):Promise<void>{
  const buttons=input.buttons.slice(0,3).map(button=>({type:"reply",reply:{id:button.id.slice(0,256),title:button.title.slice(0,20)}}));
  await graphPost("https://graph.facebook.com/"+graphVersion()+"/"+encodeURIComponent(input.phoneNumberId)+"/messages",input.token,{messaging_product:"whatsapp",recipient_type:"individual",to:input.to,type:"interactive",interactive:{type:"button",body:{text:input.text},action:{buttons}}});
}
export async function sendInstagramPrivateReply(input:{token:string;instagramUserId:string;commentId:string;text:string}):Promise<void>{
  await graphPost("https://graph.instagram.com/"+graphVersion()+"/"+encodeURIComponent(input.instagramUserId)+"/messages",input.token,{recipient:{comment_id:input.commentId},message:{text:input.text}});
}
