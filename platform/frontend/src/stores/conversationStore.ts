import { create } from "zustand";
import type { Conversation } from "../lib/types";
import { authFetch } from "../lib/api";

interface ConversationState {
  conversations: Conversation[];
  loading: boolean;
  fetchAll: () => Promise<void>;
  removeLocal: (id: string) => void;
  /** Patch one conversation row (status/working) from live WS without full refetch. */
  patchConversation: (id: string, patch: Partial<Conversation>) => void;
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
  removeLocal: (id: string) => {
    set((state) => ({ conversations: state.conversations.filter((conversation) => conversation.id !== id) }));
  },
  patchConversation: (id, patch) => {
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === id ? { ...conversation, ...patch } : conversation,
      ),
    }));
  },
}));
