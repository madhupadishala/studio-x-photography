import {createHash} from "node:crypto";
import {rawQuery} from "./server";

export function clientKey(req:Request,route:string):string {
  const ip=(req.headers.get("x-forwarded-for")??req.headers.get("x-real-ip")??"").split(",")[0]?.trim()??"";
  const pepper=process.env.OTP_PEPPER??"studio-x-local-rate-limit";
  return route+":"+createHash("sha256").update(ip+pepper).digest("hex").slice(0,16);
}
export async function allow(key:string,limit:number,windowSec:number):Promise<boolean> {
  const rows=await rawQuery<{hits:number}>(
    "INSERT INTO rate_hits (key,window_start,hits) VALUES ($1,to_timestamp(floor(extract(epoch from now())/$2::int)*$2::int),1) ON CONFLICT (key,window_start) DO UPDATE SET hits=rate_hits.hits+1 RETURNING hits",
    [key,windowSec]
  );
  return Number(rows[0]?.hits??1)<=limit;
}
