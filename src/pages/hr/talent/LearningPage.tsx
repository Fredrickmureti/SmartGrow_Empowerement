/**
 * Learning — Phase 4. The existing /hr/performance page already exposes a
 * course catalog and enrollment table; Phase 4 extends it with competency
 * tagging, target proficiency, and source (self-request / manager / plan /
 * compliance) — already added to the schema in Phase 1.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { BookOpen, ArrowRight } from "lucide-react";

export default function LearningPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5" /> Learning</CardTitle>
        <CardDescription>Course catalog, enrollments, and training history.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Courses can now carry competency tags + target proficiency, and enrollments record
          their source. Phase 4 brings competency-driven suggestions and write-back to
          competency assessments when training is completed.
        </p>
        <Button asChild variant="outline">
          <Link to="/hr/talent/dashboard">
            Open legacy courses & enrollments <ArrowRight className="h-4 w-4 ml-1" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
