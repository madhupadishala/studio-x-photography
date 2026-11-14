import {describe,expect,it} from "vitest";
import {
  buildWhatsAppLink,detectLanguage,normalizeIndianPhone,parseEventDate,scoreLead,
  shouldSendNudge,stepConversation,type ConversationAnswers,type ConversationContext,type ConversationState
} from "../lib/domain";

describe("documented lead scoring cases",()=>{
  it("A: caps a 105-point high intent lead at 100",()=>expect(scoreLead(["phone_valid","occasion_high_value","event_within_90d","venue_given","budget_upper","fast_reply"])).toBe(100));
  it("B: event later and venue scores 40 warm",()=>expect(scoreLead(["phone_valid","event_later","venue_given"])).toBe(40));
  it("C: wedding later, fast reply, price intent scores 70",()=>expect(scoreLead(["phone_valid","occasion_high_value","event_later","fast_reply","asked_price"])).toBe(70));
  it("D: just checking offsets a valid phone to zero",()=>expect(scoreLead(["phone_valid","just_checking"])).toBe(0));
  it("E: essential budget scores 45",()=>expect(scoreLead(["phone_valid","occasion_high_value","budget_essential"])).toBe(45));
  it("F: silence subtracts ten from case A",()=>expect(scoreLead(["phone_valid","occasion_high_value","event_within_90d","venue_given","budget_upper","fast_reply","silent_48h"])).toBe(95));
  it("G: out-of-area offsets the event score to 40",()=>expect(scoreLead(["phone_valid","occasion_high_value","event_within_90d","out_of_area"])).toBe(40));
  it("counts each event only once and clamps below zero",()=>{expect(scoreLead(["phone_valid","phone_valid"])).toBe(20);expect(scoreLead(["just_checking","out_of_area"])).toBe(0);});
});

describe("phone and WhatsApp links",()=>{
  it("normalizes Indian mobile numbers",()=>{expect(normalizeIndianPhone("+91 98765 43210")).toBe("+919876543210");expect(normalizeIndianPhone("9876543210")).toBe("+919876543210");expect(normalizeIndianPhone("1234567890")).toBeNull();});
  it("URL-encodes the WhatsApp message",()=>expect(buildWhatsAppLink("+91 98765 43210","Hi there")).toBe("https://wa.me/919876543210?text=Hi%20there"));
});

describe("date parsing accepts only the specified formats",()=>{
  const now=new Date("2026-11-14T00:00:00.000Z");
  it.each([
    ["14 Dec 2027","2027-12-14"],["14 December 2027","2027-12-14"],["Dec 14 2027","2027-12-14"],
    ["14/12/2027","2027-12-14"],["14-12-2027","2027-12-14"],["14 Dec","2026-12-14"],
    ["14 December","2026-12-14"],["Dec 14","2026-12-14"],["14/12","2026-12-14"],["14-12","2026-12-14"],
    ["1 Jan 2027","2027-01-01"],["31 Dec 2026","2026-12-31"],["29 Feb 2028","2028-02-29"]
  ])("parses %s", (input,expected)=>expect(parseEventDate(input,now)).toBe(expected));
  it.each(["31 Feb 2027","32 Dec","14/13","2027-12-14","next Friday","14/12/2020","29 Feb 2027"])("rejects %s",input=>expect(parseEventDate(input,now)).toBeNull());
});

describe("language detection",()=>{
  it("follows the specified script and whole-word order",()=>{
    expect(detectLanguage("తెలుగు")).toBe("te");
    expect(detectLanguage("नमस्ते")).toBe("hi");
    expect(detectLanguage("wedding ki rate kitna")).toBe("hi-rom");
    expect(detectLanguage("pelli eppudu")).toBe("te-rom");
    expect(detectLanguage("hello","te-rom")).toBe("te-rom");
  });
});

