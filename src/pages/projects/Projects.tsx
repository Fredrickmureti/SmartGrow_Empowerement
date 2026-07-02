import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, LayoutGrid, List, FolderKanban, Calendar, Users } from "lucide-react";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { useProjects, Project } from "@/hooks/projects";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { ProjectForm } from "@/components/projects/ProjectForm";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { format } from "date-fns";
import { PermissionGate } from "@/components/common/PermissionGate";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { useViewMode } from "@/hooks/useViewMode";

export default function Projects() {
  const { projects, isLoading } = useProjects();
  const [showForm, setShowForm] = useState(false);
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "project" });
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters, filterEntityIds, isFiltering: isCustomFiltering } = useCustomFieldFiltering("project");

  const filteredProjects = isCustomFiltering
    ? projects.filter(p => filterEntityIds.has(p.id))
    : projects;

  const activeProjects = filteredProjects.filter(p => p.status === "active");
  const completedProjects = filteredProjects.filter(p => p.status === "completed");

  if (isLoading) {
    return (
      <>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground">Manage your projects and tasks</p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
          <CustomizeFieldsButton entityType="project" />
          <ViewSwitcher
            entityType="project"
            currentView={currentView}
            onViewChange={setView}
          />
          <PermissionGate permission="manageProjects">
            <Button onClick={() => setShowForm(true)} className="w-full sm:w-auto">
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Button>
          </PermissionGate>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Projects</CardTitle>
            <FolderKanban className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{filteredProjects.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active</CardTitle>
            <Calendar className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeProjects.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completed</CardTitle>
            <Users className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{completedProjects.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">On Hold</CardTitle>
            <Calendar className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{filteredProjects.filter(p => p.status === "on_hold").length}</div>
          </CardContent>
        </Card>
      </div>

      <CustomFieldFilters entityType="project" filters={customFieldFilters} onFiltersChange={setCustomFieldFilters} />

      <DynamicViewsRenderer
        currentView={currentView}
        selectedSavedView={selectedSavedView}
        data={filteredProjects as unknown as Record<string, unknown>[]}
        isLoading={isLoading}
      />

      {/* Project Grid/List (when list view) */}
      {currentView === "list" && (
        <>
          {filteredProjects.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <FolderKanban className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No projects yet</h3>
                <p className="text-muted-foreground mb-4">Create your first project to get started</p>
                <PermissionGate permission="manageProjects">
                  <Button onClick={() => setShowForm(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Project
                  </Button>
                </PermissionGate>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredProjects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          )}
        </>
      )}

        {/* Project Form Dialog */}
        <ProjectForm
          open={showForm}
          onOpenChange={setShowForm}
        />
      </div>
    </>
  );
}
