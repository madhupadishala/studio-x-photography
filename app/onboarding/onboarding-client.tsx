"use client";
import {useState} from "react";
import styles from "./onboarding.module.css";

const steps=["Studio and theme","Services and starting prices","Coupon rules","Photos and brochure","Social accounts"];
const initial:Record<string,string>={studio_name:"Studio X Photography",city:"Hyderabad",theme_preset:"royal_ivory",validHours:"48",expressPct:"20",standardPct:"10",expressCode:"FIRST20",standardCode:"WELCOME10"};
async function compress(file:File,maxW:number,maxH:number,quality:number,type:"image/webp"|"image/jpeg"):Promise<Blob>{
  const bitmap=await createImageBitmap(file);
  const scale=Math.min(1,maxW/bitmap.width,maxH/bitmap.height);
  const canvas=document.createElement("canvas");canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
  const ctx=canvas.getContext("2d");if(!ctx)throw new Error("Image processing unavailable");
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("Image encoding failed")),type,quality));
}
export default function OnboardingClient(){
  const [step,setStep]=useState(0),[data,setData]=useState<Record<string,string>>(initial),[saved,setSaved]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[progress,setProgress]=useState(0),[brochureUrl,setBrochureUrl]=useState("");
  const set=(key:string,value:string)=>setData(old=>({...old,[key]:value}));
  async function uploadFile(file:File,kind:"gallery"|"brochure",contentType:string):Promise<string>{
    const response=await fetch("/api/publish/presign",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind,contentType})});
    if(!response.ok)throw new Error("Storage is not configured");
    const signed=await response.json();
    const put=await fetch(signed.uploadUrl,{method:"PUT",headers:{"Content-Type":contentType},body:file});
    if(!put.ok)throw new Error("Upload failed. Check the storage CORS configuration.");
    return signed.publicUrl as string;
  }
  async function uploadPhotos(files:FileList|null){
    if(!files?.length)return;setBusy(true);setNotice("");setProgress(0);
    try{
      for(let i=0;i<files.length;i++){
        const file=files[i];let type:"image/webp"|"image/jpeg"="image/webp";let full:Blob|null=null;let thumb:Blob|null=null;
        for(const q of [0.8,0.7,0.6,0.5]){
          try{full=await compress(file,1600,1600,q,type);thumb=await compress(file,480,600,Math.min(q,0.75),type);}catch{type="image/jpeg";full=await compress(file,1600,1600,q,type);thumb=await compress(file,480,600,Math.min(q,0.75),type);}
          if(full.size<=350*1024&&thumb.size<=90*1024)break;
        }
        if(!full||!thumb||full.size>350*1024||thumb.size>90*1024)throw new Error(file.name+" is too large after optimization.");
        const fullFile=new File([full],file.name.replace(/\.[^.]+$/,"")+"."+(type==="image/webp"?"webp":"jpg"),{type});
        const thumbFile=new File([thumb],"thumb-"+fullFile.name,{type});
        const imageUrl=await uploadFile(fullFile,"gallery",type);
        const thumbUrl=await uploadFile(thumbFile,"gallery",type);
        const saved=await fetch("/api/gallery",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind:"gallery",occasion:"portfolio",imageUrl,thumbUrl,alt:file.name.replace(/\.[^.]+$/,"")})});
        if(!saved.ok)throw new Error("The photo uploaded but could not be added to the gallery.");
        setProgress(Math.round(((i+1)/files.length)*100));
      }
      setNotice("Photos uploaded and added to the studio gallery.");
    }catch(error){setNotice(error instanceof Error?error.message:"Upload failed.");}
    finally{setBusy(false);}
  }
  async function uploadBrochure(file?:File){
    if(!file)return;if(file.type!=="application/pdf"||file.size>5*1024*1024){setNotice("Choose a PDF under 5 MB.");return;}
    setBusy(true);setNotice("");
    try{const url=await uploadFile(file,"brochure","application/pdf");setBrochureUrl(url);setNotice("Brochure uploaded.");}
    catch(error){setNotice(error instanceof Error?error.message:"Brochure upload failed.");}
    finally{setBusy(false);}
  }
  async function save(next:number){
    setBusy(true);setNotice("");
    let payload:Record<string,unknown>={};
    if(step===0)payload=Object.fromEntries(["studio_name","owner_name","tagline","city","address","landmark","maps_url","review_url","working_hours","whatsapp_number","owner_alert_number","theme_preset"].map(k=>[k,data[k]??""]));
    if(step===1)payload={
      pricing:{passport:data.passport??"",homeVisit:data.homeVisit??"",wedding:data.wedding??""},
      price_book:{base:{passport:Number(data.passport)||0,homeVisit:Number(data.homeVisit)||0,wedding:Number(data.wedding)||0},extras:{}},
      budget_bands:{essential:"Essential",signature:"Signature",premium:"Premium"},
      service_area:data.service_area??"",owner_reply_sla:data.owner_reply_sla??"",delivery_sla:data.delivery_sla??""
    };
    if(step===2)payload={coupon_rules:{enabled:data.couponsEnabled==="true",expressCode:data.expressCode??"",expressPct:Number(data.expressPct),standardCode:data.standardCode??"",standardPct:Number(data.standardPct),validHours:Number(data.validHours)}};
    if(step===3&&brochureUrl)payload={brochure_pdf_url:brochureUrl};
    try{
      const response=await fetch("/api/onboarding/step",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({step:step+1,data:payload})});
      if(!response.ok){const result=await response.json().catch(()=>({}));throw new Error(result.error==="unauthorized"?"Please sign in again.":"Unable to save this onboarding step. Check the database connection.");}
      setSaved(true);setStep(next);
      if(next===5)window.location.assign("/dashboard");
    }catch(error){setNotice(error instanceof Error?error.message:"Unable to save.");}
    finally{setBusy(false);}
  }
  const field=(key:string,label:string,placeholder="",type="text")=><label key={key}>{label.toUpperCase()}<input type={type} value={data[key]??""} onChange={e=>set(key,e.target.value)} placeholder={placeholder}/></label>;
  return <main className={styles.page}>
    <header><a href="/" className={styles.brand}>STUDIO X <small>SETUP</small></a><a href="/dashboard">Exit setup ↗</a></header>
    <div className={styles.progress}><i style={{width:((step+1)/5*100)+"%"}}/></div>
    <section className={styles.wrap}><small>STEP {step+1} OF 5</small><h1>{steps[step]}</h1><p>Configure the studio workspace. Changes are saved to the studio database.</p>
      <div className={styles.card}>
        {step===0&&<>{field("studio_name","Studio name","Your studio name")}{field("owner_name","Owner name")}{field("tagline","Tagline")}{field("city","City")}{field("address","Address")}{field("landmark","Landmark")}{field("maps_url","Google Maps URL","https://maps.google.com/...")}{field("review_url","Google review URL","https://g.page/r/...")}{field("working_hours","Working hours")}{field("whatsapp_number","WhatsApp number","+919876543210")}{field("owner_alert_number","Owner alert number","+919876543210")}{field("theme_preset","Theme preset","royal_ivory")}</>}
        {step===1&&<>{field("passport","Passport photos starting price (₹)","")}{field("homeVisit","Home visit starting price (₹)","")}{field("wedding","Wedding coverage starting price (₹)","")}{field("service_area","Service area")}{field("owner_reply_sla","Owner reply promise")}{field("delivery_sla","Delivery timeline")}</>}
        {step===2&&<>{field("expressCode","Express coupon code","")}{field("expressPct","Express discount (%)","20","number")}{field("standardCode","Standard coupon code","")}{field("standardPct","Standard discount (%)","10","number")}{field("validHours","Validity (hours)","48","number")}<label>ENABLE COUPONS<select value={data.couponsEnabled??"false"} onChange={e=>set("couponsEnabled",e.target.value)}><option value="false">Disabled</option><option value="true">Enabled</option></select></label></>}
        {step===3&&<><div className={styles.upload}>＋<b>Upload studio photos</b><span>Images are resized in the browser before direct signed upload.</span><input type="file" accept="image/*" multiple disabled={busy} onChange={e=>void uploadPhotos(e.target.files)}/>{progress>0&&<span>{progress}% uploaded</span>}</div><div className={styles.upload}>＋<b>Upload brochure PDF</b><span>PDF only · Under 5 MB</span><input type="file" accept="application/pdf" disabled={busy} onChange={e=>void uploadBrochure(e.target.files?.[0])}/>{brochureUrl&&<span>Brochure saved</span>}</div></>}
        {step===4&&<div className={styles.coming}><b>Social account authorization</b><p>Public profile links are not authorization. Connect Instagram, Facebook and YouTube only through their official OAuth permissions after the platform app review. No account passwords are collected here.</p></div>}
      </div>
      {notice&&<p role="status">{notice}</p>}
      <footer><button className={styles.back} disabled={step===0||busy} onClick={()=>setStep(s=>Math.max(0,s-1))}>Back</button><span>{saved?"Saved to workspace":""}</span><button className={styles.next} disabled={busy} onClick={()=>void save(Math.min(4,step+1))}>{busy?"Saving…":step===4?"Finish setup":"Save & continue"}</button></footer>
    </section>
  </main>;
}
