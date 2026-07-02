/**
 * BusinessSagaContextMount — starts the in-renderer BusinessSaga
 * worker for the active business. Mount once near the app root,
 * right next to <HardwareExecContextMount />.
 *
 * The saga uses the same org id that the hardware exec log writes
 * against, so audit rows and outbox rows agree on tenant.
 */

import { useBusinesses } from '@/hooks/useBusinesses';
import { BusinessSagaMount } from '@/components/events/BusinessSagaMount';

export function BusinessSagaContextMount() {
  const { currentBusiness } = useBusinesses();
  return <BusinessSagaMount orgId={currentBusiness?.id ?? null} />;
}

export default BusinessSagaContextMount;
