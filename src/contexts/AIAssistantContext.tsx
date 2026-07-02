import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface AIAssistantContextType {
  isOpen: boolean;
  openAIChat: () => void;
  closeAIChat: () => void;
  setIsOpen: (open: boolean) => void;
}

const AIAssistantContext = createContext<AIAssistantContextType | null>(null);

export function AIAssistantProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const openAIChat = useCallback(() => setIsOpen(true), []);
  const closeAIChat = useCallback(() => setIsOpen(false), []);

  return (
    <AIAssistantContext.Provider value={{ isOpen, openAIChat, closeAIChat, setIsOpen }}>
      {children}
    </AIAssistantContext.Provider>
  );
}

export function useAIAssistantContext() {
  const context = useContext(AIAssistantContext);
  if (!context) {
    throw new Error("useAIAssistantContext must be used within AIAssistantProvider");
  }
  return context;
}
