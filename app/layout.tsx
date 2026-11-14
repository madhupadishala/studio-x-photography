import type { Metadata } from "next";
import "./globals.css";
export const metadata:Metadata={title:"Studio X | Photography with intention",description:"Studio X photography — celebrations, portraits and stories in Hyderabad.",robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}