import { redirect } from "next/navigation";
import { ownerSession } from "../../lib/server";
import OnboardingClient from "./onboarding-client";

export const dynamic = "force-dynamic";

export default async function OnboardingPage(){
  const session=await ownerSession();
  if(!session) redirect("/dashboard/login");
  return <OnboardingClient />;
}
