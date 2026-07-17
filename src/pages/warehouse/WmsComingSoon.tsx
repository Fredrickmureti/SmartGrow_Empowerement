/**
 * WmsComingSoon — placeholder for WMS routes whose domain migrations
 * land in later phases. Keeps the target topology visible in the sidebar
 * so stakeholders can navigate and give feedback without triggering a
 * 404. See ADR 0079 §6 for the phase schedule.
 */
import { Link } from "react-router-dom";
import { EmptyState, Section } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Construction } from "lucide-react";

interface WmsComingSoonProps {
  title: string;
  phase: string;
}

export function WmsComingSoon({ title, phase }: WmsComingSoonProps) {
  return (
    <Section>
      <EmptyState
        icon={Construction}
        title={`${title} — coming online`}
        description={phase}
        action={
          <Button asChild variant="outline">
            <Link to="/warehouse-app/dashboard">Back to overview</Link>
          </Button>
        }
      />
    </Section>
  );
}

export default WmsComingSoon;
