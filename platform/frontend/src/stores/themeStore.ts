import { create } from "zustand";
import {
  applyTheme,
  resolveInitialTheme,
  toggleTheme as flipTheme,
  type ThemeMode,
} from "../lib/theme";

interface ThemeState {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const initial = typeof document !== "undefined" ? resolveInitialTheme() : ("light" as ThemeMode);
if (typeof document !== "undefined") {
  applyTheme(initial);
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initial,
  setTheme: (mode) => {
    applyTheme(mode);
    set({ theme: mode });
  },
  toggleTheme: () => {
    const next = flipTheme(get().theme);
    set({ theme: next });
  },
}));
