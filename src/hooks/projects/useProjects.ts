import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "../useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface Project {
  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  project_number: string;
  name: string;
  description: string | null;
  project_type: "internal" | "client" | "template";
  customer_id: string | null;
  status: "draft" | "active" | "on_hold" | "completed" | "cancelled";
  priority: number;
  start_date: string | null;
  end_date: string | null;
  actual_start_date: string | null;
  actual_end_date: string | null;
  budget: number | null;
  budget_type: "fixed" | "hourly" | "none";
  hourly_rate: number | null;
  allocated_hours: number | null;
  spent_hours: number;
  color: string;
  manager_id: string | null;
  is_billable: boolean;
  allow_timesheets: boolean;
  privacy: "public" | "team" | "private";
  tags: string[] | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Stage 1 additions
  pricing_type:
    | "non_billable"
    | "employee_rate"
    | "task_rate"
    | "project_rate"
    | "fixed_price"
    | "milestone";
  currency: string;
  /**
   * Provisioned automatically by the database: every project owns exactly one
   * analytic account in the `project` analytic plan. Read-only from the client.
   */
  analytic_account_id: string | null;
  template_id: string | null;
  is_template: boolean;
  last_update_status: "on_track" | "at_risk" | "off_track" | null;
  last_update_at: string | null;
  // Provenance — set when the project was generated from CRM/Sales
  source_lead_id: string | null;
  source_sales_order_id: string | null;
  // Joined data
  customer?: {
    id: string;
    name: string;
    is_company?: boolean | null;
  };
  manager?: {
    id: string;
    email: string;
  };
  // Computed
  task_count?: number;
  completed_tasks?: number;
  progress?: number;
}

export interface ProjectStage {
  id: string;
  project_id: string;
  name: string;
  sequence: number;
  is_closed: boolean;
  fold: boolean;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectMilestone {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  deadline: string | null;
  is_reached: boolean;
  reached_at: string | null;
  sequence: number;
  created_at: string;
  updated_at: string;
}

export interface UseProjectsOptions {
  /**
   * When false, the hook does NOT auto-fetch the project list on mount.
   * Use this from always-mounted consumers (e.g. dialogs gated by an
   * `open` prop) that only need the mutation helpers — so visiting an
   * unrelated module doesn't trigger a cross-module fetch.
   */
  enabled?: boolean;
}

export function useProjects(options: UseProjectsOptions = {}) {
  const { enabled = true } = options;
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);

