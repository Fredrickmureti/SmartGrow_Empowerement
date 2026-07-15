/**
 * MyLearningCatalog — browsable catalog of courses flagged `is_self_enroll`
 * that the current employee isn't already actively enrolled in. One-click
 * enrollment via `selfEnroll`.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useTrainingCourses, useTrainingEnrollments } from "@/hooks/usePerformance";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BookOpen, ArrowLeft } from "lucide-react";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";

export default function MyLearningCatalog() {
  const { currentEmployee } = useCurrentEmployee();
  const { courses, isLoading } = useTrainingCourses();
  const { enrollments, selfEnroll } = useTrainingEnrollments(currentEmployee?.id);

  const activeEnrolledIds = useMemo(
    () => new Set(enrollments.filter((e) => e.status === "enrolled" || e.status === "in_progress").map((e) => e.course_id)),
    [enrollments],
  );

  const catalog = useMemo(
    () => courses.filter((c) => c.is_self_enroll && c.status === "published"),
    [courses],
  );

  if (!currentEmployee) {
    return (
      <>
        <PageHeader title="Course catalog" description="Browse courses anyone can enroll in." />
        <PageBody><EmptyState icon={BookOpen} title="No linked employee record" description="Link your account to an employee profile to browse courses." /></PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Course catalog"
        description="Browse courses anyone can enroll in."
        actions={<Button variant="outline" asChild><Link to="/me/learning"><ArrowLeft className="h-4 w-4 mr-1" /> My learning</Link></Button>}
      />
      <PageBody>
      {isLoading ? <LoadingState /> : catalog.length === 0 ? (
        <EmptyState icon={BookOpen} title="No self-enroll courses available yet" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {catalog.map((c) => {
            const already = activeEnrolledIds.has(c.id);
            return (
              <Card key={c.id}>
                <CardHeader>
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  <CardDescription className="line-clamp-3">{c.objectives ?? c.description ?? "No description."}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-1 text-xs">
                    {c.category && <Badge variant="outline">{c.category}</Badge>}
                    {c.duration_hours != null && <Badge variant="outline">{c.duration_hours}h</Badge>}
                    {c.provider && <Badge variant="outline">{c.provider}</Badge>}
                    {c.requires_certificate && <Badge variant="secondary">Certificate</Badge>}
                  </div>
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={already || selfEnroll.isPending}
                    onClick={() => selfEnroll.mutate({ employee_id: currentEmployee.id, course_id: c.id })}
                  >
                    {already ? "Already enrolled" : "Enroll"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      </PageBody>
    </>
  );
}
