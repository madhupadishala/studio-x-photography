'use client';
import {useState} from 'react';
const reels=[
 {title:'The Haldi Glow',subtitle:'Traditions in golden light',image:'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=520&q=80'},
 {title:'The Grand Entrance',subtitle:'A moment to remember',image:'https://images.unsplash.com/photo-1537633552985-df8429e8048b?auto=format&fit=crop&w=520&q=80'},
 {title:'Forever Begins',subtitle:'Love, laughter and celebration',image:'https://images.unsplash.com/photo-1511285560929-80b456fea0bc?auto=format&fit=crop&w=520&q=80'}
];
export function SocialShowcase(){
 const [active,setActive]=useState<number|null>(null);
 return <section className="site-shell sx-social" aria-labelledby="sx-social-heading">
 <div className="section-heading"><div><p className="eyebrow">STUDIO X · STORIES IN MOTION</p><h2 id="sx-social-heading">Feel every moment <em>all over again.</em></h2><p>Short celebrations, cinematic memories. A preview of how our Instagram Reels and YouTube films will appear.</p></div></div>
 <div className="sx-social-label"><strong>Reels &amp; little moments</strong><span>INSTAGRAM STYLE · 9:16</span></div>
 <div className="sx-reel-strip">{reels.map((reel,i)=><article className="sx-reel" key={reel.title}><button type="button" className="sx-reel-poster" onClick={()=>setActive(i)} aria-label={'Preview '+reel.title}><img src={reel.image} alt={'Illustrative photography for '+reel.title} loading="lazy"/><span className="sx-reel-play">▶</span><span className="sx-demo-tag">DEMO</span></button><strong>{reel.title}</strong><small>{reel.subtitle}</small></article>)}</div>
 <div className="sx-social-label sx-youtube-label"><strong>Cinematic wedding films</strong><span>YOUTUBE STYLE · 16:9</span></div>
 <div className="sx-film-layout"><button type="button" className="sx-film-poster" onClick={()=>setActive(3)} aria-label="Preview cinematic wedding film"><img src="https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1400&q=85" alt="Illustrative wedding film thumbnail" loading="lazy"/><span className="sx-film-play">▶</span><span className="sx-demo-tag">DEMO</span></button><div className="sx-film-copy"><p className="eyebrow">FEATURED FILM</p><h3>A love story, beautifully told.</h3><p>From the first look to the last dance — discover the magic of a full cinematic wedding film.</p><span>Real YouTube films will play here once connected.</span></div></div>
 {active!==null&&<div className="sx-video-backdrop" role="presentation" onClick={()=>setActive(null)}><div className="sx-video-dialog" role="dialog" aria-modal="true" aria-label="Demo video information" onClick={e=>e.stopPropagation()}><button type="button" className="sx-video-close" onClick={()=>setActive(null)} aria-label="Close preview">×</button><strong>{active===3?'Cinematic wedding film':reels[active]?.title}</strong><p>This is a layout demonstration. Connect a public Instagram Reel or YouTube video to enable playback here. No demo footage is presented as Studio X client work.</p><button type="button" className="button button-dark" onClick={()=>setActive(null)}>Back to gallery</button></div></div>}
 </section>;
}
