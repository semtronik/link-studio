import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

type ToastVariant = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  variant: ToastVariant;
  text: string;
  subtext?: string;
  exiting?: boolean;
}

interface ToastContextType {
  addToast: (variant: ToastVariant, text: string, subtext?: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

const VARIANT_STYLES: Record<ToastVariant, { border: string; icon: string; iconColor: string }> = {
  success: { border: 'border-l-rssi-good', icon: '\u2713', iconColor: 'text-rssi-good' },
  error: { border: 'border-l-rssi-bad', icon: '\u2717', iconColor: 'text-rssi-bad' },
  warning: { border: 'border-l-rssi-medium', icon: '\u26A0', iconColor: 'text-rssi-medium' },
  info: { border: 'border-l-brand', icon: '\u2139', iconColor: 'text-brand' },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const style = VARIANT_STYLES[toast.variant];

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 5000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      role="alert"
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      className={`bg-surface border border-border ${style.border} border-l-4 rounded-modal px-4 py-2 shadow-elevated flex items-start gap-3 min-w-[280px] max-w-[400px] ${
        toast.exiting ? 'animate-[toast-fade-out_300ms_ease-out_forwards]' : 'animate-[toast-slide-in_200ms_ease-out]'
      }`}
    >
      <span className={`${style.iconColor} text-base mt-0.5 flex-shrink-0`}>{style.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-text-primary">{toast.text}</div>
        {toast.subtext && (
          <div className="text-[12px] text-text-muted mt-0.5">{toast.subtext}</div>
        )}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-text-muted hover:text-text-secondary text-sm flex-shrink-0 mt-0.5"
      >
        \u2715
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((variant: ToastVariant, text: string, subtext?: string) => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev.slice(-2), { id, variant, text, subtext }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 300);
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast container */}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
          {toasts.map(toast => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast doit etre utilise dans un ToastProvider');
  }
  return ctx;
}