describe("conversation state machine",()=>{
  const run=(state:ConversationState,answers:ConversationAnswers,miss:number,kind:"text"|"button"|"list"|"media",value:string,ctx:ConversationContext={})=>stepConversation(state,answers,miss,{kind,value},"en",ctx);
  it("0: YouTube channel source selection advances to occasion qualification",()=>{const r=run("ASK_SOURCE",{},0,"list","src:youtube_short");expect(r.state).toBe("ASK_OCCASION");expect(r.actions.some(a=>a.type==="send_list")).toBe(true);});
  it("1: completes qualification and captures YES consent",()=>{
    let r=run("GREETED",{},0,"text","start");
    r=run(r.state,r.answers,r.unrecognized,"button","occ:wedding");
    r=run(r.state,r.answers,r.unrecognized,"text","14 Dec 2027");
    r=run(r.state,r.answers,r.unrecognized,"text","Hyderabad");
    r=run(r.state,r.answers,r.unrecognized,"button","bud:signature");
    r=run(r.state,r.answers,r.unrecognized,"text","Ravi");
    r=run(r.state,r.answers,r.unrecognized,"button","q:confirm");
    r=run(r.state,r.answers,r.unrecognized,"text","YES");
    expect(r.state).toBe("OWNER_HANDOFF");
    expect(r.actions.some(a=>a.type==="set_opt_in"&&a.value)).toBe(true);
    expect(r.actions.some(a=>a.type==="alert_owner")).toBe(true);
  });
  it("2: a known referral occasion skips the occasion question",()=>expect(run("GREETED",{},0,"button","start",{knownOccasion:"wedding"}).state).toBe("ASK_DATE"));
  it("3: owner request pauses the bot",()=>{const r=run("ASK_DATE",{},0,"text","Please call the owner");expect(r.state).toBe("OWNER_HANDOFF");expect(r.actions.some(a=>a.type==="pause_bot_24h")).toBe(true);});
  it("4: media is handed to a person",()=>{const r=run("ASK_DATE",{},0,"media","");expect(r.state).toBe("OWNER_HANDOFF");expect(r.actions.some(a=>a.type==="alert_owner")).toBe(true);});
  it("5: two invalid dates preserve the raw text and continue",()=>{let r=run("ASK_DATE",{},0,"text","banana");expect(r.state).toBe("ASK_DATE");r=run(r.state,r.answers,r.unrecognized,"text","banana");expect(r.state).toBe("ASK_VENUE");expect(r.answers.dateText).toBe("banana");});
  it("6: STOP ends the conversation and opts out",()=>{const r=run("ASK_DATE",{},0,"text","STOP");expect(r.state).toBe("DONE");expect(r.actions.some(a=>a.type==="set_opt_in"&&!a.value)).toBe(true);});
  it("7: passport is an express path with no nurture",()=>{const r=run("ASK_OCCASION",{},0,"list","occ:passport");expect(r.state).toBe("DONE");expect(r.actions.some(a=>a.type==="add_event"&&a.event==="express")).toBe(true);});
  it("8: More and Back paginate the occasion list",()=>{const a=run("ASK_OCCASION",{},0,"list","occ:more");const b=run("ASK_OCCASION",{},0,"list","occ:back");expect(a.actions[0].type).toBe("send_list");expect(b.actions[0].type).toBe("send_list");});
  it("9: samples leave the user in QUOTE_READY",()=>{const r=run("QUOTE_READY",{occasion:"wedding"},0,"button","q:samples");expect(r.state).toBe("QUOTE_READY");expect(r.actions[0].type).toBe("send_samples");});
  it("10: NO is recorded as no marketing opt-in",()=>{const r=run("ASK_OPT_IN",{},0,"text","NO");expect(r.state).toBe("OWNER_HANDOFF");expect(r.actions.some(a=>a.type==="set_opt_in"&&!a.value)).toBe(true);});
  it("11: typed budget is one miss and proceeds with no budget",()=>{const r=run("ASK_BUDGET",{},0,"text","hello");expect(r.state).toBe("ASK_NAME");expect(r.answers.budget).toBeUndefined();});
  it("12: Telugu script is detected but copy remains English",()=>{const r=run("GREETED",{},0,"text","నమస్కారం");expect(r.lang).toBe("te");expect(r.state).toBe("ASK_OCCASION");});
  it("13: Hinglish occasion and price intent shortcut to date",()=>{const r=run("GREETED",{},0,"text","wedding ki rate kitna");expect(r.lang).toBe("hi-rom");expect(r.state).toBe("ASK_DATE");expect(r.answers.occasion).toBe("wedding");});
  it("14: two unmatched occasion messages hand off",()=>{let r=run("ASK_OCCASION",{},0,"text","banana");r=run(r.state,r.answers,r.unrecognized,"text","banana");expect(r.state).toBe("OWNER_HANDOFF");});
  it("15: quote never invents a starting price",()=>{let r=run("GREETED",{},0,"text","birthday");r=run(r.state,r.answers,0,"text","14 Dec");r=run(r.state,r.answers,0,"text","Hyderabad");r=run(r.state,r.answers,0,"button","bud:essential");r=run(r.state,r.answers,0,"text","Ravi");expect(r.state).toBe("QUOTE_READY");const action=r.actions.find(a=>a.type==="send_buttons");expect(action?.type==="send_buttons"&&action.text.includes("packages start at")).toBe(false);});
});

describe("nudge policy",()=>{
  const now=Date.UTC(2026,10,14,12);
  const base={now,lastInbound:now-3*3600000,optedOut:false,booked:false,lost:false,botPausedUntil:null,express:false,quietHours:false,requiresTemplate:false,templateApproved:false};
  it("allows a recent in-window free-form follow-up",()=>expect(shouldSendNudge(base)).toBe(true));
  it("refuses after the 24-hour window",()=>expect(shouldSendNudge({...base,lastInbound:now-25*3600000})).toBe(false));
  it("requires marketing opt-in and an approved template after the window",()=>expect(shouldSendNudge({...base,lastInbound:now-25*3600000,requiresTemplate:true,templateApproved:true,marketingOptIn:false})).toBe(false));
  it("refuses during quiet hours",()=>expect(shouldSendNudge({...base,quietHours:true})).toBe(false));
  it("refuses after an opt-out",()=>expect(shouldSendNudge({...base,optedOut:true})).toBe(false));
  it("refuses booked, lost, express and paused leads",()=>{expect(shouldSendNudge({...base,booked:true})).toBe(false);expect(shouldSendNudge({...base,lost:true})).toBe(false);expect(shouldSendNudge({...base,express:true})).toBe(false);expect(shouldSendNudge({...base,botPausedUntil:now+1000})).toBe(false);});
});
