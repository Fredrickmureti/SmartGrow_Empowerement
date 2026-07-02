import { MigrationStepOpenBalance } from "./MigrationStepOpenBalance";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

export function MigrationStepOpenAR({ onComplete, onSkip }: Props) {
  return <MigrationStepOpenBalance type="ar" onComplete={onComplete} onSkip={onSkip} />;
}
