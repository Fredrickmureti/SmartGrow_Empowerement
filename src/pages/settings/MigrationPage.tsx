import { PlatformAppLayout } from "@/apps/platform";
import { MigrationWorkbench } from "@/components/migration/MigrationWorkbench";

export default function MigrationPage() {
  return (
    <PlatformAppLayout>
      <div className="w-full py-6 px-4 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Data Migration</h1>
          <p className="text-muted-foreground">
            Import your financial data from another system with guided validation.
          </p>
        </div>
        <MigrationWorkbench />
      </div>
    </PlatformAppLayout>
  );
}
