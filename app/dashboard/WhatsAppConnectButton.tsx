"use client";
import {useEffect,useRef,useState} from "react";

type SignupData={wabaId:string;phoneNumberId:string};
type FacebookLoginResponse={authResponse?:{code?:string};status?:string};
declare global {
  interface Window {
    fbAsyncInit?:()=>void;
    FB?:{init:(options:Record<string,unknown>)=>void;login:(callback:(response:FacebookLoginResponse)=>void,options:Record<string,unknown>)=>void};
  }
}
export default function WhatsAppConnectButton(){
  const [ready,setReady]=useState(false),[code,setCode]=useState(""),[signup,setSignup]=useState<SignupData|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const started=useRef(false);
  const appId=process.env.NEXT_PUBLIC_META_APP_ID??"";
  const configId=process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID??"";
  useEffect(()=>{
    if(!appId||!configId)return;
    const scriptId="facebook-jssdk";
    const existing=document.getElementById(scriptId);
    const initialize=()=>{if(!window.FB)return;window.FB.init({appId,cookie:true,xfbml:false,version:process.env.NEXT_PUBLIC_META_GRAPH_API_VERSION??"v27.0"});setReady(true);};
    window.fbAsyncInit=initialize;
    if(!existing){const script=document.createElement("script");script.id=scriptId;script.src="https://connect.facebook.net/en_US/sdk.js";script.async=true;script.defer=true;script.crossOrigin="anonymous";document.body.appendChild(script);}
    else if(window.FB)initialize();
    const onMessage=(event:MessageEvent)=>{
      if(event.origin!=="https://www.facebook.com"&&event.origin!=="https://web.facebook.com")return;
      let payload:Record<string,unknown>;
      try{payload=typeof event.data==="string"?JSON.parse(event.data):event.data as Record<string,unknown>;}catch{return;}
      if(payload.type!=="WA_EMBEDDED_SIGNUP"&&payload.event!=="FINISH")return;
      const data=(payload.data??{}) as Record<string,unknown>;
      if(payload.event==="FINISH"&&data.waba_id&&data.phone_number_id)setSignup({wabaId:String(data.waba_id),phoneNumberId:String(data.phone_number_id)});
      if(payload.event==="CANCEL")setMessage("WhatsApp setup was cancelled.");
      if(payload.event==="ERROR")setMessage("Meta could not complete WhatsApp setup.");
    };
    window.addEventListener("message",onMessage);
    return()=>window.removeEventListener("message",onMessage);
  },[appId,configId]);
  useEffect(()=>{
    if(!code||!signup||busy||started.current)return;
    started.current=true;setBusy(true);setMessage("Securing WhatsApp connection…");
    fetch("/api/integrations/whatsapp/exchange",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,wabaId:signup.wabaId,phoneNumberId:signup.phoneNumberId})})
      .then(async response=>{if(!response.ok)throw new Error("WhatsApp connection could not be saved.");return response.json();})
      .then(()=>{setMessage("WhatsApp Business connected.");window.location.reload();})
      .catch(error=>{started.current=false;setMessage(error instanceof Error?error.message:"Connection failed.");})
      .finally(()=>setBusy(false));
  },[code,signup,busy]);
  function connect(){
    if(!window.FB||!ready)return;
    setMessage("Complete the Meta business setup window.");
    window.FB.login(response=>{const value=response.authResponse?.code;if(value)setCode(value);else setMessage("Meta authorization was not completed.");},{
      config_id:configId,response_type:"code",override_default_response_type:true,extras:{setup:{}}
    });
  }
  return <div>
    <button type="button" disabled={!ready||busy} onClick={connect}>{busy?"Connecting…":ready?"Connect WhatsApp Business":"WhatsApp setup unavailable"}</button>
    {message&&<small role="status">{message}</small>}
  </div>;
}
