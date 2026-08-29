/**
 * PIN Login Form (Legacy - redirects to main login)
 * This component is no longer used directly. PIN login is now integrated
 * into the main EnhancedLoginForm via the pinLogin server function.
 * Kept for backward compatibility with any remaining references.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface PINLoginFormProps {
  userEmail: string;
  userName?: string;
  userAvatar?: string;
  onSuccess: () => void;
  onSwitchAccount: () => void;
  pinLength?: number;
}

export function PINLoginForm(_props: PINLoginFormProps) {
  const navigate = useNavigate();
  
  useEffect(() => {
    // PIN login is now handled in the main login page
    navigate('/login', { replace: true });
  }, [navigate]);

  return null;
}
