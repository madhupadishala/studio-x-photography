import { NextRequest, NextResponse } from "next/server";
import { dispatchRunGrowTelemetry } from "../../../../../lib/rungrow-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Cron delivery is not configured" }, { status: 503 });
  if (req.headers.get("authorization") !== "Bearer " + secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await dispatchRunGrowTelemetry());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Telemetry delivery unavailable" }, { status: 503 });
  }
}
