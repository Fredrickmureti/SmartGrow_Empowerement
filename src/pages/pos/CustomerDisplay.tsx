import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShoppingCart, CreditCard, CheckCircle, Clock } from 'lucide-react';

interface CartItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  total: number;
}

interface DisplayData {
  status: 'idle' | 'scanning' | 'payment' | 'complete';
  items: CartItem[];
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  currency?: string;
  locale?: string;
  customerName?: string;
  loyaltyPoints?: number;
  message?: string;
}

const defaultData: DisplayData = {
  status: 'idle',
  items: [],
  subtotal: 0,
  tax: 0,
  discount: 0,
  total: 0,
};

/**
 * Customer-facing display component for secondary screen
 * Shows transaction totals, items, and status in real-time
 */
const CustomerDisplay = () => {
  const [displayData, setDisplayData] = useState<DisplayData>(defaultData);
  const [lastItem, setLastItem] = useState<CartItem | null>(null);

  useEffect(() => {
    const apply = (newData: DisplayData) => {
      setDisplayData(prev => {
        if (newData.items.length > prev.items.length) {
          setLastItem(newData.items[newData.items.length - 1]);
          setTimeout(() => setLastItem(null), 2000);
        }
        return newData;
      });
    };

    const handleDisplayUpdate = (event: MessageEvent) => {
      if (event.data?.type === 'customer-display-update') {
        apply(event.data.payload as DisplayData);
      }
    };

    window.addEventListener('message', handleDisplayUpdate);

    // BroadcastChannel path — survives popup reloads where the opener's
    // postMessage handle is lost. Single channel instance for both
    // send and receive so reply ordering is deterministic (closing
    // immediately after a request-state send loses the reply).
    let bc: BroadcastChannel | null = null;
    let gotPayload = false;
    const apply2 = (newData: DisplayData) => { gotPayload = true; apply(newData); };
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        bc = new BroadcastChannel('pos:customer-display');
        bc.onmessage = (ev: MessageEvent) => {
          if (ev.data?.type === 'customer-display-update') {
            apply2(ev.data.payload as DisplayData);
          }
        };
        // Listener is attached — now ask the cashier tab to replay state.
        bc.postMessage({ type: 'customer-display-request-state' });
      } catch { bc = null; }
    }

    // Retry once after 1s if the cashier hasn't responded — handles
    // the case where the popup mounted while the cashier tab was
    // mid-navigation and missed our first request.
    const retry = setTimeout(() => {
      if (!gotPayload && bc) {
        try { bc.postMessage({ type: 'customer-display-request-state' }); } catch { /* noop */ }
      }
    }, 1000);

    // Track H1 — consume customer-display updates via the unified
    // `window.pos.hardware.subscribe` channel (EventBroker) for the
    // Electron path. Single chokepoint, single subscribe surface.
    const posSub = (window as unknown as { pos?: { hardware?: { subscribe?: (cb: (ev: { type: string; data?: unknown }) => void) => () => void } } }).pos?.hardware?.subscribe;
    const unsubscribe = posSub?.((event) => {
      if (event.type === 'customer_display:update' && event.data) {
        apply2(event.data as DisplayData);
      }
    });

    return () => {
      window.removeEventListener('message', handleDisplayUpdate);
      unsubscribe?.();
      clearTimeout(retry);
      try { bc?.close(); } catch { /* noop */ }
    };
  }, []);

  const formatCurrency = (amount: number) => {
    const currencyCode = displayData.currency || 'USD'; // architecture-allow: display-only fallback
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode,
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${currencyCode} ${amount.toFixed(2)}`;
    }
  };

  /** Adaptive font class based on formatted string length to prevent overflow */
  const getAdaptiveFontClass = (formatted: string) => {
    const len = formatted.length;
    if (len > 18) return 'text-xl';
    if (len > 15) return 'text-2xl';
    if (len > 12) return 'text-3xl';
    if (len > 9) return 'text-4xl';
    return 'text-5xl';
  };

  const getStatusIcon = () => {
    switch (displayData.status) {
      case 'scanning':
        return <ShoppingCart className="h-12 w-12 text-primary animate-pulse" />;
      case 'payment':
        return <CreditCard className="h-12 w-12 text-amber-500 animate-pulse" />;
      case 'complete':
        return <CheckCircle className="h-12 w-12 text-green-500" />;
      default:
        return <Clock className="h-12 w-12 text-muted-foreground" />;
    }
  };

  const getStatusMessage = () => {
    if (displayData.message) return displayData.message;
    
    switch (displayData.status) {
      case 'scanning':
        return 'Scanning items...';
      case 'payment':
        return 'Processing payment...';
      case 'complete':
        return 'Thank you for your purchase!';
      default:
        return 'Welcome!';
    }
  };

  const formattedTotal = formatCurrency(displayData.total);
  const totalFontClass = getAdaptiveFontClass(formattedTotal);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted flex flex-col">
      {/* Header */}
      <header className="bg-primary text-primary-foreground p-6 text-center">
        <h1 className="text-3xl font-bold">Point of Sale</h1>
        {displayData.customerName && (
          <p className="text-lg mt-2 opacity-90">
            Welcome, {displayData.customerName}!
          </p>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 flex min-w-0">
        {/* Items List */}
        <div className="flex-1 p-6 overflow-hidden min-w-0">
          <div className="bg-card rounded-2xl shadow-xl h-full flex flex-col">
            <div className="p-4 border-b border-border">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <ShoppingCart className="h-5 w-5" />
                Your Items ({displayData.items.length})
              </h2>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              <AnimatePresence mode="popLayout">
                {displayData.items.map((item, index) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ 
                      opacity: 1, 
                      x: 0,
                      scale: lastItem?.id === item.id ? 1.02 : 1,
                      backgroundColor: lastItem?.id === item.id ? 'hsl(var(--primary) / 0.1)' : 'transparent'
                    }}
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ delay: index * 0.05 }}
                    className="flex justify-between items-center p-4 rounded-xl bg-muted/50 hover:bg-muted transition-colors min-w-0"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-lg truncate">{item.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {item.quantity} × {formatCurrency(item.price)}
                      </p>
                    </div>
                    <p className="text-xl font-bold text-primary ml-4 shrink-0">
                      {formatCurrency(item.total)}
                    </p>
                  </motion.div>
                ))}
              </AnimatePresence>

              {displayData.items.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <ShoppingCart className="h-16 w-16 mb-4 opacity-30" />
                  <p className="text-xl">No items scanned yet</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Totals Panel */}
        <div className="w-80 lg:w-96 xl:w-[28rem] p-6 shrink-0">
          <div className="bg-card rounded-2xl shadow-xl h-full flex flex-col">
            {/* Status */}
            <div className="p-6 text-center border-b border-border">
              <motion.div
                key={displayData.status}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="flex flex-col items-center gap-3"
              >
                {getStatusIcon()}
                <p className="text-lg font-medium text-muted-foreground">
                  {getStatusMessage()}
                </p>
              </motion.div>
            </div>

            {/* Totals */}
            <div className="flex-1 p-6 space-y-4 min-w-0">
              <div className="flex justify-between text-lg min-w-0">
                <span className="text-muted-foreground shrink-0">Subtotal</span>
                <span className="font-medium truncate ml-2 text-right">{formatCurrency(displayData.subtotal)}</span>
              </div>
              
              {displayData.discount > 0 && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="flex justify-between text-lg text-green-600 min-w-0"
                >
                  <span className="shrink-0">Discount</span>
                  <span className="font-medium truncate ml-2 text-right">-{formatCurrency(displayData.discount)}</span>
                </motion.div>
              )}
              
              <div className="flex justify-between text-lg min-w-0">
                <span className="text-muted-foreground shrink-0">Tax</span>
                <span className="font-medium truncate ml-2 text-right">{formatCurrency(displayData.tax)}</span>
              </div>

              {displayData.loyaltyPoints !== undefined && displayData.loyaltyPoints > 0 && (
                <div className="flex justify-between text-lg text-amber-600">
                  <span>Loyalty Points</span>
                  <span className="font-medium">+{displayData.loyaltyPoints}</span>
                </div>
              )}
            </div>

            {/* Grand Total */}
            <div className="p-6 bg-primary text-primary-foreground rounded-b-2xl overflow-hidden">
              <div className="text-center">
                <p className="text-sm uppercase tracking-wider opacity-80">Total Due</p>
                <motion.p
                  key={displayData.total}
                  initial={{ scale: 1.1 }}
                  animate={{ scale: 1 }}
                  className={`${totalFontClass} font-bold mt-2 truncate`}
                >
                  {formattedTotal}
                </motion.p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-muted p-4 text-center text-sm text-muted-foreground">
        <p>Thank you for shopping with us!</p>
      </footer>
    </div>
  );
};

export default CustomerDisplay;
