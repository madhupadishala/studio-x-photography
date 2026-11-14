import { describe, expect, it } from "vitest";
import { buildWhatsAppLink, normalizeIndianPhone, scoreLead, shouldSendNudge, stepConversation } from "../lib/domain";

describe("lead qualification",()=>{
  it("scores and caps a high-intent lead",()=>{
    const result=scoreLead(["phone_valid","occasion_high_value","event_within_90d","venue_given","budget_upper","fast_reply"]);
    expect(result.score).toBe(100);
    expect(result.tier).toBe("hot");
  });
  it("deduplicates event points and floors negative scores",()=>{
    expect(scoreLead(["phone_valid","phone_valid"]).score).toBe(20);
    expect(scoreLead(["just_checking","out_of_area"]).score).toBe(0);
  });
});

describe("contact and WhatsApp utilities",()=>{
  it("normalizes Indian mobile numbers only",()=>{
    expect(normalizeIndianPhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizeIndianPhone("9876543210")).toBe("+919876543210");
    expect(normalizeIndianPhone("1234567890")).toBeNull();
  });
  it("encodes a prefilled WhatsApp message",()=>{
    expect(buildWhatsAppLink("+91 98765 43210","Hello there")).toBe("https://wa.me/919876543210?text=Hello%20there");
  });
});

describe("conversation state machine",()=>{
  it("qualifies a lead in deterministic steps",()=>{
    let r=stepConversation("GREETED",{},0,{kind:"text",value:"Hi"});
    expect(r.state).toBe("ASK_OCCASION");
    r=stepConversation(r.state,r.answers,r.unrecognized,{kind:"button",value:"occ:wedding"});
    expect(r.state).toBe("ASK_DATE");
    r=stepConversation(r.state,r.answers,r.unrecognized,{kind:"text",value:"20 December"});
    expect(r.state).toBe("ASK_VENUE");
  });
  it("honours STOP immediately",()=>{
    const r=stepConversation("ASK_DATE",{occasion:"wedding"},0,{kind:"text",value:"STOP"});
    expect(r.state).toBe("DONE");
    expect(r.actions.some(a=>a.type==="set_opt_in" && !a.value)).toBe(true);
  });
});

describe("follow-up policy",()=>{
  const now=Date.UTC(2026,10,14,12);
  it("allows only an eligible recent conversation",()=>{
    expect(shouldSendNudge({now,lastInbound:now-3*3600000,optedOut:false,booked:false,lost:false,botPausedUntil:null,express:false,quietHours:false,requiresTemplate:false,templateApproved:false})).toBe(true);
  });
  it("blocks opted-out, stale, paused and unapproved template sends",()=>{
    const base={now,lastInbound:now-3*3600000,optedOut:false,booked:false,lost:false,botPausedUntil:null,express:false,quietHours:false,requiresTemplate:false,templateApproved:false};
    expect(shouldSendNudge({...base,optedOut:true})).toBe(false);
    expect(shouldSendNudge({...base,lastInbound:now-25*3600000})).toBe(false);
    expect(shouldSendNudge({...base,botPausedUntil:now+3600000})).toBe(false);
    expect(shouldSendNudge({...base,requiresTemplate:true,templateApproved:false})).toBe(false);
  });
});
