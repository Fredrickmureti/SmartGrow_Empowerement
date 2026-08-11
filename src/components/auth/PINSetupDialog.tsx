/**
 * PIN Setup Dialog
 * Allows users to set up a quick-login PIN (user-level, not device-bound)
 */

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from '@/components/ui/input-otp';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Shield, CheckCircle, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { usePINLogin } from '@/hooks/security/usePINLogin';
import { cn } from '@/lib/utils';

interface PINSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (pin: string) => void;
}

type PINLength = 4 | 5 | 6;

export function PINSetupDialog({ open, onOpenChange, onSuccess }: PINSetupDialogProps) {
  const { setPin: savePin, isSettingPin, hasPin } = usePINLogin();
  const [step, setStep] = useState<'length' | 'enter' | 'confirm' | 'success'>('length');
  const [pinLength, setPinLength] = useState<PINLength>(4);
  const [pinValue, setPinValue] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep(hasPin ? 'enter' : 'length');
      setPinLength(4);
      setPinValue('');
      setConfirmPin('');
      setShowPin(false);
      setError(null);
    }
  }, [open, hasPin]);

  const handlePinLengthNext = () => {
    setStep('enter');
  };

  const handlePinEntered = () => {
    if (pinValue.length !== pinLength) {
      setError(`Please enter a ${pinLength}-digit PIN`);
      return;
    }

    if (/^(.)\1+$/.test(pinValue)) {
      setError('PIN cannot be all the same digit');
      return;
    }

    const weakPins = ['1234', '12345', '123456', '0000', '00000', '000000', '1111', '11111', '111111'];
    if (weakPins.includes(pinValue)) {
      setError('This PIN is too common. Please choose a stronger one.');
      return;
    }

    setError(null);
    setStep('confirm');
  };

  const handleConfirmPin = async () => {
    if (confirmPin !== pinValue) {
      setError('PINs do not match. Please try again.');
      setConfirmPin('');
      return;
    }

    try {
      await savePin(pinValue);
      setStep('success');
      setTimeout(() => {
        onOpenChange(false);
        onSuccess?.(pinValue);
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to set PIN');
    }
  };

  const handleBack = () => {
    setError(null);
    if (step === 'confirm') {
      setConfirmPin('');
      setStep('enter');
    } else if (step === 'enter') {
      setPinValue('');
      setStep('length');
    }
  };

  const renderPinInput = (value: string, onChange: (val: string) => void) => (
    <InputOTP
      maxLength={pinLength}
      value={value}
      onChange={onChange}
      containerClassName="justify-center"
    >
      <InputOTPGroup>
        {Array.from({ length: Math.ceil(pinLength / 2) }).map((_, i) => (
          <InputOTPSlot key={i} index={i} className="w-12 h-12 text-xl" />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        {Array.from({ length: Math.floor(pinLength / 2) }).map((_, i) => (
          <InputOTPSlot 
            key={i + Math.ceil(pinLength / 2)} 
            index={i + Math.ceil(pinLength / 2)} 
            className="w-12 h-12 text-xl" 
          />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 mb-4">
            {step === 'success' ? (
              <CheckCircle className="h-6 w-6 text-primary" />
            ) : (
              <Shield className="h-6 w-6 text-primary" />
            )}
          </div>
          <DialogTitle className="text-center">
            {step === 'length' && 'Set Up Quick Login PIN'}
            {step === 'enter' && 'Create Your PIN'}
            {step === 'confirm' && 'Confirm Your PIN'}
            {step === 'success' && 'PIN Set Successfully!'}
          </DialogTitle>
          <DialogDescription className="text-center">
            {step === 'length' && 'Choose how many digits you want for your PIN'}
            {step === 'enter' && `Enter a ${pinLength}-digit PIN for quick login`}
            {step === 'confirm' && 'Enter your PIN again to confirm'}
            {step === 'success' && 'You can now use your PIN to sign in'}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {step === 'length' && (
            <div className="space-y-4">
              <RadioGroup
                value={String(pinLength)}
                onValueChange={(val) => setPinLength(Number(val) as PINLength)}
                className="grid grid-cols-3 gap-4"
              >
                {[4, 5, 6].map((length) => (
                  <div key={length}>
                    <RadioGroupItem
                      value={String(length)}
                      id={`pin-${length}`}
                      className="peer sr-only"
                    />
                    <Label
                      htmlFor={`pin-${length}`}
                      className={cn(
                        "flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground cursor-pointer",
                        "peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary"
                      )}
                    >
                      <span className="text-2xl font-bold">{length}</span>
                      <span className="text-xs text-muted-foreground">digits</span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
          )}

          {step === 'enter' && (
            <div className="space-y-4">
              {renderPinInput(pinValue, setPinValue)}
              <p className="text-xs text-center text-muted-foreground">
                Choose a PIN you'll remember. Avoid common patterns like 1234.
              </p>
            </div>
          )}

          {step === 'confirm' && (
            <div className="space-y-4">
              {renderPinInput(confirmPin, setConfirmPin)}
            </div>
          )}

          {step === 'success' && (
            <div className="flex justify-center py-4">
              <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                <CheckCircle className="h-8 w-8 text-primary" />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg mt-4">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>

        {step !== 'success' && (
          <DialogFooter className="flex-col sm:flex-row gap-2">
            {step !== 'length' && (
              <Button variant="outline" onClick={handleBack} className="sm:mr-auto">
                Back
              </Button>
            )}
            
            {step === 'length' && (
              <Button onClick={handlePinLengthNext} className="w-full sm:w-auto">
                Continue
              </Button>
            )}
            
            {step === 'enter' && (
              <Button 
                onClick={handlePinEntered} 
                disabled={pinValue.length !== pinLength}
                className="w-full sm:w-auto"
              >
                Continue
              </Button>
            )}
            
            {step === 'confirm' && (
              <Button 
                onClick={handleConfirmPin} 
                disabled={confirmPin.length !== pinLength || isSettingPin}
                className="w-full sm:w-auto"
              >
                {isSettingPin ? 'Setting PIN...' : 'Set PIN'}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
