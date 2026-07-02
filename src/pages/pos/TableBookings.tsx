/**
 * Table Bookings Page
 * 
 * Manages restaurant table reservations.
 */

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTableBookings } from "@/hooks/pos/useTableBookings";
import { useFloorPlan } from "@/hooks/pos/useFloorPlan";
import { format, isSameDay, parseISO } from "date-fns";
import { 
  Calendar as CalendarIcon, 
  Plus, 
  Clock, 
  Users,
  Phone,
  Mail,
  ArrowLeft,
  CheckCircle,
  XCircle,
  AlertCircle
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

export default function TableBookings() {
  const navigate = useNavigate();
  const { bookings, createBooking, updateBooking, isLoading } = useTableBookings();
  const { floors, useFloorTables } = useFloorPlan();
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newBooking, setNewBooking] = useState({
    customer_name: "",
    customer_phone: "",
    customer_email: "",
    party_size: 2,
    table_id: "",
    start_time: "18:00",
    end_time: "20:00",
    notes: "",
  });

  // Get first floor's tables for selection
  const firstFloor = floors.find(f => f.is_active);
  const { data: tables = [] } = useFloorTables(firstFloor?.id || null);

  const filteredBookings = bookings.filter(booking => 
    isSameDay(parseISO(booking.booking_date), selectedDate)
  );

  const handleCreateBooking = async () => {
    if (!newBooking.customer_name || !newBooking.table_id) {
      toast.error("Please fill in customer name and select a table");
      return;
    }

    try {
      await createBooking.mutateAsync({
        ...newBooking,
        booking_date: selectedDate,
      });
      setShowCreateDialog(false);
      setNewBooking({
        customer_name: "",
        customer_phone: "",
        customer_email: "",
        party_size: 2,
        table_id: "",
        start_time: "18:00",
        end_time: "20:00",
        notes: "",
      });
      toast.success("Booking created successfully");
    } catch (error) {
      // Error handled by mutation
    }
  };

  const handleStatusChange = async (bookingId: string, status: "confirmed" | "checked_in" | "seated" | "completed" | "no_show" | "cancelled") => {
    try {
      await updateBooking.mutateAsync({ id: bookingId, status });
      toast.success(`Booking marked as ${status}`);
    } catch (error) {
      // Error handled by mutation
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "confirmed":
        return <Badge className="bg-blue-500">Confirmed</Badge>;
      case "checked_in":
        return <Badge className="bg-green-500">Checked In</Badge>;
      case "no_show":
        return <Badge variant="destructive">No Show</Badge>;
      case "cancelled":
        return <Badge variant="secondary">Cancelled</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/pos")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">Table Bookings</h1>
              <p className="text-sm sm:text-base text-muted-foreground">
                Manage restaurant reservations
              </p>
            </div>
          </div>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Booking
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          {/* Calendar Sidebar */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Select Date</CardTitle>
            </CardHeader>
            <CardContent className="px-2 pb-3 flex justify-center">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={(date) => date && setSelectedDate(date)}
                className="p-0 pointer-events-auto"
              />
            </CardContent>
          </Card>


          {/* Bookings List */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarIcon className="h-5 w-5" />
                {format(selectedDate, "EEEE, MMMM d, yyyy")}
              </CardTitle>
              <CardDescription>
                {filteredBookings.length} booking{filteredBookings.length !== 1 ? "s" : ""} for this day
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : filteredBookings.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <CalendarIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No bookings for this date</p>
                  <Button 
                    variant="link" 
                    className="mt-2"
                    onClick={() => setShowCreateDialog(true)}
                  >
                    Create a booking
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredBookings.map((booking) => (
                    <Card key={booking.id} className="overflow-hidden">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1 min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold truncate">
                                {booking.customer_name}
                              </span>
                              {getStatusBadge(booking.status)}
                            </div>
                            <div className="flex items-center gap-4 text-sm text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Clock className="h-3.5 w-3.5" />
                                {booking.start_time} - {booking.end_time}
                              </span>
                              <span className="flex items-center gap-1">
                                <Users className="h-3.5 w-3.5" />
                                {booking.party_size} guests
                              </span>
                            </div>
                            {booking.customer_phone && (
                              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                                <Phone className="h-3.5 w-3.5" />
                                {booking.customer_phone}
                              </div>
                            )}
                            {booking.notes && (
                              <p className="text-sm text-muted-foreground mt-2 italic">
                                "{booking.notes}"
                              </p>
                            )}
                          </div>
                          
                          {booking.status === "confirmed" && (
                            <div className="flex gap-2">
                              <Button 
                                size="sm" 
                                variant="outline"
                                onClick={() => handleStatusChange(booking.id, "checked_in")}
                              >
                                <CheckCircle className="h-4 w-4 mr-1" />
                                Check In
                              </Button>
                              <Button 
                                size="sm" 
                                variant="ghost"
                                className="text-destructive"
                                onClick={() => handleStatusChange(booking.id, "no_show")}
                              >
                                <XCircle className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

      {/* Create Booking Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>New Booking</DialogTitle>
            <DialogDescription>
              Create a new table reservation for {format(selectedDate, "MMMM d, yyyy")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label>Customer Name *</Label>
              <Input
                placeholder="John Smith"
                value={newBooking.customer_name}
                onChange={(e) => setNewBooking(prev => ({ ...prev, customer_name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  placeholder="+1 234 567 8900"
                  value={newBooking.customer_phone}
                  onChange={(e) => setNewBooking(prev => ({ ...prev, customer_phone: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Party Size</Label>
                <Input
                  type="number"
                  min={1}
                  value={newBooking.party_size}
                  onChange={(e) => setNewBooking(prev => ({ ...prev, party_size: parseInt(e.target.value) || 1 }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Table *</Label>
              <Select
                value={newBooking.table_id}
                onValueChange={(v) => setNewBooking(prev => ({ ...prev, table_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a table" />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((table) => (
                    <SelectItem key={table.id} value={table.id}>
                      Table {table.table_number} ({table.seats} seats)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Start Time</Label>
                <Input
                  type="time"
                  value={newBooking.start_time}
                  onChange={(e) => setNewBooking(prev => ({ ...prev, start_time: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>End Time</Label>
                <Input
                  type="time"
                  value={newBooking.end_time}
                  onChange={(e) => setNewBooking(prev => ({ ...prev, end_time: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                placeholder="Special requests, allergies, etc."
                value={newBooking.notes}
                onChange={(e) => setNewBooking(prev => ({ ...prev, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateBooking} disabled={createBooking.isPending}>
              Create Booking
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
