/**
 * VersionCompareCard — presentational picker for arbitrary
 * version-pair compare in the pack editor. Extracted from
 * `PackEditorShell` so it can be unit-tested in isolation
 * without standing up the full editor + Supabase mocks.
 *
 * Holds NO data-fetching of its own. The parent owns
 * `versions` and the `compareFromId/compareToId` state so the
 * shell remains the single source of selection state.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PackDiffView } from "./PackDiffView";

export interface PackVersionLike {
  id: string;
  version: string;
  snapshot: any;
}

interface Props {
  versions: PackVersionLike[];
  compareFromId: string | null;
  compareToId: string | null;
  onChangeFrom: (id: string | null) => void;
  onChangeTo: (id: string | null) => void;
}

export function VersionCompareCard({
  versions,
  compareFromId,
  compareToId,
  onChangeFrom,
  onChangeTo,
}: Props) {
  const versionById = new Map<string, PackVersionLike>();
  versions.forEach((v) => versionById.set(v.id, v));
  const compareFrom = compareFromId ? versionById.get(compareFromId) : null;
  const compareTo = compareToId ? versionById.get(compareToId) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Compare any two versions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {versions.length < 2 ? (
          <div className="text-xs text-muted-foreground">
            Need at least two published versions to compare.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Previous</label>
                <Select value={compareFromId ?? ""} onValueChange={(v) => onChangeFrom(v || null)}>
                  <SelectTrigger className="h-8 text-xs" data-testid="compare-from">
                    <SelectValue placeholder="Pick a version" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.id} value={v.id}>v{v.version}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Next</label>
                <Select value={compareToId ?? ""} onValueChange={(v) => onChangeTo(v || null)}>
                  <SelectTrigger className="h-8 text-xs" data-testid="compare-to">
                    <SelectValue placeholder="Pick a version" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.id} value={v.id}>v{v.version}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {compareFrom && compareTo && compareFrom.id !== compareTo.id ? (
              <PackDiffView
                previous={compareFrom.snapshot}
                next={compareTo.snapshot}
                title={`v${compareFrom.version} → v${compareTo.version}`}
              />
            ) : (
              <div className="text-xs text-muted-foreground">
                Pick two different versions above.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}