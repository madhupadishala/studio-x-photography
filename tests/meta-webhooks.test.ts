import {describe,expect,it} from "vitest";
import {createHmac} from "node:crypto";
import {normalizeInstagramWebhook,normalizeWhatsAppWebhook,verifyMetaSignature} from "../lib/integrations/meta";

describe("Meta webhook verification",()=>{
  it("validates exact raw-body HMAC signatures",()=>{
    const body='{"object":"whatsapp_business_account"}';
    const signature="sha256="+createHmac("sha256","fixture-secret").update(body).digest("hex");
    expect(verifyMetaSignature(body,signature,"fixture-secret")).toBe(true);
    expect(verifyMetaSignature(body,signature,"wrong-secret")).toBe(false);
    expect(verifyMetaSignature(body,null,"fixture-secret")).toBe(false);
  });
  it("normalizes WhatsApp message events without assuming a phone lead from an engagement",()=>{
    const events=normalizeWhatsAppWebhook({entry:[{changes:[{value:{metadata:{phone_number_id:"123"},contacts:[{profile:{name:"Test Person"}}],messages:[{id:"wamid.1",from:"919876543210",timestamp:"1794660000",type:"text",text:{body:"Wedding rates?"}}]}}]}]});
    expect(events).toHaveLength(1);expect(events[0].providerEventId).toBe("wamid.1");expect(events[0].externalActorId).toBe("919876543210");
  });
  it("extracts WhatsApp interactive list reply IDs for deterministic bot routing",()=>{
    const events=normalizeWhatsAppWebhook({entry:[{changes:[{value:{metadata:{phone_number_id:"123"},messages:[{id:"wamid.list",from:"919876543210",timestamp:"1794660000",type:"interactive",interactive:{type:"list_reply",list_reply:{id:"src:youtube_short",title:"YouTube Short"}}}]}}]}]});
    expect(events[0].text).toBe("src:youtube_short");expect(events[0].metadata.interactiveKind).toBe("list");
  });
  it("normalizes Instagram comments as account-scoped engagement, not a phone lead",()=>{
    const events=normalizeInstagramWebhook({entry:[{id:"ig-account-1",changes:[{field:"comments",value:{id:"comment-1",text:"WEDDING",from:{id:"user-1",username:"guest"},media:{id:"media-1"}}}]}]});
    expect(events[0].eventType).toBe("comment.created");expect(events[0].externalActorId).toBe("user-1");expect(events[0].metadata.mediaId).toBe("media-1");
  });
});
