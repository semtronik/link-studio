import { createContext, useContext, type ReactNode } from 'react';
import { useBackend } from '../hooks/useBackend';

type SerialContextType = ReturnType<typeof useBackend>;

const SerialContext = createContext<SerialContextType | null>(null);

export function SerialProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  return (
    <SerialContext.Provider value={backend}>
      {children}
    </SerialContext.Provider>
  );
}

export function useSerialContext(): SerialContextType {
  const ctx = useContext(SerialContext);
  if (!ctx) {
    throw new Error('useSerialContext doit être utilisé dans un SerialProvider');
  }
  return ctx;
}
