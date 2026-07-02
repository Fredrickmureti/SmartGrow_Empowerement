/**
 * Phase 5 — verifies the silent mis-config alert that fires when the
 * POS receipt paper_size differs from (or is missing on) the active
 * register's bound `printer_profiles.paper_size`. See
 * src/components/pos/PrinterProfilePaperMismatchAlert.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let profilePaper: "40mm" | "58mm" | "80mm" | null = "80mm";
const updateSpy = vi.fn((_patch: { paper_size: "40mm" | "58mm" | "80mm" | null }) => undefined);

vi.mock("@/integrations/supabase/client", () => {
  return {
    supabase: {
      from: (table: string) => {
        if (table !== "printer_profiles") throw new Error(`Unexpected table ${table}`);
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { paper_size: profilePaper, label: "Front Counter" },
                error: null,
              }),
            }),
          }),
          update: (patch: { paper_size: typeof profilePaper }) => {
            updateSpy(patch);
            profilePaper = patch.paper_size;
            return {
              eq: async () => ({ error: null }),
            };
          },
        };
      },
    },
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { PrinterProfilePaperMismatchAlert } from "@/components/pos/PrinterProfilePaperMismatchAlert";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("PrinterProfilePaperMismatchAlert", () => {
  beforeEach(() => {
    profilePaper = "80mm";
    updateSpy.mockClear();
  });

  it("renders nothing when no profile is bound", () => {
    const { container } = wrap(
      <PrinterProfilePaperMismatchAlert profileId={null} selectedPaper="58mm" />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders nothing when paper sizes match", async () => {
    profilePaper = "58mm";
    const { container } = wrap(
      <PrinterProfilePaperMismatchAlert profileId="prof-1" selectedPaper="58mm" />,
    );
    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
  });

  it("renders destructive mismatch alert when widths differ", async () => {
    profilePaper = "80mm";
    wrap(
      <PrinterProfilePaperMismatchAlert profileId="prof-1" selectedPaper="58mm" />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Printer profile mismatch/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/configured for/i).textContent).toMatch(/80mm/);
    expect(screen.getByRole("button", { name: /Update profile to 58mm/i })).toBeInTheDocument();
  });

  it("renders unset alert when profile.paper_size is null", async () => {
    profilePaper = null;
    wrap(
      <PrinterProfilePaperMismatchAlert profileId="prof-1" selectedPaper="58mm" />,
    );
    await waitFor(() => {
      expect(screen.getByText(/no paper width set/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Bind profile to 58mm/i })).toBeInTheDocument();
  });

  it("clicking the action writes the selected paper to printer_profiles", async () => {
    profilePaper = "80mm";
    wrap(
      <PrinterProfilePaperMismatchAlert profileId="prof-1" selectedPaper="58mm" />,
    );
    const btn = await screen.findByRole("button", { name: /Update profile to 58mm/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith({ paper_size: "58mm" });
    });
  });

  it("does not query when the selected paper is non-thermal (A4)", () => {
    const { container } = wrap(
      <PrinterProfilePaperMismatchAlert profileId="prof-1" selectedPaper="A4" />,
    );
    expect(container.textContent).toBe("");
  });
});
