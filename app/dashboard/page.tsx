import { redirect } from "next/navigation";
import { ownerSession } from "../../lib/server";
import DashboardClient from "./dashboard-client";

export const dynamic = "force-dynamic";

export default async function DashboardPage(){
  const session=await ownerSession();
  if(!session) redirect("/dashboard/login");
  return <DashboardClient />;
}
