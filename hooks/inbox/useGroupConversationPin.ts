"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

const KEY = ["group-conversation-pins"] as const;

export function useGroupConversationPins() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiClient.get<{ data: string[] }>("/api/v1/conversation-group-pins").then((r) => r.data),
  });
}

export function useToggleGroupConversationPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, pinned }: { conversationId: string; pinned: boolean }) =>
      pinned
        ? apiClient.delete(`/api/v1/conversations/${conversationId}/group-pin`)
        : apiClient.post(`/api/v1/conversations/${conversationId}/group-pin`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: showApiError,
  });
}
