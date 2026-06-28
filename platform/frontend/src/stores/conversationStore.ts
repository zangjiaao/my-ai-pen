import { create } from "zustand";
import type { Conversation } from "../lib/types";
import { authFetch } from "../lib/api";

interface ConversationState {
  conversations: Conversation[];
  loading: boolean;
  fetchAll: () => Promise<void>;
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: [],
  loading: false,
  fetchAll: async () => {
    set({ loading: true });
    try {
      const data = await authFetch<Conversation[]>("/api/conversations");
      set({ conversations: data, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
