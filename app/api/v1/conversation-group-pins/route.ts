import { randomUUID } from "node:crypto";
import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** IDs dos grupos fixados pela pessoa atual; nunca expõe preferências de colegas. */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversation_group_pins")
    .select("conversation_id")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", authz.user.id)
    .order("created_at", { ascending: false });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  return ok((data ?? []).map((p) => p.conversation_id), { requestId });
}
