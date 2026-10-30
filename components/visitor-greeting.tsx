'use client';
import {useEffect,useState} from 'react';
export function VisitorGreeting({context='home'}:{context?:'home'|'help'}){
 const [name,setName]=useState('');
 useEffect(()=>{const refresh=()=>{try{setName(sessionStorage.getItem('studio-x-visitor-name')||'')}catch{}};refresh();window.addEventListener('studio-x-visitor-updated',refresh);return()=>window.removeEventListener('studio-x-visitor-updated',refresh)},[]);
 if(!name)return null;
 return <span className="visitor-personal-greeting">{context==='help'?'How can I help you, ':'Welcome, '}{name}!</span>;
}
