export type LeadEvent =
  | "phone_valid" | "fast_reply" | "occasion_high_value" | "event_within_90d"
  | "event_later" | "venue_given" | "budget_upper" | "budget_essential"
  | "asked_price" | "asked_availability" | "viewed_samples" | "msgs_3plus"
  | "just_checking" | "out_of_area" | "silent_48h";

const SCORE: Record<LeadEvent, number> = {
  phone_valid:20, fast_reply:10, occasion_high_value:20, event_within_90d:30,
  event_later:10, venue_given:10, budget_upper:15, budget_essential:5,
  asked_price:10, asked_availability:10, viewed_samples:5, msgs_3plus:5,
  just_checking:-20, out_of_area:-30, silent_48h:-10
};
export function scoreLead(events:LeadEvent[]):number {
  return Math.max(0,Math.min(100,[...new Set(events)].reduce((sum,event)=>sum+SCORE[event],0)));
}
export function scoreLeadDetails(events:LeadEvent[]):{score:number;tier:"hot"|"warm"|"cold";reasons:LeadEvent[]} {
  const reasons=[...new Set(events)],score=scoreLead(reasons);
  return {score,tier:score>=70?"hot":score>=40?"warm":"cold",reasons};
}
export function normalizeIndianPhone(value:string):string|null {
  const digits=value.replace(/\D/g,"");
  const national=digits.startsWith("91")&&digits.length===12?digits.slice(2):digits;
  return /^[6-9]\d{9}$/.test(national)?"+91"+national:null;
}
export function buildWhatsAppLink(phone:string,message:string):string {
  const digits=phone.replace(/\D/g,"");
  return "https://wa.me/"+digits+(message?"?text="+encodeURIComponent(message):"");
}

const MONTHS:Record<string,number>={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
export function parseEventDate(value:string,now=new Date()):string|null {
  const text=value.trim().replace(/,/g," ").replace(/\s+/g," ");
  let day=0,month=0,year:number|undefined;
  let match=text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?$/);
  if(match){day=Number(match[1]);month=MONTHS[match[2].toLowerCase()]??0;if(match[3])year=Number(match[3]);}
  if(!match){match=text.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:\s+(\d{4}))?$/);if(match){month=MONTHS[match[1].toLowerCase()]??0;day=Number(match[2]);if(match[3])year=Number(match[3]);}}
  if(!match){match=text.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?$/);if(match){day=Number(match[1]);month=Number(match[2]);if(match[3])year=Number(match[3]);}}
  if(!match||!month||day<1||day>31||(year!==undefined&&(year<now.getFullYear()||year>now.getFullYear()+10)))return null;
  const make=(y:number)=>{const d=new Date(Date.UTC(y,month-1,day));return d.getUTCFullYear()===y&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?d:null;};
  if(year!==undefined){const d=make(year);return d?d.toISOString().slice(0,10):null;}
  let candidate=make(now.getFullYear());if(!candidate)return null;
  const today=Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());
  if(candidate.getTime()<today){candidate=make(now.getFullYear()+1);if(!candidate)return null;}
  return candidate.toISOString().slice(0,10);
}

export type ConversationState="GREETED"|"ASK_OCCASION"|"ASK_DATE"|"ASK_VENUE"|"ASK_BUDGET"|"ASK_SOURCE"|"ASK_NAME"|"QUOTE_READY"|"ASK_OPT_IN"|"OWNER_HANDOFF"|"DONE";
export type ConversationLanguage="en"|"hi-rom"|"te-rom"|"te"|"hi";
export interface ConversationAnswers {occasion?:string;dateText?:string;dateISO?:string;venue?:string;budget?:"essential"|"signature"|"premium";name?:string}
export type ConversationAction=
 |{type:"send_text";text:string}
 |{type:"send_buttons";text:string;buttons:{id:string;title:string}[]}
 |{type:"send_list";text:string;buttonLabel:string;rows:{id:string;title:string}[]}
 |{type:"send_samples";occasion:string}
 |{type:"alert_owner";reason:string}
 |{type:"add_event";event:LeadEvent|"express"}
 |{type:"pause_bot_24h"}
 |{type:"set_opt_in";value:boolean;text:string};
export interface ConversationContext {studioName?:string;occasionLabel?:string;floorLabel?:string;address?:string;hours?:string;passportPrice?:string;ownerSla?:string;budgetLabels?:{essential:string;signature:string;premium:string};knownOccasion?:string;now?:Date}
export interface ConversationResult {state:ConversationState;lang:ConversationLanguage;answers:ConversationAnswers;unrecognized:number;actions:ConversationAction[]}
export type Inbound={kind:"text"|"button"|"list"|"media";value:string};

