/**
 * Waitlist Panel Component
 * 
 * Displays the current waitlist with add/manage functionality.
 */

import { useState } from "react";
import { useWaitlist, WaitlistEntry } from "@/hooks/pos/useWaitlist";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, Users, Clock, Phone, MoreVertical, Bell, Check, X, UserX } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface WaitlistPanelProps {
  branchId?: string;
  onSeatCustomer?: (entry: WaitlistEntry, tableId?: string) => void;
}

export function WaitlistPanel({ branchId, onSeatCustomer }: WaitlistPanelProps) {
  const {
    waitlist,
    isLoading,
    addToWaitlist,
    notifyCustomer,
    seatCustomer,
    markNoShow,
    cancelEntry,
    getActualWaitTime,
    getStats,
  } = useWaitlist(branchId);
  
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newEntry, setNewEntry] = useState({
    customer_name: "",
    phone: "",
    party_size: 2,
    notes: "",
    seating_preference: "",
  });
  
  const stats = getStats();

  const handleAddToWaitlist = async () => {
    if (!newEntry.customer_name.trim()) return;
    
    await addToWaitlist.mutateAsync({
      customer_name: newEntry.customer_name,
      phone: newEntry.phone || undefined,
      party_size: newEntry.party_size,
      notes: newEntry.notes || undefined,
      seating_preference: newEntry.seating_preference || undefined,
      branch_id: branchId,
    });
    
    setNewEntry({
      customer_name: "",
      phone: "",
      party_size: 2,
      notes: "",
      seating_preference: "",
    });
    setIsAddDialogOpen(false);
  };

  const handleSeat = (entry: WaitlistEntry) => {
    if (onSeatCustomer) {
      onSeatCustomer(entry);
    } else {
      seatCustomer.mutate({ entryId: entry.id });
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "waiting":
        return "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400";
      case "notified":
        return "bg-blue-500/20 text-blue-700 dark:text-blue-400";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5" />
            Waitlist
          </CardTitle>
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus className="h-4 w-4 mr-1" />
                Add
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add to Waitlist</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Name *</Label>
                  <Input
                    value={newEntry.customer_name}
                    onChange={(e) => setNewEntry({ ...newEntry, customer_name: e.target.value })}
                    placeholder="Customer name"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Party Size</Label>
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={newEntry.party_size}
                      onChange={(e) => setNewEntry({ ...newEntry, party_size: parseInt(e.target.value) || 2 })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Phone</Label>
                    <Input
                      value={newEntry.phone}
                      onChange={(e) => setNewEntry({ ...newEntry, phone: e.target.value })}
                      placeholder="Phone number"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Seating Preference</Label>
                  <Input
                    value={newEntry.seating_preference}
                    onChange={(e) => setNewEntry({ ...newEntry, seating_preference: e.target.value })}
                    placeholder="e.g., Booth, Patio, Near window"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Notes</Label>
                  <Input
                    value={newEntry.notes}
                    onChange={(e) => setNewEntry({ ...newEntry, notes: e.target.value })}
                    placeholder="Special requests or notes"
                  />
                </div>
                <Button
                  className="w-full"
                  onClick={handleAddToWaitlist}
                  disabled={!newEntry.customer_name.trim() || addToWaitlist.isPending}
                >
                  Add to Waitlist
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
        
        {/* Stats */}
        <div className="flex gap-4 text-sm text-muted-foreground mt-2">
          <span className="flex items-center gap-1">
            <Users className="h-3 w-3" />
            {stats.totalParties} parties
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            ~{stats.averageWaitMinutes}m avg
          </span>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-2 overflow-auto max-h-[500px]">
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : waitlist.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No one on waitlist</p>
          </div>
        ) : (
          waitlist.map((entry, index) => (
            <div
              key={entry.id}
              className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-sm font-medium">
                  {index + 1}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{entry.customer_name}</span>
                    <Badge variant="outline" className="text-xs">
                      <Users className="h-3 w-3 mr-1" />
                      {entry.party_size}
                    </Badge>
                    <Badge className={getStatusColor(entry.status)}>
                      {entry.status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {getActualWaitTime(entry)}m waiting
                    </span>
                    {entry.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" />
                        {entry.phone}
                      </span>
                    )}
                    {entry.seating_preference && (
                      <span className="text-primary">{entry.seating_preference}</span>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="flex items-center gap-1">
                {entry.status === "waiting" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => notifyCustomer.mutate(entry.id)}
                    disabled={notifyCustomer.isPending}
                  >
                    <Bell className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => handleSeat(entry)}
                >
                  <Check className="h-4 w-4 mr-1" />
                  Seat
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => markNoShow.mutate(entry.id)}>
                      <UserX className="h-4 w-4 mr-2" />
                      No Show
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => cancelEntry.mutate(entry.id)}
                      className="text-destructive"
                    >
                      <X className="h-4 w-4 mr-2" />
                      Cancel
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