  const fetchProjects = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      let query = supabase
        .from("projects")
        .select(`
          *,
          customer:contacts(id, name, is_company)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      query = query.eq("business_id", currentBusiness!.id);
      const { data, error } = await query;

      if (error) throw error;

      // Calculate progress for each project
      const projectsWithProgress = await Promise.all(
        (data || []).map(async (project) => {
          const progress = await getProjectProgress(project.id);
          return { ...project, progress } as Project;
        })
      );

      setProjects(projectsWithProgress);
    } catch (error) {
      // Do NOT toast here — useProjects is consumed by pickers across
      // Sales / Invoices / Purchases / Expenses / Timesheets. A toast in
      // this shared hook surfaces as a cross-module error on pages that
      // never asked for project data. Pages that need a user-facing
      // error render it from their own boundary.
      console.error("Error fetching projects:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    if (!enabled) return;
    fetchProjects();
  }, [fetchProjects, enabled]);

  const getProjectProgress = async (projectId: string): Promise<number> => {
    const { data, error } = await supabase.rpc("calculate_project_progress", {
      p_project_id: projectId,
    });

    if (error) {
      console.error("Error calculating project progress:", error);
      return 0;
    }

    return data || 0;
  };

  const getNextProjectNumber = async (): Promise<string> => {
    if (!currentOrg) return "PROJ-0001";

    const { data, error } = await supabase.rpc("get_next_project_number", {
      p_org_id: currentOrg.id,
    });

    if (error) {
      console.error("Error getting project number:", error);
      return `PROJ-${Date.now()}`;
    }

    return data || "PROJ-0001";
  };

  /**
   * Wave 1 — server authority.
   * All project writes go through SECURITY DEFINER command RPCs that assert
   * organisation membership, module permission, branch access and project-level
   * authority. The browser MUST NOT write `projects` / `project_members`
   * directly; see src/__tests__/architecture.projects-server-authority.test.ts.
   */
  const createProject = async (
    project: Partial<Omit<Project, "id" | "organization_id" | "project_number" | "created_at" | "updated_at" | "customer" | "manager" | "task_count" | "completed_tasks" | "progress">> & { name: string }
  ) => {
    if (!currentOrg || !user) throw new Error("No organization selected");

    const payload = {
      organization_id: currentOrg.id,
      business_id: currentBusiness?.id ?? null,
      branch_id: project.branch_id ?? null,
      name: project.name,
      description: project.description ?? null,
      status: project.status ?? "active",
      project_type: project.project_type ?? "internal",
      start_date: project.start_date ?? null,
      end_date: project.end_date ?? null,
      color: project.color ?? null,
      allocated_hours: project.allocated_hours ?? null,
      priority: project.priority ?? null,
      budget: project.budget ?? null,
      budget_type: project.budget_type ?? null,
      // Rate resolution is owned by the database: project_create derives
      // default_billable_rate from hourly_rate. Do not mirror it here.
      hourly_rate: project.hourly_rate ?? null,
      is_billable: project.is_billable ?? false,
      allow_timesheets: project.allow_timesheets ?? true,
      privacy: project.privacy ?? "team",
      tags: project.tags ?? null,
      customer_id: project.customer_id ?? null,
      manager_id: project.manager_id ?? null,
      pricing_type: project.pricing_type ?? "non_billable",
      currency: project.currency ?? null,
      template_id: project.template_id ?? null,
      is_template: project.is_template ?? false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source_lead_id: (project as any).source_lead_id ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      source_sales_order_id: (project as any).source_sales_order_id ?? null,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)("project_create", {
      _payload: payload,
    });

    if (error) throw error;

    const created = (Array.isArray(data) ? data[0] : data) as Project;
    toast.success(`Project ${created.project_number} created successfully`);

    await fetchProjects();
    return created;
  };

  // Create a delivery project from a sales order, linking both directions.
  const createProjectFromSalesOrder = async (salesOrder: {
    id: string;
    so_number?: string | null;
    contact_id?: string | null;
    currency?: string | null;
    project_id?: string | null;
    notes?: string | null;
  }) => {
    if (!currentOrg || !user) throw new Error("No organization selected");
    if (salesOrder.project_id) {
      throw new Error("This sales order already has a linked project");
    }

    const project = await createProject({
      name: salesOrder.so_number ? `Project for ${salesOrder.so_number}` : "New Project",
      customer_id: salesOrder.contact_id || null,
      currency: salesOrder.currency || undefined,
      description: salesOrder.notes || null,
      is_billable: true,
      pricing_type: "project_rate",
      source_sales_order_id: salesOrder.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Close the reverse link so the SO points at the new project.
    const { error: linkError } = await supabase
      .from("sales_orders")
      .update({ project_id: project.id })
      .eq("id", salesOrder.id);

    if (linkError) {
      console.error("Failed to link sales order to project:", linkError);
      toast.error("Project created but could not be linked back to the sales order");
    } else {
      toast.success("Project created and linked to sales order");
    }

    return project;
  };

  /** Lifecycle transition — governed by project_change_status on the server. */
  const changeProjectStatus = async (id: string, status: Project["status"]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.rpc as any)("project_change_status", {
      _project_id: id,
      _status: status,
    });

    if (error) throw error;
    toast.success("Project status updated");
    await fetchProjects();
  };

  const updateProject = async (id: string, updates: Partial<Project>) => {
    // Strip joined/computed/derived fields — the server owns everything else.
    const {
      completed_tasks,
      customer,
      manager,
      progress,
      task_count,
      status,
      id: _ignoredId,
      organization_id,
      business_id,
      project_number,
      created_at,
      updated_at,
      created_by,
      spent_hours,
      analytic_account_id,
      is_active,
      last_update_status,
      last_update_at,
      actual_start_date,
      actual_end_date,
      default_billable_rate,
      ...patch
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } = updates as any;

    if (Object.keys(patch).length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.rpc as any)("project_update_config", {
        _project_id: id,
        _patch: patch,
      });
      if (error) throw error;
    }

    if (status) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.rpc as any)("project_change_status", {
        _project_id: id,
        _status: status,
      });
      if (error) throw error;
    }

    toast.success("Project updated successfully");
    await fetchProjects();
  };

  const deleteProject = async (id: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.rpc as any)("project_archive", {
      _project_id: id,
    });

    if (error) throw error;

    toast.success("Project archived successfully");
    await fetchProjects();
  };

  // Team management — governed server-side (admins and the project manager only).
  const addProjectMember = async (
    projectId: string,
    userId: string,
    role: "member" | "manager" | "viewer" = "member",
    billableRate?: number | null
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.rpc as any)("project_add_member", {
      _project_id: projectId,
      _user_id: userId,
      _role: role,
      _billable_rate: billableRate ?? null,
    });

    if (error) throw error;
    toast.success("Team member added");
  };

  const removeProjectMember = async (projectId: string, userId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.rpc as any)("project_remove_member", {
      _project_id: projectId,
      _user_id: userId,
    });

    if (error) throw error;
    toast.success("Team member removed");
  };


  // Stage management
  const getProjectStages = async (projectId: string): Promise<ProjectStage[]> => {
    const { data, error } = await supabase
      .from("project_stages")
      .select("*")
      .eq("project_id", projectId)
      .order("sequence");

    if (error) {
      console.error("Error fetching project stages:", error);
      return [];
    }

    return (data || []) as ProjectStage[];
  };

  const createStage = async (projectId: string, name: string, sequence: number) => {
    const { error } = await supabase.from("project_stages").insert({
      project_id: projectId,
      name,
      sequence,
    });

    if (error) throw error;
    toast.success("Stage created successfully");
  };

  const updateStage = async (stageId: string, updates: Partial<ProjectStage>) => {
    const { error } = await supabase
      .from("project_stages")
      .update(updates)
      .eq("id", stageId);

    if (error) throw error;
  };

  const deleteStage = async (stageId: string) => {
    const { error } = await supabase.from("project_stages").delete().eq("id", stageId);

    if (error) throw error;
    toast.success("Stage deleted successfully");
  };

  // Milestone management
  const getProjectMilestones = async (projectId: string): Promise<ProjectMilestone[]> => {
    const { data, error } = await supabase
      .from("project_milestones")
      .select("*")
      .eq("project_id", projectId)
      .order("sequence");

    if (error) {
      console.error("Error fetching project milestones:", error);
      return [];
    }

    return (data || []) as ProjectMilestone[];
  };

  const createMilestone = async (
    projectId: string,
    milestone: Omit<ProjectMilestone, "id" | "project_id" | "created_at" | "updated_at">
  ) => {
    const { error } = await supabase.from("project_milestones").insert({
      project_id: projectId,
      ...milestone,
    });

    if (error) throw error;
    toast.success("Milestone created successfully");
  };

  const updateMilestone = async (milestoneId: string, updates: Partial<ProjectMilestone>) => {
    const { error } = await supabase
      .from("project_milestones")
      .update(updates)
      .eq("id", milestoneId);

    if (error) throw error;
    toast.success("Milestone updated successfully");
  };

  const completeMilestone = async (milestoneId: string) => {
    const { error } = await supabase
      .from("project_milestones")
      .update({
        is_reached: true,
        reached_at: new Date().toISOString(),
      })
      .eq("id", milestoneId);

    if (error) throw error;
    toast.success("Milestone completed!");
  };

  return {
    projects,
    activeProjects: projects.filter((p) => p.status === "active"),
    isLoading,
    getProjectProgress,
    getNextProjectNumber,
    createProject,
    createProjectFromSalesOrder,
    updateProject,
    changeProjectStatus,
    addProjectMember,
    removeProjectMember,
    deleteProject,
    getProjectStages,
    createStage,
    updateStage,
    deleteStage,
    getProjectMilestones,
    createMilestone,
    updateMilestone,
    completeMilestone,
    refreshProjects: fetchProjects,
  };
}
