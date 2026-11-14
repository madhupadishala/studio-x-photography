"use client";
import {useState} from "react";
import styles from "./login.module.css";

export default function Login(){
  const [slug,setSlug]=useState("studio-x");
  const [phone,setPhone]=useState("");
  const [code,setCode]=useState("");
  const [sent,setSent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  async function requestCode(e:React.FormEvent){
    e.preventDefault();setBusy(true);setMessage("");
    try{
      const response=await fetch("/api/auth/request-otp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tenantSlug:slug,phone})});
      if(!response.ok){const data=await response.json().catch(()=>({}));setMessage(data.error==="delivery_unavailable"?"OTP delivery is not configured yet.":data.error==="too_many_requests"?"Too many attempts. Try again later.":"Unable to request a code.");}
      else{setSent(true);setMessage("If the studio and owner number match, a verification code has been sent.");}
    }catch{setMessage("Authentication service is temporarily unavailable.");}
    finally{setBusy(false);}
  }
  async function verify(e:React.FormEvent){
    e.preventDefault();setBusy(true);setMessage("");
    try{
      const response=await fetch("/api/auth/verify-otp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tenantSlug:slug,phone,code})});
      if(response.ok){window.location.assign("/dashboard");return;}
      const data=await response.json().catch(()=>({}));
      setMessage(data.error==="locked"?"This code is locked. Request a new code.":"The code is invalid or expired.");
    }catch{setMessage("Authentication service is temporarily unavailable.");}
    finally{setBusy(false);}
  }
  return <main className={styles.page}>
    <a href="/" className={styles.brand}>STUDIO X <span>OWNER ACCESS</span></a>
    <section className={styles.box}>
      <small>PRIVATE WORKSPACE</small><h1>Welcome back.</h1>
      <p>Sign in to manage studio enquiries and growth.</p>
      {!sent?<form onSubmit={requestCode}>
        <label>STUDIO WORKSPACE SLUG<input required value={slug} onChange={e=>setSlug(e.target.value.trim().toLowerCase())} placeholder="your-studio"/></label>
        <label>OWNER MOBILE NUMBER<input required inputMode="tel" minLength={10} value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+91 98765 43210"/></label>
        <button disabled={busy}>{busy?"Sending…":"Send verification code"}</button>
      </form>:<form onSubmit={verify}>
        <label>6-DIGIT VERIFICATION CODE<input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,""))} placeholder="••••••"/></label>
        <button disabled={busy||code.length!==6}>{busy?"Verifying…":"Verify and sign in"}</button>
        <button type="button" onClick={()=>{setSent(false);setCode("");setMessage("");}}>Change number</button>
      </form>}
      {message&&<div className={styles.note}>{message}</div>}
      <a href="/">Back to website →</a>
    </section>
  </main>;
}