const TENG_WORDS=["entha","eppudu","ekkada","pelli","kavali","cheppandi","undi","ledu"];
const HING_WORDS=["kitna","kab","kahan","chahiye","shaadi","bataiye","nahi"];
const hasWhole=(text:string,words:string[])=>words.some(word=>new RegExp("\\b"+word+"\\b","i").test(text));
export function detectLanguage(text:string,current:ConversationLanguage="en"):ConversationLanguage {
  if(/[\u0C00-\u0C7F]/.test(text))return "te";
  if(/[\u0900-\u097F]/.test(text))return "hi";
  if(hasWhole(text,TENG_WORDS))return "te-rom";
  if(hasWhole(text,HING_WORDS))return "hi-rom";
  return current;
}
const OCCASIONS=[
  ["wedding","Wedding"],["reception","Reception & Sangeet"],["prewed","Pre-Wedding"],["roka","Engagement / Roka"],
  ["maternity","Maternity"],["babyshower","Baby Shower"],["newborn","Newborn & Toddler"],["birthday","Birthday"],
  ["portrait","Studio Portrait"],["traditional","Half-Saree / Thread"],["brand","Brand & Product"],["passport","Passport / Visa"]
] as const;
export const extractOccasionFromText=(text:string):string|undefined=>{
  const value=text.toLowerCase();
  const matches:[string,string[]][]=[
    ["wedding",["wedding","marriage","pelli"]],["reception",["reception","sangeet"]],["prewed",["pre-wedding","pre wedding","prewed"]],
    ["roka",["roka","engagement"]],["maternity",["maternity"]],["babyshower",["baby shower","babyshower"]],
    ["newborn",["newborn","toddler","baby shoot"]],["birthday",["birthday"]],["traditional",["half-saree","half saree","thread ceremony","traditional"]],
    ["portrait",["portrait","studio portrait"]],["brand",["brand","product shoot"]],["passport",["passport","visa"]]
  ];
  for(const [slug,words] of matches)if(words.some(word=>new RegExp("\\b"+word+"\\b","i").test(value)))return slug;
  return undefined;
};
const askOccasion=(page:1|2):ConversationAction=>({type:"send_list",text:"What are you planning?",buttonLabel:"Choose",
  rows:page===1?[...OCCASIONS.slice(0,9).map(([id,title])=>({id:"occ:"+id,title})),{id:"occ:more",title:"More options"}]:
    [...OCCASIONS.slice(9).map(([id,title])=>({id:"occ:"+id,title})),{id:"occ:back",title:"Back"}]});
const askDate=():ConversationAction=>({type:"send_buttons",text:"When is the event? Type a date like 14 Dec, or tap a button.",buttons:[
  {id:"date:90",title:"Within 90 days"},{id:"date:later",title:"Later than that"},{id:"date:unsure",title:"Not decided"}]});
const askBudget=(labels:ConversationContext["budgetLabels"]):ConversationAction=>({type:"send_buttons",text:"Which package level suits you?",buttons:[
  {id:"bud:essential",title:(labels?.essential??"Essential").slice(0,20)},{id:"bud:signature",title:(labels?.signature??"Signature").slice(0,20)},{id:"bud:premium",title:(labels?.premium??"Premium").slice(0,20)}]});
const quoteText=(answers:ConversationAnswers,ctx:ConversationContext)=>{
  const parts=["Thanks "+(answers.name??"there")+"!"];
  if(ctx.floorLabel&&answers.occasion)parts.push(answers.occasion+" packages start at "+ctx.floorLabel+".");
  if(answers.dateText)parts.push("We noted "+answers.dateText+".");
  parts.push("Shall I ask our founder to confirm availability?");return parts.join(" ");
};
const handoffText=(ctx:ConversationContext)=>"Done! Our founder will message you here"+(ctx.ownerSla?" "+ctx.ownerSla:"")+". Anything else you would like to add?";
const expressText=(ctx:ConversationContext)=>{
  const parts=["For quick passport, visa or portrait photos just walk in:"];
  if(ctx.address)parts.push(ctx.address+".");if(ctx.hours)parts.push(ctx.hours+".");if(ctx.passportPrice)parts.push("Passport photos: "+ctx.passportPrice+".");
  return parts.join(" ");
};


