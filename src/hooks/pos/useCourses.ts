import { normalizeError } from "@/services/resilience";
/**
 * Course Management Hook
 * 
 * Manages multi-course dining for restaurant mode.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

export interface POSCourse {
  id: string;
  organization_id: string;
  transaction_id: string;
  course_number: number;
  name: string;
  status: "pending" | "fired" | "in_progress" | "ready" | "served";
  fired_at: string | null;
  ready_at: string | null;
  served_at: string | null;
  created_at: string;
  // Joined items
  items?: CourseItem[];
}

export interface CourseItem {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  notes: string | null;
}

export interface CreateCourseInput {
  transaction_id: string;
  course_number?: number;
  name?: string;
}

export function useCourses(transactionId?: string) {
  const { currentOrg } = useSession();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // Fetch courses for a transaction
  const coursesQuery = useQuery({
    queryKey: ["pos-courses", transactionId, orgId, businessId],
    queryFn: async () => {
      if (!transactionId || !orgId || !businessId) return [];
      
      const { data, error } = await supabase
        .from("pos_courses")
        .select("*")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .eq("transaction_id", transactionId)
        .order("course_number", { ascending: true });
      
      if (error) throw error;
      return data as POSCourse[];
    },
    enabled: !!transactionId && !!orgId && !!businessId,
  });

  // Create course
  const createCourse = useMutation({
    mutationFn: async (input: CreateCourseInput) => {
      if (!orgId) throw new Error("No organization selected");
      if (!businessId) throw new Error("No company selected");
      
      // Get next course number if not specified
      let courseNumber = input.course_number;
      if (!courseNumber) {
        const { data: existingCourses } = await supabase
          .from("pos_courses")
          .select("course_number")
          .eq("organization_id", orgId)
          .eq("business_id", businessId)
          .eq("transaction_id", input.transaction_id)
          .order("course_number", { ascending: false })
          .limit(1);
        
        courseNumber = existingCourses && existingCourses.length > 0
          ? existingCourses[0].course_number + 1
          : 1;
      }
      
      const { data, error } = await supabase
        .from("pos_courses")
        .insert({
          organization_id: orgId,
          business_id: businessId,
          transaction_id: input.transaction_id,
          course_number: courseNumber,
          name: input.name || `Course ${courseNumber}`,
          status: "pending",
        })
        .select()
        .single();
      
      if (error) throw error;
      return data as POSCourse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-courses", transactionId] });
      toast.success("Course added");
    },
    onError: (error) => {
      toast.error("Failed to create course: " + normalizeError(error).message);
    },
  });

  // Fire course to kitchen
  const fireCourse = useMutation({
    mutationFn: async (courseId: string) => {
      if (!orgId) throw new Error("No organization selected");
      if (!businessId) throw new Error("No company selected");
      
      const { data, error } = await supabase
        .from("pos_courses")
        .update({
          status: "fired",
          fired_at: new Date().toISOString(),
        })
        .eq("id", courseId)
        .select("*, transaction:pos_transactions(id, transaction_number, table_session_id)")
        .single();
      
      if (error) throw error;

      // Auto-create kitchen orders for items assigned to this course
      const { data: courseItems } = await supabase
        .from("pos_kitchen_orders")
        .select("id")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .eq("course_id", courseId);

      // Only create kitchen orders if none exist yet for this course
      if (!courseItems || courseItems.length === 0) {
        const { data: txnItems } = await supabase
          .from("pos_transaction_items")
          .select("id, description, quantity, product_id")
          .eq("transaction_id", data.transaction_id);

        if (txnItems && txnItems.length > 0) {
          // Get table number from transaction's table session
          let tableNumber: string | null = null;
          if (data.transaction?.table_session_id) {
            const { data: session } = await supabase
              .from("pos_table_sessions")
              .select("table:pos_tables(table_number)")
              .eq("organization_id", orgId)
              .eq("business_id", businessId)
              .eq("id", data.transaction.table_session_id)
              .single();
            tableNumber = (session?.table as any)?.table_number || null;
          }

          const kitchenOrders = txnItems.map((item) => ({
            organization_id: orgId,
            business_id: businessId,
            transaction_id: data.transaction_id,
            transaction_item_id: item.id,
            course_id: courseId,
            printer_category: "kitchen" as const,
            table_number: tableNumber,
            notes: null,
            priority: 0,
            status: "new" as const,
          }));

          await supabase.from("pos_kitchen_orders").insert(kitchenOrders);
        }
      }
      
      return data as POSCourse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-courses", transactionId] });
      queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders"] });
      toast.success("Course sent to kitchen");
    },
    onError: (error) => {
      toast.error("Failed to fire course: " + normalizeError(error).message);
    },
  });

  // Mark course as ready
  const markCourseReady = useMutation({
    mutationFn: async (courseId: string) => {
      const { data, error } = await supabase
        .from("pos_courses")
        .update({
          status: "ready",
          ready_at: new Date().toISOString(),
        })
        .eq("id", courseId)
        .select()
        .single();
      
      if (error) throw error;
      return data as POSCourse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-courses", transactionId] });
      toast.success("Course marked as ready");
    },
  });

  // Mark course as served
  const markCourseServed = useMutation({
    mutationFn: async (courseId: string) => {
      const { data, error } = await supabase
        .from("pos_courses")
        .update({
          status: "served",
          served_at: new Date().toISOString(),
        })
        .eq("id", courseId)
        .select()
        .single();
      
      if (error) throw error;
      return data as POSCourse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-courses", transactionId] });
      toast.success("Course served");
    },
  });

  // Delete course
  const deleteCourse = useMutation({
    mutationFn: async (courseId: string) => {
      const { error } = await supabase
        .from("pos_courses")
        .delete()
        .eq("id", courseId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-courses", transactionId] });
      toast.success("Course removed");
    },
    onError: (error) => {
      toast.error("Failed to remove course: " + normalizeError(error).message);
    },
  });

  // Rename course
  const renameCourse = useMutation({
    mutationFn: async ({ courseId, name }: { courseId: string; name: string }) => {
      const { data, error } = await supabase
        .from("pos_courses")
        .update({ name })
        .eq("id", courseId)
        .select()
        .single();
      
      if (error) throw error;
      return data as POSCourse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-courses", transactionId] });
    },
  });

  // Get course presets (common course names)
  const coursePresets = [
    { name: "Appetizer", icon: "🥗" },
    { name: "Soup", icon: "🍜" },
    { name: "Salad", icon: "🥬" },
    { name: "Main Course", icon: "🍽️" },
    { name: "Dessert", icon: "🍰" },
    { name: "Drinks", icon: "🥤" },
    { name: "Coffee", icon: "☕" },
  ];

  return {
    courses: coursesQuery.data || [],
    isLoading: coursesQuery.isLoading,
    createCourse,
    fireCourse,
    markCourseReady,
    markCourseServed,
    deleteCourse,
    renameCourse,
    coursePresets,
  };
}
