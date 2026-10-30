'use client';
import {useEffect,useState,type FormEvent} from 'react';
const KEY='studio-x-visitor-popup-v1';
export function VisitorCapture(){
 const [open,setOpen]=useState(false),[name,setName]=useState(''),[mobile,setMobile]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  try{if(sessionStorage.getItem(KEY))return;}catch{}
  const timer=window.setTimeout(()=>setOpen(true),4000);
  return()=>window.clearTimeout(timer);
 },[]);
 function dismiss(){setOpen(false);try{sessionStorage.setItem(KEY,'dismissed')}catch{}}
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setError('');
  const cleaned=mobile.replace(/\D/g,'');
  if(name.trim().length<2||!(/^[6-9]\d{9}$/.test(cleaned)||/^91[6-9]\d{9}$/.test(cleaned))){setError('Enter your name and a valid Indian mobile number.');return}
  setBusy(true);
  try{
   const response=await fetch('/api/public/visitor-contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.trim(),mobile:cleaned})});
   if(!response.ok)throw new Error('Unable to save');
   dismiss();
  }catch{setError('Could not save right now. You can skip this and continue browsing.')}
  finally{setBusy(false)}
 }
 if(!open)return null;
 return <aside className="visitor-capture" role="dialog" aria-modal="false" aria-label="Stay in touch with Studio X">
  <button type="button" className="visitor-capture-close" onClick={dismiss} aria-label="Dismiss popup">×</button>
  <div className="visitor-capture-copy"><strong>Hey, welcome to Studio X! ✨</strong><span>Leave your number — we&apos;d love to hear your story.</span></div>
  <form onSubmit={submit} className="visitor-capture-form">
   <input aria-label="Your name" placeholder="Your name" autoComplete="name" value={name} onChange={e=>setName(e.target.value)} maxLength={80} required/>
   <input aria-label="Mobile number" placeholder="Mobile number" type="tel" inputMode="tel" autoComplete="tel" value={mobile} onChange={e=>setMobile(e.target.value)} maxLength={15} required/>
   <button type="submit" disabled={busy}>{busy?'Saving…':'Stay in touch ↗'}</button>
  </form>
  <div className="visitor-capture-bottom"><span>By submitting, you agree to be contacted about your enquiry. <a href="/privacy">Privacy</a></span><button type="button" onClick={dismiss}>Maybe later</button></div>
  {error&&<p role="alert" className="visitor-capture-error">{error}</p>}
 </aside>
}