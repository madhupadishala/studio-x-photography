import DashboardClient from "./dashboard-client";

export const dynamic = "force-dynamic";

// Public UI preview only. All dashboard data and mutation APIs continue to
// enforce ownerSession/authRequired on the server.
export default function DashboardPage(){
  return <DashboardClient />;
}
