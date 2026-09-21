import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { permissoesDaCentral } from "@/lib/campaigns/permissoes";

import { Assistente } from "../_components/Assistente";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Nova campanha" };

export default async function NovaCampanhaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app/inbox");
  const pode = permissoesDaCentral(activeOrg.role);
  if (!pode.criar) redirect("/app/disparos");

  return (
    <div className="flex h-full flex-col gap-5 p-6">
      <Suspense fallback={null}>
        <Assistente pode={pode} />
      </Suspense>
    </div>
  );
}
