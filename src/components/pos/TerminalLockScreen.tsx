import { useState, useEffect, useCallback } from 'react';
import { Lock, User, LogIn, Loader2, AlertCircle, Delete, X, UserX, Settings, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';

interface Cashier {
  id: string;
  display_name: string;
  employee_number: string | null;
  profile?: {
    avatar_url?: string;
  };
}

interface TerminalLockScreenProps {
  registerName: string;
  cashiers: Cashier[];
  isLocked?: boolean;
  lockedCashierName?: string;
  onLogin: (cashierId: string, pin: string) => void;
  onUnlock?: (pin: string) => void;
  onManagerLogin?: (pin: string) => void;
  isLoading?: boolean;
  isManagerLoading?: boolean;
  error?: string | null;
  pinLength?: number;
}

export function TerminalLockScreen({
  registerName,
  cashiers,
  isLocked = false,
  lockedCashierName,
  onLogin,
  onUnlock,
  onManagerLogin,
  isLoading = false,
  isManagerLoading = false,
  error,
  pinLength = 4,
}: TerminalLockScreenProps) {
  const navigate = useNavigate();
  const [selectedCashier, setSelectedCashier] = useState<string>('');
  const [pin, setPin] = useState('');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isManagerMode, setIsManagerMode] = useState(false);
  
  const hasNoCashiers = !isLocked && cashiers.length === 0;
  const isSubmitting = isLoading || isManagerLoading;

  // Update clock every second
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Reset PIN when switching modes
  useEffect(() => {
    setPin('');
  }, [isManagerMode]);

  const maxPinLength = Math.max(pinLength, 4); // Minimum 4 digits
  
  const handleKeyPress = useCallback((key: string) => {
    if (key === 'clear') {
      setPin('');
    } else if (key === 'backspace') {
      setPin(prev => prev.slice(0, -1));
    } else if (pin.length < maxPinLength) {
      setPin(prev => prev + key);
    }
  }, [pin, maxPinLength]);

  const handleSubmit = useCallback(() => {
    if (pin.length < maxPinLength) return;
    
    if (isManagerMode && onManagerLogin) {
      onManagerLogin(pin);
    } else if (isLocked && onUnlock) {
      onUnlock(pin);
    } else if (selectedCashier) {
      onLogin(selectedCashier, pin);
    }
    setPin('');
  }, [pin, maxPinLength, isManagerMode, onManagerLogin, isLocked, onUnlock, selectedCashier, onLogin]);

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && pin.length >= maxPinLength) {
        handleSubmit();
      } else if (e.key === 'Backspace') {
        setPin(prev => prev.slice(0, -1));
      } else if (e.key === 'Escape') {
        setPin('');
      } else if (/^\d$/.test(e.key) && pin.length < maxPinLength) {
        setPin(prev => prev + e.key);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pin, maxPinLength, handleSubmit]);

  const keypadButtons = [
    ['7', '8', '9'],
    ['4', '5', '6'],
    ['1', '2', '3'],
    ['C', '0', '⌫'],
  ];

  const canSubmit = isManagerMode 
    ? pin.length >= maxPinLength 
    : (isLocked ? pin.length >= maxPinLength : pin.length >= maxPinLength && selectedCashier);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-background via-background to-muted">
      {/* Background pattern */}
      <div className="absolute inset-0 opacity-5">
        <div className="absolute inset-0" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.4'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }} />
      </div>

      <div className="relative flex flex-col items-center gap-6 p-8 overflow-y-auto max-h-screen">
        {/* Clock */}
        <div className="text-center mb-4">
          <div className="text-6xl font-light tracking-tight text-foreground">
            {format(currentTime, 'HH:mm')}
          </div>
          <div className="text-lg text-muted-foreground mt-1">
            {format(currentTime, 'EEEE, MMMM d, yyyy')}
          </div>
        </div>

        {/* Lock Card */}
        <Card className="w-[400px] shadow-2xl border-2">
          <CardHeader className="text-center pb-4">
            <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
              isManagerMode ? 'bg-amber-500/10' : 'bg-primary/10'
            }`}>
              {isManagerMode ? (
                <ShieldCheck className="h-8 w-8 text-amber-600" />
              ) : (
                <Lock className="h-8 w-8 text-primary" />
              )}
            </div>
            <CardTitle className="text-xl">
              {isManagerMode ? 'Manager Access' : isLocked ? 'Terminal Locked' : 'Cashier Login'}
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {registerName}
            </p>
          </CardHeader>

          <CardContent className="space-y-6">
            {/* Error Alert */}
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Manager Mode */}
            {isManagerMode ? (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                  <ShieldCheck className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <p className="font-medium text-amber-800 dark:text-amber-200">Manager Override</p>
                  <p className="text-xs text-amber-600 dark:text-amber-400">Enter your manager PIN</p>
                </div>
              </div>
            ) : isLocked ? (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                  <User className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">{lockedCashierName}</p>
                  <p className="text-xs text-muted-foreground">Enter PIN to unlock</p>
                </div>
              </div>
            ) : hasNoCashiers ? (
              <div className="text-center py-4">
                <div className="mx-auto w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-3">
                  <UserX className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                </div>
                <p className="text-sm font-medium mb-1">No Cashiers Assigned</p>
                <p className="text-xs text-muted-foreground mb-4">
                  This register requires cashier login, but no cashiers are assigned.
                </p>
                <div className="flex flex-col gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate('/pos/settings')}
                    className="gap-2"
                  >
                    <Settings className="h-4 w-4" />
                    Go to Cashier Settings
                  </Button>
                  {onManagerLogin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsManagerMode(true)}
                      className="gap-2 text-amber-600"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      Use Manager Access
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-sm font-medium">Select Cashier</label>
                <Select value={selectedCashier} onValueChange={setSelectedCashier}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose cashier..." />
                  </SelectTrigger>
                  <SelectContent>
                    {cashiers.map((cashier) => (
                      <SelectItem key={cashier.id} value={cashier.id}>
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4" />
                          <span>{cashier.display_name}</span>
                          {cashier.employee_number && (
                            <span className="text-muted-foreground">
                              ({cashier.employee_number})
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* PIN Display - Show for manager mode or when cashiers exist */}
            {(isManagerMode || !hasNoCashiers) && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Enter PIN</label>
                  <div className="flex justify-center gap-2">
                    {Array.from({ length: maxPinLength }, (_, i) => (
                      <div
                        key={i}
                        className={`w-10 h-12 rounded-lg border-2 flex items-center justify-center transition-all ${
                          i < pin.length
                            ? isManagerMode ? 'bg-amber-500 border-amber-500' : 'bg-primary border-primary'
                            : 'bg-muted border-border'
                        }`}
                      >
                        {i < pin.length && (
                          <div className={`w-3 h-3 rounded-full ${isManagerMode ? 'bg-white' : 'bg-primary-foreground'}`} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Numeric Keypad */}
                <div className="grid grid-cols-3 gap-2">
                  {keypadButtons.flat().map((key) => (
                    <Button
                      key={key}
                      variant="outline"
                      className="h-14 text-xl font-medium"
                      disabled={isSubmitting || (!isManagerMode && !isLocked && !selectedCashier)}
                      onClick={() => {
                        if (key === 'C') {
                          setPin('');
                        } else if (key === '⌫') {
                          setPin(prev => prev.slice(0, -1));
                        } else {
                          handleKeyPress(key);
                        }
                      }}
                    >
                      {key === '⌫' ? <Delete className="h-5 w-5" /> : key === 'C' ? <X className="h-5 w-5" /> : key}
                    </Button>
                  ))}
                </div>

                {/* Login Button */}
                <Button
                  className={`w-full h-12 text-lg ${isManagerMode ? 'bg-amber-600 hover:bg-amber-700' : ''}`}
                  onClick={handleSubmit}
                  disabled={isSubmitting || !canSubmit}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      {isManagerMode ? 'Verifying...' : isLocked ? 'Unlocking...' : 'Logging in...'}
                    </>
                  ) : (
                    <>
                      {isManagerMode ? <ShieldCheck className="mr-2 h-5 w-5" /> : <LogIn className="mr-2 h-5 w-5" />}
                      {isManagerMode ? 'Access Terminal' : isLocked ? 'Unlock' : 'Login'}
                    </>
                  )}
                </Button>
              </>
            )}

            {/* Toggle Manager Mode */}
            {!isLocked && onManagerLogin && (
              <div className="text-center pt-2 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsManagerMode(!isManagerMode)}
                  className={`text-xs ${isManagerMode ? 'text-muted-foreground' : 'text-amber-600 hover:text-amber-700'}`}
                >
                  {isManagerMode ? (
                    <>
                      <User className="h-3 w-3 mr-1" />
                      Switch to Cashier Login
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="h-3 w-3 mr-1" />
                      Manager Access
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Footer */}
        <p className="text-xs text-muted-foreground">
          {isManagerMode ? 'Use your manager PIN to access the terminal' : 'Contact manager if you forgot your PIN'}
        </p>
      </div>
    </div>
  );
}
