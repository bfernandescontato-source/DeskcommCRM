import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { permissoesDaCentral } from "@/lib/campaigns/permissoes";

import { CampanhaClient } from "../_components/CampanhaClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Campanha" };

export default async function CampanhaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app/inbox");
  const pode = permissoesDaCentral(activeOrg.role);
  if (!pode.ver) redirect("/app/inbox");

  return (
    <div className="flex h-full flex-col gap-5 p-6">
      {/* useSearchParams (a aba ativa mora na URL) exige Suspense. */}
      <Suspense fallback={null}>
        <CampanhaClient id={id} pode={pode} />
      </Suspense>
    </div>
  );
}
