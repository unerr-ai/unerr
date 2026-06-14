// ECS / ALB health target. Kept dynamic so it is never statically cached and
// always reflects a live server response.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
