import { MigrationStepOpenBalance } from "./MigrationStepOpenBalance";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

export function MigrationStepOpenAP({ onComplete, onSkip }: Props) {
  return <MigrationStepOpenBalance type="ap" onComplete={onComplete} onSkip={onSkip} />;
}
