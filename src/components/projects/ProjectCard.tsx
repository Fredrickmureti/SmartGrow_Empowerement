import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Calendar, Users, Clock } from "lucide-react";
import { format } from "date-fns";
import { Project } from "@/hooks/projects";
import { useNavigate } from "react-router-dom";

interface ProjectCardProps {
  project: Project;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const navigate = useNavigate();

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-500/10 text-green-600 border-green-500/20";
      case "completed":
        return "bg-blue-500/10 text-blue-600 border-blue-500/20";
      case "on_hold":
        return "bg-yellow-500/10 text-yellow-600 border-yellow-500/20";
      case "cancelled":
        return "bg-red-500/10 text-red-600 border-red-500/20";
      default:
        return "bg-gray-500/10 text-gray-600 border-gray-500/20";
    }
  };

  // Use progress from project (calculated via useProjects hook) or default to 0
  const progress = project.progress ?? 0;

  return (
    <Card 
      className="cursor-pointer hover:border-primary/50 transition-colors"
      onClick={() => navigate(`/projects-app/${project.id}`)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div 
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: project.color || "#3b82f6" }}
            />
            <CardTitle className="text-base">{project.name}</CardTitle>
          </div>
          <Badge variant="outline" className={getStatusColor(project.status || "draft")}>
            {project.status}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{project.project_number}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {project.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">
            {project.description}
          </p>
        )}

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-medium">{progress}%</span>
          </div>
          <Progress value={progress} className="h-2" />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {project.end_date ? format(new Date(project.end_date), "MMM d") : "No deadline"}
          </div>
          {project.allocated_hours && (
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {project.allocated_hours}h
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
