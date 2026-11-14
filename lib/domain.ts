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

export function scoreLead(events: LeadEvent[]): { score:number; tier:"hot"|"warm"|"cold"; reasons:LeadEvent[] } {
  const unique = [...new Set(events)];
  const score = Math.max(0, Math.min(100, unique.reduce((sum, event) => sum + SCORE[event], 0)));
  return { score, tier: score >= 70 ? "hot" : score >= 40 ? "warm" : "cold", reasons: unique };
}

export function normalizeIndianPhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  const national = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(national)) return null;
  return "+91" + national;
}

export function buildWhatsAppLink(phone: string, message: string): string {
  const digits = phone.replace(/\D/g, "");
  return "https://wa.me/" + digits + (message ? "?text=" + encodeURIComponent(message) : "");
}

export type ConversationState =
  | "GREETED" | "ASK_OCCASION" | "ASK_DATE" | "ASK_VENUE" | "ASK_BUDGET"
  | "ASK_NAME" | "QUOTE_READY" | "ASK_OPT_IN" | "OWNER_HANDOFF" | "DONE";

export interface ConversationAnswers {
  occasion?: string;
  dateText?: string;
  venue?: string;
  budget?: "essential" | "signature" | "premium";
  name?: string;
}

export type ConversationAction =
  | { type:"send_text"; text:string }
  | { type:"send_buttons"; text:string; buttons:{id:string;title:string}[] }
  | { type:"alert_owner"; reason:string }
  | { type:"pause_bot_24h" }
  | { type:"set_opt_in"; value:boolean; text:string };

export interface ConversationResult {
  state:ConversationState;
  answers:ConversationAnswers;
  unrecognized:number;
  actions:ConversationAction[];
}

export function stepConversation(
  state:ConversationState,
  answers:ConversationAnswers,
  unrecognized:number,
  input:{kind:"text"|"button";value:string}
):ConversationResult {
  const text = input.value.trim();
  const lower = text.toLowerCase();
  const next = (s:ConversationState,a:ConversationAnswers,u=0,actions:ConversationAction[]=[]):ConversationResult => ({state:s,answers:a,unrecognized:u,actions});
  if (/\b(stop|unsubscribe)\b/i.test(lower)) {
    return next("DONE",answers,0,[{type:"set_opt_in",value:false,text:text},{type:"send_text",text:"You are opted out. We will not send further marketing messages."}]);
  }
  if (state === "GREETED") {
    return next("ASK_OCCASION",answers,0,[{type:"send_buttons",text:"Welcome. What are you planning?",buttons:[
      {id:"occ:wedding",title:"Wedding"},{id:"occ:pre-wedding",title:"Pre-wedding"},{id:"occ:portrait",title:"Portrait / Other"}
    ]}]);
  }
  if (state === "ASK_OCCASION") {
    const occasion = input.kind === "button" ? text.replace(/^occ:/,"") : text;
    if (occasion.length < 2 || occasion.length > 50) return next(state,answers,unrecognized+1,[{type:"send_text",text:"Please tell us the occasion you are planning."}]);
    return next("ASK_DATE",{...answers,occasion},0,[{type:"send_text",text:"What is your event date? You can type a date or say unsure."}]);
  }
  if (state === "ASK_DATE") {
    if (text.length < 2 || text.length > 80) return next(state,answers,unrecognized+1,[{type:"send_text",text:"Please share your event date or say unsure."}]);
    return next("ASK_VENUE",{...answers,dateText:text},0,[{type:"send_text",text:"Which venue or area is the event in?"}]);
  }
  if (state === "ASK_VENUE") {
    if (text.length < 2 || text.length > 120) return next(state,answers,unrecognized+1,[{type:"send_text",text:"Please share the venue or area."}]);
    return next("ASK_BUDGET",{...answers,venue:text},0,[{type:"send_buttons",text:"Which package range should we use as a starting point?",buttons:[
      {id:"bud:essential",title:"Essential"},{id:"bud:signature",title:"Signature"},{id:"bud:premium",title:"Premium"}
    ]}]);
  }
  if (state === "ASK_BUDGET") {
    const value = text.replace(/^bud:/,"") as ConversationAnswers["budget"];
    if (!["essential","signature","premium"].includes(value ?? "")) return next(state,answers,unrecognized+1,[{type:"send_text",text:"Please choose Essential, Signature or Premium."}]);
    return next("ASK_NAME",{...answers,budget:value},0,[{type:"send_text",text:"What name should we use for your enquiry?"}]);
  }
  if (state === "ASK_NAME") {
    if (text.length < 2 || text.length > 60) return next(state,answers,unrecognized+1,[{type:"send_text",text:"Please share your name."}]);
    return next("QUOTE_READY",{...answers,name:text},0,[{type:"send_buttons",text:"Thanks. Would you like the studio owner to review your enquiry?",buttons:[
      {id:"q:confirm",title:"Yes, please"},{id:"q:later",title:"Later"}
    ]}]);
  }
  if (state === "QUOTE_READY") {
    if (text === "q:confirm" || lower === "yes" || lower === "yes please") {
      return next("ASK_OPT_IN",answers,0,[{type:"alert_owner",reason:"Customer requested owner follow-up."},{type:"send_text",text:"May we send occasional updates about this enquiry? Reply YES or NO."}]);
    }
    if (text === "q:later" || lower === "later") return next("ASK_OPT_IN",answers,0,[{type:"send_text",text:"No problem. May we send occasional updates about this enquiry? Reply YES or NO."}]);
    return next("OWNER_HANDOFF",answers,0,[{type:"pause_bot_24h"},{type:"alert_owner",reason:"Customer asked a question or needs a human."}]);
  }
  if (state === "ASK_OPT_IN") {
    const yes = /^(yes|y)$/i.test(text);
    const no = /^(no|n)$/i.test(text);
    if (!yes && !no) return next("OWNER_HANDOFF",answers,0,[{type:"pause_bot_24h"},{type:"alert_owner",reason:"Consent response unclear; human follow-up required."}]);
    return next("OWNER_HANDOFF",answers,0,[{type:"set_opt_in",value:yes,text:text},{type:"pause_bot_24h"},{type:"alert_owner",reason:"Enquiry qualification completed."}]);
  }
  return next("OWNER_HANDOFF",answers,unrecognized,[{type:"pause_bot_24h"}]);
}

export function shouldSendNudge(input:{
  now:number; lastInbound:number|null; optedOut:boolean; booked:boolean; lost:boolean;
  botPausedUntil:number|null; express:boolean; quietHours:boolean; requiresTemplate:boolean;
  templateApproved:boolean;
}): boolean {
  if (!input.lastInbound || input.optedOut || input.booked || input.lost || input.express) return false;
  if (input.botPausedUntil && input.botPausedUntil > input.now) return false;
  if (input.quietHours || input.now - input.lastInbound > 24*60*60*1000) return false;
  if (input.requiresTemplate && !input.templateApproved) return false;
  return true;
}
