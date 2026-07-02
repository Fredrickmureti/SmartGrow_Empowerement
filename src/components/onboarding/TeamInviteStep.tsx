/**
 * Team Invite Step Component
 * 
 * Allows users to invite team members during signup.
 * Collects email, name, and role for each invitee.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  ArrowLeft, 
  ArrowRight, 
  Loader2, 
  Users, 
  Plus, 
  X, 
  Mail,
  User,
  Shield
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface TeamInvitee {
  email: string;
  name: string;
  role: string;
}

const AVAILABLE_ROLES = [
  { value: "admin", label: "Admin", description: "Full access to all features" },
  { value: "internal", label: "Internal User", description: "Access via Access Groups" },
];

interface TeamInviteStepProps {
  invitees: TeamInvitee[];
  onInviteesChange: (invitees: TeamInvitee[]) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  isLoading?: boolean;
}

export function TeamInviteStep({
  invitees,
  onInviteesChange,
  onBack,
  onNext,
  onSkip,
  isLoading = false,
}: TeamInviteStepProps) {
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("internal");
  const [emailError, setEmailError] = useState("");

  const validateEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const addInvitee = () => {
    if (!newEmail.trim()) {
      setEmailError("Email is required");
      return;
    }

    if (!validateEmail(newEmail)) {
      setEmailError("Please enter a valid email");
      return;
    }

    if (invitees.some(inv => inv.email.toLowerCase() === newEmail.toLowerCase())) {
      setEmailError("This email has already been added");
      return;
    }

    onInviteesChange([
      ...invitees,
      {
        email: newEmail.trim().toLowerCase(),
        name: newName.trim() || "",
        role: newRole,
      },
    ]);

    // Reset form
    setNewEmail("");
    setNewName("");
    setNewRole("internal");
    setEmailError("");
  };

  const removeInvitee = (index: number) => {
    onInviteesChange(invitees.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addInvitee();
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
          <Users className="w-6 h-6 text-primary" />
        </div>
        <h3 className="font-semibold text-lg">Invite your team</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Add team members now or skip and invite them later from Settings.
        </p>
      </div>

      {/* Add Invitee Form */}
      <div className="space-y-4 p-4 rounded-lg border bg-muted/30">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="inviteEmail" className="text-xs flex items-center gap-1.5">
              <Mail className="h-3 w-3" />
              Email *
            </Label>
            <Input
              id="inviteEmail"
              type="email"
              placeholder="colleague@company.com"
              value={newEmail}
              onChange={(e) => {
                setNewEmail(e.target.value);
                setEmailError("");
              }}
              onKeyDown={handleKeyDown}
              className="h-10"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inviteName" className="text-xs flex items-center gap-1.5">
              <User className="h-3 w-3" />
              Name (optional)
            </Label>
            <Input
              id="inviteName"
              type="text"
              placeholder="John Doe"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-10"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1 space-y-2">
            <Label htmlFor="inviteRole" className="text-xs flex items-center gap-1.5">
              <Shield className="h-3 w-3" />
              Role
            </Label>
            <Select value={newRole} onValueChange={setNewRole}>
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AVAILABLE_ROLES.map((role) => (
                  <SelectItem key={role.value} value={role.value}>
                    <div className="flex flex-col">
                      <span>{role.label}</span>
                      <span className="text-xs text-muted-foreground">{role.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-10 px-4"
              onClick={addInvitee}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>
        </div>

        {emailError && (
          <p className="text-xs text-destructive">{emailError}</p>
        )}
      </div>

      {/* Invitees List */}
      {invitees.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">
            Team members to invite ({invitees.length})
          </Label>
          <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
            {invitees.map((invitee, index) => (
              <div
                key={index}
                className="flex items-center gap-3 p-3 rounded-lg border bg-background group"
              >
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="text-xs font-medium text-primary">
                    {invitee.name
                      ? invitee.name.charAt(0).toUpperCase()
                      : invitee.email.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {invitee.name || invitee.email}
                  </p>
                  {invitee.name && (
                    <p className="text-xs text-muted-foreground truncate">
                      {invitee.email}
                    </p>
                  )}
                </div>
                <span className="text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground capitalize">
                  {invitee.role}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => removeInvitee(index)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Info Text */}
      <p className="text-xs text-muted-foreground text-center">
        {invitees.length === 0
          ? "You can add team members now or do it later from the Team settings."
          : `${invitees.length} invitation${invitees.length > 1 ? "s" : ""} will be sent after your account is created.`}
      </p>

      {/* Navigation Buttons */}
      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          className="flex-1 h-11"
          onClick={onBack}
          disabled={isLoading}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        {invitees.length === 0 ? (
          <Button
            type="button"
            variant="secondary"
            className="flex-1 h-11"
            onClick={onSkip}
            disabled={isLoading}
          >
            Skip for now
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            className="flex-1 h-11"
            onClick={onNext}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                Create account
                <ArrowRight className="ml-2 h-4 w-4" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