export function initialGreeting(ctx:ConversationContext={}):ConversationAction {
  const studio=ctx.studioName?ctx.studioName+"'s":"the studio's";
  return {type:"send_buttons",text:"Hi! 👋 This is "+studio+" assistant. Thanks for your interest. I will ask 4 quick questions so our team can share exact dates and rates.",buttons:[
    {id:"start",title:"Start"},{id:"owner",title:"Talk to owner"}
  ]};
}

export function stepConversation(state:ConversationState,answers:ConversationAnswers,unrecognized:number,input:Inbound,currentLang:ConversationLanguage="en",ctx:ConversationContext={}):ConversationResult {
  let lang=currentLang;if(input.kind==="text")lang=detectLanguage(input.value,currentLang);
  const value=input.value.trim(),lower=value.toLowerCase();
  const next=(s:ConversationState,a:ConversationAnswers,u=0,actions:ConversationAction[]=[]):ConversationResult=>({state:s,lang,answers:a,unrecognized:u,actions});
  const handoff=(reason:string)=>next("OWNER_HANDOFF",answers,unrecognized,[{type:"alert_owner",reason},{type:"pause_bot_24h"},{type:"send_text",text:handoffText(ctx)}]);
  if(input.kind==="text"&&/\b(stop|unsubscribe|cancel)\b/i.test(lower))return next("DONE",answers,0,[{type:"set_opt_in",value:false,text:value},{type:"send_text",text:"Okay, we will not message you again. You can write to us any time."}]);
  if(input.kind==="media")return next("OWNER_HANDOFF",answers,0,[{type:"alert_owner",reason:"media"},{type:"pause_bot_24h"},{type:"send_text",text:handoffText(ctx)}]);
  if(input.kind==="text"&&/\b(owner|human|agent|call)\b/i.test(lower))return handoff("asked_human");
  if(state==="DONE"||state==="OWNER_HANDOFF")return next(state,answers,unrecognized,[]);
  if(unrecognized>=2)return handoff("confused");
  if(state==="ASK_SOURCE")return next("ASK_OCCASION",answers,0,[askOccasion(1)]);
  if(state==="GREETED") {
    if(ctx.knownOccasion)return next("ASK_DATE",{...answers,occasion:ctx.knownOccasion},0,[askDate()]);
    if(input.kind==="button"&&value==="owner")return handoff("asked_human");
    const direct=input.kind==="text"?extractOccasionFromText(value):undefined;
    if(direct&&["passport","portrait","brand"].includes(direct))return next("DONE",{...answers,occasion:direct},0,[{type:"send_text",text:expressText(ctx)},{type:"add_event",event:"express"}]);
    if(direct)return next("ASK_DATE",{...answers,occasion:direct},0,[askDate()]);
    return next("ASK_OCCASION",answers,0,[askOccasion(1)]);
  }
  if(state==="ASK_OCCASION") {
    if(value==="occ:more")return next(state,answers,0,[askOccasion(2)]);
    if(value==="occ:back")return next(state,answers,0,[askOccasion(1)]);
    const slug=input.kind==="button"||input.kind==="list"?value.replace(/^occ:/,""):extractOccasionFromText(value);
    if(!slug||!OCCASIONS.some(([id])=>id===slug))return unrecognized>=1?handoff("confused"):next(state,answers,1,[askOccasion(1)]);
    if(["passport","portrait","brand"].includes(slug))return next("DONE",{...answers,occasion:slug},0,[{type:"send_text",text:expressText(ctx)},{type:"add_event",event:"express"}]);
    return next("ASK_DATE",{...answers,occasion:slug},0,[askDate()]);
  }
  if(state==="ASK_DATE") {
    if(value==="date:90")return next("ASK_VENUE",{...answers,dateText:"Within 90 days"},0,[{type:"add_event",event:"event_within_90d"},{type:"send_text",text:"Which city or venue?"}]);
    if(value==="date:later")return next("ASK_VENUE",{...answers,dateText:"Later than 90 days"},0,[{type:"add_event",event:"event_later"},{type:"send_text",text:"Which city or venue?"}]);
    if(value==="date:unsure"||/^(unsure|not decided|not sure)$/i.test(value))return next("ASK_VENUE",{...answers,dateText:"Not decided"},0,[{type:"send_text",text:"Which city or venue?"}]);
    const date=parseEventDate(value,ctx.now??new Date());
    if(date){const within=(new Date(date+"T00:00:00Z").getTime()-(ctx.now??new Date()).getTime())<=90*86400000;return next("ASK_VENUE",{...answers,dateText:value,dateISO:date},0,[{type:"add_event",event:within?"event_within_90d":"event_later"},{type:"send_text",text:"Which city or venue?"}]);}
    if(unrecognized===0)return next(state,answers,1,[{type:"send_text",text:"Please type a date like 14 Dec, or tap Within 90 days, Later than that, or Not decided."}]);
    return next("ASK_VENUE",{...answers,dateText:value},0,[{type:"send_text",text:"Which city or venue?"}]);
  }
  if(state==="ASK_VENUE") {
    if(value.length>=2&&value.length<=120)return next("ASK_BUDGET",{...answers,venue:value},0,[{type:"add_event",event:"venue_given"},askBudget(ctx.budgetLabels)]);
    if(unrecognized===0)return next(state,answers,1,[{type:"send_text",text:"Which city or venue? Please enter at least 2 characters."}]);
    return next("ASK_BUDGET",{...answers,venue:""},0,[askBudget(ctx.budgetLabels)]);
  }
  if(state==="ASK_BUDGET") {
    const budget=value.replace(/^bud:/,"");
    if(input.kind==="button"&&["essential","signature","premium"].includes(budget)) {
      const event:LeadEvent=budget==="essential"?"budget_essential":"budget_upper";
      return next("ASK_NAME",{...answers,budget:budget as ConversationAnswers["budget"]},0,[{type:"add_event",event},{type:"send_text",text:"May I have your name?"}]);
    }
    return next("ASK_NAME",answers,0,[{type:"send_text",text:"May I have your name?"}]);
  }
  if(state==="ASK_NAME") {
    if((value.length<2||value.length>60)&&unrecognized===0)return next(state,answers,1,[{type:"send_text",text:"May I have your name?"}]);
    const name=value.length>=2&&value.length<=60?value:"there";
    return next("QUOTE_READY",{...answers,name},0,[{type:"send_buttons",text:quoteText({...answers,name},ctx),buttons:[
      {id:"q:confirm",title:"Yes, confirm"},{id:"q:samples",title:"More samples"},{id:"q:later",title:"Not now"}]}]);
  }
  if(state==="QUOTE_READY") {
    if(value==="q:samples")return next(state,answers,0,[{type:"send_samples",occasion:answers.occasion??"gallery"}]);
    if(value==="q:confirm")return next("ASK_OPT_IN",answers,0,[{type:"alert_owner",reason:"asked_availability"},{type:"send_text",text:"Can we send date reminders and offers here on WhatsApp? Reply YES or NO."}]);
    if(value==="q:later")return next("ASK_OPT_IN",answers,0,[{type:"send_text",text:"Can we send date reminders and offers here on WhatsApp? Reply YES or NO."}]);
    return handoff("customer_question");
  }
  if(state==="ASK_OPT_IN") {
    const yes=/^(yes|y|haan|ha|avunu)$/i.test(value),no=/^(no|n|nahi|na|ledu|kaadu)$/i.test(value);
    if(!yes&&!no)return next("OWNER_HANDOFF",answers,0,[{type:"alert_owner",reason:"consent_unclear"},{type:"pause_bot_24h"},{type:"send_text",text:handoffText(ctx)}]);
    return next("OWNER_HANDOFF",answers,0,[{type:"set_opt_in",value:yes,text:value},{type:"pause_bot_24h"},{type:"alert_owner",reason:"qualification_completed"},{type:"send_text",text:handoffText(ctx)}]);
  }
  return next("OWNER_HANDOFF",answers,unrecognized,[]);
}
export function shouldSendNudge(input:{now:number;lastInbound:number|null;optedOut:boolean;booked:boolean;lost:boolean;botPausedUntil:number|null;express:boolean;quietHours:boolean;requiresTemplate:boolean;templateApproved:boolean;marketingOptIn?:boolean}):boolean {
  if(!input.lastInbound||input.optedOut||input.booked||input.lost||input.express)return false;
  if(input.botPausedUntil&&input.botPausedUntil>input.now)return false;
  if(input.quietHours)return false;
  const age=input.now-input.lastInbound;
  if(input.requiresTemplate)return age>24*60*60*1000&&Boolean(input.marketingOptIn)&&input.templateApproved;
  return age<24*60*60*1000;
}
