import type {ButtonHTMLAttributes,HTMLAttributes,ReactNode} from 'react';
export function Container({children,className='',...rest}:HTMLAttributes<HTMLDivElement>){return <div className={['container-editorial',className].join(' ')} {...rest}>{children}</div>}
export function EditorialGrid({children,className='',...rest}:HTMLAttributes<HTMLDivElement>){return <div className={['editorial-grid',className].join(' ')} {...rest}>{children}</div>}
export function Divider(){return <hr className='fine-rule'/>}
export function SectionLabel({number,children}:{number:string;children:ReactNode}){return <p className='section-label'>{number} / {children}</p>}
export function Caption({children}:{children:ReactNode}){return <p className='caption'>{children}</p>}
export function Button({variant='primary',className='',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'}){return <button {...props} className={['button-base',variant==='primary'?'button-primary':'button-secondary',className].join(' ')}/>}
export function SkipLink(){return <a className='skip-link' href='#main'>Skip to content</a>}
export function VisuallyHidden({children}:{children:ReactNode}){return <span className='sr-only'>{children}</span>}
