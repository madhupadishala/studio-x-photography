'use client';
import Image from 'next/image';
import {useEffect,useRef,useState} from 'react';
import {imageGroups,imageAlt,imageOccasion,type ImageGroup} from '@/lib/public-images';
export function ImageCarousel({group,filter='All'}:{group:ImageGroup;filter?:string}){
 const images=(imageGroups[group] as readonly string[]).filter(name=>filter==='All'||imageOccasion(name)===filter.toLowerCase());
 const [index,setIndex]=useState(0),[paused,setPaused]=useState(false),[reduced,setReduced]=useState(false);const touchStart=useRef<number|null>(null);
 const scroller=useRef<HTMLDivElement>(null);const dotsRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{const m=window.matchMedia('(prefers-reduced-motion: reduce)');const update=()=>setReduced(m.matches);update();m.addEventListener('change',update);return()=>m.removeEventListener('change',update)},[]);
 useEffect(()=>{setIndex(0);scroller.current?.scrollTo({left:0,behavior:'instant'})},[filter]);
 useEffect(()=>{if(paused||reduced||images.length<2)return;const id=window.setInterval(()=>setIndex(i=>(i+1)%images.length),2800);return()=>window.clearInterval(id)},[paused,reduced,images.length]);
 useEffect(()=>{const el=scroller.current;if(!el)return;el.scrollTo({left:index*el.clientWidth,behavior:reduced?'instant':'smooth'})},[index,reduced,filter]);
 useEffect(()=>{const track=dotsRef.current;const dot=track?.children[index] as HTMLElement|undefined;if(!track||!dot)return;const left=dot.offsetLeft-track.offsetLeft-(track.clientWidth-dot.clientWidth)/2;track.scrollTo({left:Math.max(0,left),behavior:reduced?'instant':'smooth'})},[index,reduced]);
 if(!images.length)return <p>No illustrative images in this category.</p>;
 return <div className={'studio-carousel studio-carousel-'+group} onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)} onTouchStart={e=>{touchStart.current=e.touches[0]?.clientX??null;setPaused(true)}} onTouchEnd={e=>{const start=touchStart.current;const end=e.changedTouches[0]?.clientX;if(start!==null&&end!==undefined&&Math.abs(end-start)>35)setIndex(i=>(i+(end<start?1:-1)+images.length)%images.length);touchStart.current=null;setPaused(false)}} aria-label={group+' illustrative photography carousel'}>
 <div className="studio-carousel-track" ref={scroller} >{images.map((name,i)=><figure className="studio-slide" key={name}><Image src={'/media/'+name+'.jpg'} alt={imageAlt(name)} width={1200} height={800} priority={group==='hero'&&i===0} loading={group==='hero'&&i===0?'eager':'lazy'} sizes="(max-width: 700px) 100vw, 85vw"/><figcaption>{imageOccasion(name)} · Illustrative image</figcaption></figure>)}</div>
 {images.length>1&&<><button type="button" className="studio-arrow studio-prev" aria-label="Previous image" onClick={()=>setIndex(i=>(i-1+images.length)%images.length)}>‹</button><button type="button" className="studio-arrow studio-next" aria-label="Next image" onClick={()=>setIndex(i=>(i+1)%images.length)}>›</button><div className="studio-dots" ref={dotsRef}>{images.map((name,i)=><button key={name} type="button" aria-label={'Go to image '+(i+1)} aria-current={index===i?'true':undefined} onClick={()=>setIndex(i)}/>)}</div></>}
 </div>
}
