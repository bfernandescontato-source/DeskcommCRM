import { randomUUID } from "node:crypto";
import { audit } from "@/lib/audit";
import { fail, noContent } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID(); const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response; const { id } = await params; const supabase = await createClient();
  const { data: c, error: ce } = await supabase.from("conversations").select("id,is_group").eq("id", id).eq("organization_id", authz.org.orgId).maybeSingle();
  if (ce) return fail("internal_error", ce.message, 500, { requestId });
  if (!c) return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  if (!c.is_group) return fail("validation_failed", "Somente grupos podem ser fixados.", 422, { requestId });
  const { error } = await supabase.from("conversation_group_pins").upsert({ organization_id: authz.org.orgId, user_id: authz.user.id, conversation_id: id }, { onConflict: "organization_id,user_id,conversation_id", ignoreDuplicates: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  void audit({ action: "conversation.group_pinned", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "conversation", resourceId: id, requestId });
  return noContent(requestId);
}
export async function DELETE(_req: Request, { params }: Ctx): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID(); const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response; const { id } = await params; const supabase = await createClient();
  const { error } = await supabase.from("conversation_group_pins").delete().eq("organization_id", authz.org.orgId).eq("user_id", authz.user.id).eq("conversation_id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  void audit({ action: "conversation.group_unpinned", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "conversation", resourceId: id, requestId });
  return noContent(requestId);
}
